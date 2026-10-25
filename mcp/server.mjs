#!/usr/bin/env bun
// MCP stdio server exposing a running LibreWolf to an agent.
//
// Two halves:
//   librewolf_status / _open / _send   — D-Bus remote; work whenever the
//                                        browser runs, but only open things.
//   librewolf_tabs / _new / _nav / _eval / _shot / _close / _cookies
//                                      — WebDriver BiDi; need the browser to
//                                        have started with
//                                        --remote-debugging-port=<port>.
//   librewolf_chrome / _session_end    — Marionette; chrome/system JS needs
//                                        --remote-allow-system-access too.
//
// Register in ~/.omp/agent/mcp.json:
//   "librewolf-ctl": { "type": "stdio", "command": "bun",
//                      "args": ["$HOME/.local/share/librewolf-omp-remote-control/mcp/server.mjs"] }

import { listInstances, open, pickInstance, sendArgs } from "../lib/lw.mjs";
import { Bidi, DEFAULT_BIDI_PORT, matchTab, withBidi } from "../lib/bidi.mjs";
import { Marionette, DEFAULT_MARIONETTE_PORT } from "../lib/marionette.mjs";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER = { name: "librewolf-ctl", version: "0.2.0" };
const BIDI_PORT = Number(process.env.LIBREWOLF_BIDI_PORT ?? DEFAULT_BIDI_PORT);
const MAR_PORT = Number(process.env.LIBREWOLF_MARIONETTE_PORT ?? DEFAULT_MARIONETTE_PORT);

const tabParam = {
  type: "string",
  description: "tab selector: an index from librewolf_tabs, a context id, or a url substring",
};

