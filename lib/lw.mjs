// Operate a *running* LibreWolf over its session D-Bus remote interface.
//
// Protocol (mechanism verified against this machine's LibreWolf 158.0 and
// against mozilla-central `toolkit/components/remote/`):
//   bus name   io.gitlab.librewolf.<base64(profile path), / + = -> _>
//   path       /org/mozilla/librewolf/Remote  (LibreWolf 156+;
//              /io/gitlab/librewolf/Remote on 152 — both are tried)
//   interface  io.gitlab.librewolf
//   method     OpenURL(ay)
//   argument   the packed command line that a would-be second instance sends:
//              [int32 argc][int32 offset argv0..argvN][cwd\0][argv0\0]...[argvN\0]
//              offsets are absolute, measured from the start of the buffer.
//              argv[0] is conventionally the binary path and is ignored.
//
// Nothing here starts a browser or touches X11.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const LIBREWOLF_BIN = "/usr/lib/librewolf/librewolf";
const BUS_PREFIX = "io.gitlab.librewolf.";
/** The object path the remote interface lives at, newest first. LibreWolf
 *  moved it from `/io/gitlab/…` to `/org/mozilla/…`; the wrong one answers
 *  `Object does not exist at path`. */
const REMOTE_PATHS = ["/org/mozilla/librewolf/Remote", "/io/gitlab/librewolf/Remote"];
const REMOTE_IFACE = "io.gitlab.librewolf";
const PROFILES_ROOT = path.join(os.homedir(), ".librewolf");

/** Pack argv into the buffer the remote `OpenURL` method expects. */
export function packCommandLine(args, cwd) {
  if (args.length < 1) throw new Error("packCommandLine: empty argv");
  const chunks = [Buffer.from(cwd + "\0")];
  let end = 4 * (args.length + 1) + chunks[0].length;
  const offsets = [];
  for (const a of args) {
    offsets.push(end);
    const chunk = Buffer.from(a + "\0");
    chunks.push(chunk);
    end += chunk.length;
  }
  const head = Buffer.alloc(4 * (args.length + 1));
  head.writeInt32LE(args.length, 0);
  offsets.forEach((o, i) => head.writeInt32LE(o, 4 * (i + 1)));
  return Buffer.concat([head, ...chunks]);
}

/** Profile directory whose `lock` symlink records this pid, if any. */
function profileForPid(pid) {
  let entries;
  try {
    entries = fs.readdirSync(PROFILES_ROOT);
  } catch {
    return null;
  }
  for (const name of entries) {
    const dir = path.join(PROFILES_ROOT, name);
    let target;
    try {
      target = fs.readlinkSync(path.join(dir, "lock"));
    } catch {
      continue;
    }
    if (target.endsWith(`:+${pid}`)) return dir;
  }
  return null;
}

function profileVersion(dir) {
  try {
    const ini = fs.readFileSync(path.join(dir, "compatibility.ini"), "utf8");
    return /^LastVersion=(.+)$/m.exec(ini)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Every running LibreWolf that owns a session-bus remote name. */
export function listInstances() {
  let out;
  try {
    out = execFileSync("busctl", ["--user", "list", "--no-legend", "--no-pager"], {
      encoding: "utf8",
    });
  } catch (e) {
    throw new Error(`busctl --user list failed: ${e.message}`);
  }
  const found = [];
  for (const line of out.split("\n")) {
    const m = /^(\S+)\s+(\d+)\s+(\S+)\s+/.exec(line);
    if (!m) continue;
    const [, busName, pidText] = m;
    if (!busName.startsWith(BUS_PREFIX)) continue;
    const pid = Number(pidText);
    const profile = profileForPid(pid);
    found.push({
      busName,
      pid,
      profile,
      profileName: profile ? path.basename(profile) : null,
      version: profile ? profileVersion(profile) : null,
    });
  }
  return found;
}

/** Resolve one instance, or throw with the candidate list. */
export function pickInstance(selector) {
  const all = listInstances();
  if (all.length === 0) {
    throw new Error("no running LibreWolf instance owns a session-bus remote name");
  }
  if (selector === undefined || selector === null || selector === "") {
    if (all.length === 1) return all[0];
    throw new Error(
      `multiple LibreWolf instances, pass a selector: ${all
        .map((i) => `${i.pid} (${i.profileName ?? i.busName})`)
        .join(", ")}`,
    );
  }
  const want = String(selector);
  const hit = all.find(
    (i) =>
      i.busName === want ||
      String(i.pid) === want ||
      i.profileName === want ||
      i.profile === want,
  );
  if (!hit) {
    throw new Error(
      `no instance matches ${want}; running: ${all
        .map((i) => `${i.pid} (${i.profileName ?? i.busName})`)
        .join(", ")}`,
    );
  }
  return hit;
}

/**
 * Send a LibreWolf command line to a running instance.
 * @param {{busName: string}} instance
 * @param {string[]} args argv *without* argv[0]
 * @param {{cwd?: string, timeoutMs?: number}} [opts]
 */
export function sendArgs(instance, args, opts = {}) {
  const payload = packCommandLine([LIBREWOLF_BIN, ...args], opts.cwd ?? process.cwd());
  const bytes = Array.from(payload).join(",");
  const timeout = opts.timeoutMs ?? 15000;
  let last = "";
  for (const path of REMOTE_PATHS) {
    try {
      execFileSync(
        "dbus-send",
        [
          "--session",
          "--print-reply",
          `--reply-timeout=${timeout}`,
          `--dest=${instance.busName}`,
          path,
          `${REMOTE_IFACE}.OpenURL`,
          `array:byte:${bytes}`,
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
      return true;
    } catch (e) {
      last = (e.stderr || e.message || "").trim();
      // A path this build does not have is the only failure worth retrying;
      // anything else (no bus name, refused) is the instance's own answer.
      if (!/does not exist|UnknownMethod|UnknownObject/.test(last)) break;
    }
  }
  throw new Error(`OpenURL to ${instance.busName} failed: ${last}`);
}

export const TARGETS = ["tab", "window", "private", "preferences"];

/**
 * Open URLs (or the preferences dialog) in a running instance. Several URLs go
 * in one command line, so one `OpenURL` call opens them all.
 * @param {{busName: string}} instance
 * @param {string | string[] | null} urls
 */
export function open(instance, urls, { target = "tab", cwd } = {}) {
  if (!TARGETS.includes(target)) {
    throw new Error(`unknown target ${target}; expected ${TARGETS.join("|")}`);
  }
  const list = urls == null ? [] : Array.isArray(urls) ? urls : [urls];
  if (list.length === 0 && target !== "preferences") {
    throw new Error("open requires a URL");
  }
  const args = [];
  if (target === "window") args.push("--new-window");
  else if (target === "private") args.push("--private-window");
  else if (target === "preferences") args.push("--preferences");
  if (target === "preferences") {
    if (list.length !== 0) throw new Error("target=preferences takes no URL");
  } else {
    args.push(...list);
  }
  return sendArgs(instance, args, { cwd });
}