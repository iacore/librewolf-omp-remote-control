# All changes, and why

Everything done to LibreWolf and to omp (the agent harness at
`~/computing/agent-harness/omp-custom`) to make the browser remotely
controllable. The earlier steps were taken in separate sessions; this file is
the consolidated record. Changes unrelated to remote control are listed at the
end so the boundary is explicit.

## LibreWolf

### 1. Desktop entry override — remote flags on every launch (2026-10-16)

File: `~/.local/share/applications/librewolf.desktop` (user override of the
packaged entry), shipped here as `config/librewolf.desktop`.

- Every `Exec` line gains `--remote-debugging-port=9223 --marionette`. This is
  what makes page control and browser control available at all; without the
  flags the browser is not drivable and `librewolfctl` can only open URLs over
  D-Bus.
- 9222 is not used because Chromium commonly occupies it.
- `--remote-allow-system-access` is **not** on the normal launches. That flag
  lets any local process execute code as the browser, so it lives in one extra
  action, `LibreWolf (privileged debug)`.
- An extra action, `Sign in without remote control` in the sanitized copy
  (named for the site that motivated it locally), launches with `--no-remote`
  and no flags. It exists because some challenge scripts refuse a drivable
  browser; it requires the running instance to be quit first, since one profile
  takes one instance.

### 2. Profile `user.js` — hand-off and stylesheet switches (2026-10-16)

File: `<profile>/user.js`, shipped as `config/user.js`.

- `browser.tabs.loadDivertedInBackground = true` — a URL handed to the browser
  by another application (`xdg-open`, i.e. `Exec=librewolf %u`) opens as a
  background tab instead of taking selection and raising the window. This
  changes every external hand-off, not only the agent's.
- `toolkit.legacyUserProfileCustomizations.stylesheets = true` — enables
  `chrome/userChrome.css`, required for the cue suppression below.

### 3. `chrome/userChrome.css` — hide the remote-control cue

File: `<profile>/chrome/userChrome.css`, shipped as `config/userChrome.css`.

Both flags put the browser in the "under remote control" state, which Gecko
draws as a robot icon in the urlbar and red 45-degree stripes on
`.urlbar-background` (from `urlbar-searchbar.css`, under
`:root[remotecontrol]`). The CSS suppresses both while the flags stay on:

```css
:root[remotecontrol] #remote-control-box { display: none !important; }
:root[remotecontrol] .urlbar-background { background-image: none !important; }
```

`browser.chrome.disableRemoteControlCueForTests` does not work: the code that
consults it also requires `Cu.isInAutomation`.

### 4. `omni.ja` stealth patch — stop advertising automation (2026-10-26)

Files shipped in `patch/`; installer `patch/apply-stealth.sh`.

Both remote servers write a shared-data boolean that content processes read as
`navigator.webdriver`. The patch suppresses the published value in both writers:

| module | write suppressed |
|---|---|
| `chrome/remote/content/components/RemoteAgent.sys.mjs` | `RemoteAgent:IsBrowserAutomationRunning` |
| `chrome/remote/content/components/Marionette.sys.mjs` | `Marionette:IsBrowserAutomationRunning` |

Rationale: a Cloudflare-hosted sign-in read the property in its
`cdn-cgi/challenge-platform` precursor script and answered "There was a problem
with verification" before checking credentials. With both writers patched and
the property false in every realm, the same submit proceeds to normal field
validation. Only one writer is not enough, because the desktop entry passes
`--marionette` as well as `--remote-debugging-port`.

The pref `remote.stealth.enabled` (read with default `true`) gates the patch, so
a profile can opt back into upstream semantics. The servers still listen and the
browser remains fully drivable; `SHARED_DATA_ACTIVE_KEY` is untouched.

Packaging detail that matters: the archive had to be rebuilt from a pristine
copy (`/usr/lib/librewolf/omni.ja.dist`) rather than edited in place. Mozilla's
`omni.ja` puts the central directory before the file data behind a 4-byte
offset prefix; `zip` cannot update that layout. A plain stored-entry ZIP works
and was verified entry-for-entry against the built archive.

Second packaging detail: chrome-module bytecode is cached per profile under
`~/.cache/librewolf/<profile>/startupCache` and survives replacing `omni.ja`.
A patched restart demonstrated it — the new `RemoteAgent` took effect while the
newly patched `Marionette` kept running the old function. The installer deletes
every profile's cache; a fresh profile is otherwise required.

### 5. Verification method (not a change, recorded for reuse)

- `navigator.webdriver` is per-realm; a content script in the top document does
  not cover a cross-origin iframe.
- WebDriver BiDi `script.addPreloadScript` **does** apply to child frames,
  including a cross-origin Turnstile iframe. That made it possible to prove the
  property was the tell before patching the binary.
- An instrumented getter (`Object.getOwnPropertyDescriptor(Navigator.prototype,
  "webdriver").get` wrapped to log then delegate) produced the challenge
  script's stack frame at `.../scripts/precursor/main.js:1:8366`.
- Test launches run under `xvfb-run` with a throwaway `HOME`, `DBUS_*` disabled,
  a private `XDG_RUNTIME_DIR`, and audio pointed at a null PCM. A `-profile`
  test under the real `HOME` otherwise becomes the install default in
  `profiles.ini` and the next normal launch opens the empty test profile.

## omp

### 1. MCP server registration

File: `~/.omp/agent/mcp.json`, shipped as `config/mcp.json.example`.

```json
"librewolf-ctl": {
  "type": "stdio",
  "command": "bun",
  "args": ["<repo>/mcp/server.mjs"]
}
```

Discovered at session start; a running session needs the harness's MCP reload
before the tools appear. The server has no state beyond a short-lived BiDi
session per call.

### 2. Tool surface exposed to the agent

`librewolf_status`, `librewolf_open`, `librewolf_send`, `librewolf_tabs`,
`librewolf_new`, `librewolf_nav`, `librewolf_eval`, `librewolf_shot`,
`librewolf_close`, `librewolf_cookies`, `librewolf_chrome`,
`librewolf_session_end`. Same implementation as the CLI (`bin/librewolfctl`),
both on top of `lib/`.

### 3. Operator rules added to the harness prompt

File: `~/.omp/agent/APPEND_SYSTEM.md`.

- `xdg-open` MUST mean background tabs, and the browser window MUST NOT take
  focus; the pref above implements the tab part, the window manager handles the
  rest.
- GUI smoke tests MUST use `xvfb-run`, a throwaway profile and `disabled:`
  D-Bus, and MUST NOT touch the live browser session.
- Only processes started by the test may be killed, addressed by recorded PID
  or process group — never by name, because the harness itself runs browsers.

These are policy, not code, but they are what keeps an agent from driving or
killing the wrong browser.

## Out of scope

Changes made to the same LibreWolf install that are **not** about remote
control and are not part of this repository:

- `librewolf.cfg` patch for the extension-popup keyboard-focus bug;
- `user.js` entries for the bookmarks toolbar, the LibreWolf "Nova" UI, and the
  flat sidebar CSS in `userChrome.css`.

They are recorded in the operator's own notes, not here.