const TOOLS = [
  {
    name: "librewolf_status",
    description:
      "List running LibreWolf instances that accept remote commands: pid, profile, version, D-Bus name. Works without any debug flag.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "librewolf_open",
    description:
      "Open one or more URLs in the running LibreWolf over its D-Bus remote, as background tabs by default. Pass urls to open several in one call. No new process, no X11. Cannot choose or read a tab.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        urls: { type: "array", items: { type: "string" }, description: "several URLs in one call" },
        target: { type: "string", enum: ["tab", "window", "private"], description: "default tab" },
        instance: { type: "string", description: "pid, profile name or path, or bus name" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "librewolf_tabs",
    description:
      "List every browsing context of the running LibreWolf (index, id, url). Needs --remote-debugging-port on the browser.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "librewolf_new",
    description: "Open a new tab in the running LibreWolf, optionally loading a URL; returns its index and id.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        foreground: { type: "boolean", description: "select the tab (default: background)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "librewolf_nav",
    description: "Navigate a tab of the running LibreWolf and wait for the load to complete.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" }, tab: tabParam },
      required: ["url", "tab"],
      additionalProperties: false,
    },
  },
  {
    name: "librewolf_eval",
    description:
      "Evaluate JavaScript in a tab of the running LibreWolf and return the value (promises awaited, JSON-encoded).",
    inputSchema: {
      type: "object",
      properties: { expression: { type: "string" }, tab: tabParam },
      required: ["expression", "tab"],
      additionalProperties: false,
    },
  },
  {
    name: "librewolf_shot",
    description: "Screenshot a tab of the running LibreWolf to a PNG file; returns the path, byte size and url.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "absolute path for the PNG" }, tab: tabParam },
      required: ["path", "tab"],
      additionalProperties: false,
    },
  },
  {
    name: "librewolf_close",
    description: "Close a tab of the running LibreWolf.",
    inputSchema: {
      type: "object",
      properties: { tab: tabParam },
      required: ["tab"],
      additionalProperties: false,
    },
  },
  {
    name: "librewolf_cookies",
    description:
      "Cookie names the browser holds, domain and name only. Set values=true only when a value is genuinely needed; values are live session material.",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "substring filter on the cookie domain" },
        values: { type: "boolean", description: "include up to 40 chars of each value" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "librewolf_chrome",
    description:
      "Run one expression as the browser's own system-principal JS (Services, ChromeUtils) via Marionette. Requires the browser to have started with --remote-allow-system-access.",
    inputSchema: {
      type: "object",
      properties: { expression: { type: "string" } },
      required: ["expression"],
      additionalProperties: false,
    },
  },
  {
    name: "librewolf_session_end",
    description:
      "Clear the browser's single WebDriver session. Use when a client answers 'Maximum number of active sessions' — a crashed client leaves the session behind and blocks every later one.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

const text = (s) => ({ content: [{ type: "text", text: s }], isError: false });

/** Run a BiDi action, resolving `tab` against the live tab list first. */
async function inTab(args, action) {
  return withBidi(BIDI_PORT, async (bidi) => {
    const tab = matchTab(await bidi.listTabs(), args.tab);
    return text(await action(bidi, tab));
  });
}

async function call(name, args = {}) {
  switch (name) {
    case "librewolf_status":
      return text(JSON.stringify({ instances: listInstances() }, null, 2));

    case "librewolf_open": {
      const inst = pickInstance(args.instance);
      const urls = args.urls ?? (args.url ? [args.url] : []);
      if (urls.length === 0) throw new Error("librewolf_open needs url or urls");
      open(inst, urls, { target: args.target ?? "tab" });
      return text(
        `opened ${urls.length} url${urls.length === 1 ? "" : "s"} (target=${args.target ?? "tab"}) in pid ${inst.pid} ${inst.profileName ?? inst.busName}`,
      );
    }

    case "librewolf_tabs":
      return withBidi(BIDI_PORT, async (bidi) => {
        const tabs = await bidi.listTabs();
        const top = tabs.filter((t) => t.parent === null);
        const lines = tabs.map((t) =>
          `${t.parent === null ? top.indexOf(t) : "└"}\t${t.id}\t${t.url ?? ""}`,
        );
        return text(`${lines.join("\n")}\n(${top.length} tabs)`);
      });

    case "librewolf_new":
      return withBidi(BIDI_PORT, async (bidi) => {
        const id = await bidi.createTab(args.url, { background: !args.foreground });
        const top = (await bidi.listTabs()).filter((t) => t.parent === null);
        return text(`index ${top.findIndex((t) => t.id === id)}\tid ${id}\t${args.url ?? "about:blank"}`);
      });

    case "librewolf_nav":
      return inTab(args, async (bidi, tab) => {
        await bidi.navigate(tab.id, args.url);
        return `navigated ${tab.id} to ${args.url}`;
      });

    case "librewolf_eval":
      return inTab(args, async (bidi, tab) => {
        const value = Bidi.value(await bidi.evaluate(tab.id, args.expression));
        return JSON.stringify(value === undefined ? null : value);
      });

    case "librewolf_shot":
      return inTab(args, async (bidi, tab) => {
        const png = await bidi.screenshot(tab.id, { asBase64: false });
        await Bun.write(args.path, png);
        return `${args.path}\t${png.length} bytes\t${tab.url ?? ""}`;
      });

    case "librewolf_close":
      return inTab(args, async (bidi, tab) => {
        await bidi.closeTab(tab.id);
        return `closed ${tab.url ?? tab.id}`;
      });

    case "librewolf_cookies":
      return withBidi(BIDI_PORT, async (bidi) => {
        const all = await bidi.cookies();
        const hit = args.domain ? all.filter((c) => (c.domain ?? "").includes(args.domain)) : all;
        const lines = hit.map((c) =>
          args.values
            ? `${c.domain}\t${c.name}\t${String(c.value).slice(0, 40)}`
            : `${c.domain}\t${c.name}`,
        );
        return text(`${lines.join("\n")}\n(${hit.length} cookies)`);
      });

    case "librewolf_chrome": {
      const mar = await Marionette.connect(MAR_PORT);
      try {
        await mar.newSession({});
        return text(JSON.stringify(await mar.chrome(args.expression)));
      } finally {
        await mar.deleteSession();
        mar.close();
      }
    }

    case "librewolf_session_end": {
      const mar = await Marionette.connect(MAR_PORT);
      try {
        await mar.deleteSession();
        return text("session cleared");
      } finally {
        mar.close();
      }
    }

    default:
      throw new Error(`unknown tool ${name}`);
  }
}

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
function replyError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    reply(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: SERVER,
    });
  } else if (method?.startsWith("notifications/")) {
    // notifications carry no id and need no answer
  } else if (method === "ping") {
    reply(id, {});
  } else if (method === "tools/list") {
    reply(id, { tools: TOOLS });
  } else if (method === "tools/call") {
    const name = params?.name;
    pending++;
    // The browser holds exactly one WebDriver session, so calls must not
    // overlap even though MCP clients may send them concurrently.
    const run = queue.then(() => call(name, params?.arguments));
    queue = run.then(
      () => {},
      () => {},
    );
    run
      .then((res) => reply(id, res))
      .catch((e) => reply(id, { content: [{ type: "text", text: e.message }], isError: true }))
      .finally(() => {
        pending--;
        if (pending === 0 && stdinEnded) process.exit(0);
      });
  } else if (id !== undefined) {
    replyError(id, -32601, `method not found: ${method}`);
  }
}

let buf = "";
let pending = 0;
let stdinEnded = false;
let queue = Promise.resolve();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      replyError(null, -32700, "parse error");
      continue;
    }
    try {
      handle(msg);
    } catch (e) {
      if (msg?.id !== undefined) replyError(msg.id, -32603, e.message);
    }
  }
});
process.stdin.on("end", () => {
  stdinEnded = true;
  if (pending === 0) process.exit(0);
});