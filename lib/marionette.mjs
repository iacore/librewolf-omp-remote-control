// Minimal Marionette client (protocol 3) for the LibreWolf that started with
// `--marionette` (default port 2828, unauthenticated, localhost only).
//
// Why it exists next to the BiDi client: switching the context to chrome and
// running with the system principal reaches everything BiDi cannot — browser
// internals, prefs, windows, the profile, the filesystem as the browser sees it.

import net from "node:net";

export const DEFAULT_MARIONETTE_PORT = 2828;

export class Marionette {
  #sock;
  #buf = Buffer.alloc(0);
  #id = 1;
  #pending = new Map();
  #serverHandshake = null;
  context = "content";

  static async connect(port = DEFAULT_MARIONETTE_PORT, { timeoutMs = 8000 } = {}) {
    const m = new Marionette();
    await m.#open(port, timeoutMs);
    return m;
  }

  #open(port, timeoutMs) {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: "127.0.0.1", port });
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error(`no Marionette banner from 127.0.0.1:${port}`));
      }, timeoutMs);
      sock.on("error", (e) => {
        clearTimeout(timer);
        reject(new Error(`cannot reach Marionette on 127.0.0.1:${port}: ${e.message}`));
      });
      sock.on("connect", () => {
        this.#sock = sock;
        sock.write(pack({ applicationType: "gecko", marionetteProtocol: 3 }));
      });
      sock.on("data", (chunk) => {
        this.#buf = Buffer.concat([this.#buf, chunk]);
        if (!this.#serverHandshake) {
          const first = unpack(this.#buf);
          if (!first) return;
          this.#buf = this.#buf.subarray(first.consumed);
          this.#serverHandshake = first.value;
          clearTimeout(timer);
          resolve();
          return;
        }
        for (;;) {
          const pkt = unpack(this.#buf);
          if (!pkt) break;
          this.#buf = this.#buf.subarray(pkt.consumed);
          this.#onMessage(pkt.value);
        }
      });
    });
  }

  #onMessage(msg) {
    if (!Array.isArray(msg)) return;
    const [kind, id, error, result] = msg;
    if (kind !== 1 || !this.#pending.has(id)) return;
    const { resolve, reject } = this.#pending.get(id);
    this.#pending.delete(id);
    if (error) reject(new Error(`${error.error}: ${error.message}\n${error.stacktrace ?? ""}`));
    else resolve(result);
  }

  command(name, params = {}, { timeoutMs = 20000 } = {}) {
    const id = this.#id++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`marionette command timed out: ${name}`));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.#sock.write(pack([0, id, name, params]));
    });
  }

  async newSession(capabilities = {}) {
    this.sessionId = null;
    const res = await this.command("WebDriver:NewSession", { capabilities });
    this.sessionId = res?.sessionId ?? null;
    return res;
  }

  /** Marionette refuses a second client while a session is registered, and the
   *  driver holds exactly one (`if (this.currentSession) throw …`). The command
   *  is sessionless, so it also clears a session some earlier client leaked. */
  async deleteSession() {
    try {
      await this.command("WebDriver:DeleteSession", {});
    } catch {}
    this.sessionId = null;
  }

  async setContext(value) {
    const res = await this.command("Marionette:SetContext", { value });
    this.context = value;
    return res;
  }

  async getContext() {
    return this.command("Marionette:GetContext");
  }

  /**
   * Run JS. In the chrome context with sandbox "system" this is the browser's
   * own privileged JS — `Services`, `ChromeUtils`, everything.
   */
  async executeScript(script, args = [], { sandbox = null } = {}) {
    const params = { script, args: args, newSandbox: sandbox === null };
    if (sandbox) params.sandbox = sandbox;
    return this.command("WebDriver:ExecuteScript", params);
  }

  /** Privileged one-liner in the chrome/system context. */
  async chrome(expression) {
    await this.setContext("chrome");
    const res = await this.executeScript(
      `const Services = globalThis.Services; return (${expression});`,
      [],
      { sandbox: "system" },
    );
    return res?.value;
  }

  close() {
    try {
      this.#sock?.end();
    } catch {}
  }
}

function pack(value) {
  const body = JSON.stringify(value);
  return `${Buffer.byteLength(body)}:${body}`;
}

/** Parse one length-prefixed packet from a Buffer; null when incomplete. */
function unpack(buf) {
  const colon = buf.indexOf(0x3a); // ':'
  if (colon <= 0) return null;
  const len = Number(buf.subarray(0, colon).toString("utf8"));
  if (!Number.isFinite(len)) return null;
  const start = colon + 1;
  const end = start + len;
  if (buf.length < end) return null;
  return { value: JSON.parse(buf.subarray(start, end).toString("utf8")), consumed: end };
}