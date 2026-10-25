// Minimal WebDriver BiDi client for the LibreWolf Remote Agent.
//
// The Remote Agent serves one WebSocket endpoint; `--remote-debugging-port=9223`
// puts it at ws://127.0.0.1:9223/session (plain GETs to /json/* are 404 on this
// build). Everything page-shaped goes through here: browsingContext.* for tabs,
// script.* to run JS, input.* for events, storage.* for cookies.

export const DEFAULT_BIDI_PORT = 9223;

export class Bidi {
  #ws;
  #nextId = 1;
  #pending = new Map();
  #listeners = new Map();
  sessionId = null;

  static async connect(port = DEFAULT_BIDI_PORT, { timeoutMs = 10000 } = {}) {
    const bidi = new Bidi();
    await bidi.#open(port, timeoutMs);
    return bidi;
  }

  #open(port, timeoutMs) {
    return new Promise((resolve, reject) => {
      const url = `ws://127.0.0.1:${port}/session`;
      const ws = new WebSocket(url);
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {}
        reject(new Error(`no BiDi endpoint answered at ${url}`));
      }, timeoutMs);
      ws.onopen = () => {
        clearTimeout(timer);
        this.#ws = ws;
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error(`cannot connect to ${url} — is LibreWolf running with --remote-debugging-port=${port}?`));
      };
      ws.onmessage = (e) => this.#onMessage(e.data);
    });
  }

  #onMessage(data) {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg.id !== undefined && this.#pending.has(msg.id)) {
      const { resolve, reject } = this.#pending.get(msg.id);
      this.#pending.delete(msg.id);
      if (msg.type === "error") reject(new Error(`${msg.error}: ${msg.message}`));
      else resolve(msg.result);
      return;
    }
    if (msg.type === "event") {
      for (const fn of this.#listeners.get(msg.method) ?? []) fn(msg.params, msg.method);
      for (const fn of this.#listeners.get("*") ?? []) fn(msg.params, msg.method);
    }
  }

  send(method, params = {}) {
    if (!this.#ws) throw new Error("Bidi.send before connect()");
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, fn) {
    if (!this.#listeners.has(method)) this.#listeners.set(method, []);
    this.#listeners.get(method).push(fn);
  }

  async startSession(capabilities = {}) {
    const res = await this.send("session.new", { capabilities });
    this.sessionId = res.sessionId;
    return res;
  }

  /** Firefox keeps a session until it is ended explicitly; a leaked one blocks
   *  the next client with "Maximum number of active sessions". */
  async endSession() {
    if (!this.sessionId) return;
    try {
      await this.send("session.end", {});
    } catch {}
    this.sessionId = null;
  }

  async listTabs() {
    const tree = await this.send("browsingContext.getTree", {});
    const out = [];
    const walk = (ctx, depth) => {
      out.push({
        id: ctx.context,
        url: ctx.url,
        userContext: ctx.userContext,
        parent: ctx.parent ?? null,
        depth,
      });
      for (const c of ctx.children ?? []) walk(c, depth + 1);
    };
    for (const c of tree.contexts ?? []) walk(c, 0);
    return out;
  }

  /** First top-level tab, or the one matching `id`. */
  async resolveTab(id) {
    const tabs = await this.listTabs();
    const top = tabs.filter((t) => t.parent === null);
    if (id) {
      const hit = tabs.find((t) => t.id === id);
      if (!hit) throw new Error(`no browsing context ${id}`);
      return hit;
    }
    if (top.length === 0) throw new Error("no open tab");
    return top[0];
  }

  async createTab(url, { background = true } = {}) {
    const res = await this.send("browsingContext.create", { type: "tab", background });
    if (url) {
      await this.send("browsingContext.navigate", { context: res.context, url, wait: "complete" });
    }
    return res.context;
  }

  async navigate(id, url, wait = "complete") {
    return this.send("browsingContext.navigate", { context: id, url, wait });
  }

  async evaluate(id, expression, { awaitPromise = true } = {}) {
    const res = await this.send("script.evaluate", {
      expression,
      target: { context: id },
      awaitPromise,
      resultOwnership: "root",
    });
    if (res.type === "exception") {
      throw new Error(res.exceptionDetails?.text ?? "evaluation failed");
    }
    return res.result;
  }

  /** JSON-ified value of a `script.evaluate` result. */
  static value(result) {
    if (result == null) return null;
    if ("value" in result) return result.value;
    return result;
  }

  async screenshot(id, { asBase64 = true } = {}) {
    const res = await this.send("browsingContext.captureScreenshot", { context: id });
    return asBase64 ? res.data : Buffer.from(res.data, "base64");
  }

  async closeTab(id) {
    return this.send("browsingContext.close", { context: id });
  }

  async cookies() {
    const res = await this.send("storage.getCookies", {});
    return res.cookies ?? [];
  }

  close() {
    try {
      this.#ws?.close();
    } catch {}
  }
}

/**
 * Resolve a tab selector against a `listTabs()` result: an exact context id, a
 * top-level index, or a substring of the url. Ids are minted per session, so an
 * id printed by an earlier run usually resolves only as index or url.
 */
export function matchTab(tabs, sel) {
  if (sel === undefined || sel === null || sel === "") {
    throw new Error("pick a tab: an index, a context id, or a url substring");
  }
  const want = String(sel);
  const byId = tabs.find((t) => t.id === want);
  if (byId) return byId;
  const top = tabs.filter((t) => t.parent === null);
  if (/^\d+$/.test(want) && top[Number(want)]) return top[Number(want)];
  const byUrl = tabs.filter((t) => (t.url ?? "").includes(want));
  if (byUrl.length === 1) return byUrl[0];
  if (byUrl.length > 1) {
    throw new Error(`${byUrl.length} tabs match "${want}":\n  ${byUrl.map((t) => t.url).join("\n  ")}`);
  }
  throw new Error(`no tab matches "${want}"`);
}

/**
 * Open a session, run `fn`, end the session. Ending matters: the browser holds
 * exactly one session and a leaked one answers every later client
 * "Maximum number of active sessions".
 */
export async function withBidi(port, fn) {
  const bidi = await Bidi.connect(port);
  try {
    await bidi.startSession({});
    return await fn(bidi);
  } finally {
    await bidi.endSession();
    bidi.close();
  }
}