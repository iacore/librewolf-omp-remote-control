# librewolf-omp-remote-control

Make LibreWolf fully remote-controllable — open URLs, enumerate and drive tabs, run page JS, screenshot, read cookies, and (opt-in) run privileged browser JS — with no extension, no second browser process, and no X11 automation. Ships a small CLI, an MCP stdio server for agent harnesses such as [omp](https://github.com/can1357/oh-my-pi), the desktop-entry and profile changes that enable it, and an optional patch that hides the automation flag from pages.

```
librewolfctl status|open|prefs|send          # D-Bus: works on any running instance
librewolfctl tabs|new|nav|eval|shot|close|cookies   # page control: needs --remote-debugging-port
librewolfctl chrome|context|session-end      # browser internals: needs --marionette
```

## Why three channels

LibreWolf (Gecko) exposes three independent remote surfaces. They need different launch flags and can do different things; this project uses each for what it is good at.

| channel | needs the browser started with | can do |
|---|---|---|
| D-Bus remote | nothing | open a URL, window, private window, preferences, search — handed to the already-running instance |
| WebDriver BiDi | `--remote-debugging-port=9223` | list/create/close tabs, navigate, evaluate JS, screenshots, cookies, synthetic input |
| Marionette | `--marionette` (2828), plus `--remote-allow-system-access` for privileged work | everything above, and system-principal JS: `Services`, prefs, profile path, other windows |

A wrong D-Bus bus name or wrong argument offsets still returns a successful reply and opens nothing. Verify that path by the page loading, never by the call's return value.

One instance takes one profile, and the browser holds exactly one WebDriver session across BiDi and Marionette. A client that exits without `session.end` blocks every later client with `Maximum number of active sessions`; restart the browser (or, for Marionette, use `librewolfctl session-end`).

## Install

The examples assume the repository lives at `~/.local/share/librewolf-omp-remote-control`; any path works, but the MCP and desktop entries must point at the real one.

```sh
git clone https://github.com/iacore/librewolf-omp-remote-control.git \
  ~/.local/share/librewolf-omp-remote-control
ln -s ~/.local/share/librewolf-omp-remote-control/bin/librewolfctl ~/.local/bin/librewolfctl
```

Requirements: `bun` (CLI and MCP server), `dbus-send` and `busctl` (D-Bus channel), and LibreWolf. The stealth installer additionally needs `unzip`, `zip`, and a privileged runner (`doas` in the examples). Nothing here launches a browser; it attaches to one that is already running.

### 1. Start LibreWolf with the remote flags

LibreWolf's packaged desktop entry starts it without any remote surface. Override the entry for the current user — this is the change that makes every normal launch drivable:

```sh
mkdir -p ~/.local/share/applications
cp config/librewolf.desktop ~/.local/share/applications/librewolf.desktop
```

`config/librewolf.desktop` starts the browser with `--remote-debugging-port=9223 --marionette` on every `Exec` line. 9222 is avoided because Chromium commonly holds it. The entry also carries:

- a **privileged debug** action that adds `--remote-allow-system-access` — that flag lets any local process run code as the browser, so it is not on the normal launches;
- a **no remote control** action (`--no-remote`, no flags) for sites whose challenge refuses a drivable browser.

Any local process can drive the browser while these flags are on. Treat the profile as trusted-local only.

### 2. Profile prefs

Copy the relevant lines from `config/user.js` into `<profile>/user.js`. They:

- hand links opened from other applications to background tabs (`browser.tabs.loadDivertedInBackground`);
- enable `chrome/userChrome.css` (`toolkit.legacyUserProfileCustomizations.stylesheets`).

### 3. Hide the remote-control cue (optional)

Every launch with either flag draws a robot icon in the urlbar and red 45-degree stripes on the address bar. `config/userChrome.css` hides both while leaving the flags on:

```css
:root[remotecontrol] #remote-control-box { display: none !important; }
:root[remotecontrol] .urlbar-background { background-image: none !important; }
```

Copy that file to `<profile>/chrome/userChrome.css`. `browser.chrome.disableRemoteControlCueForTests` does not suppress the cue; the pref's check also requires `Cu.isInAutomation`.

### 4. Register the MCP server (optional, for agent harnesses)

Merge `config/mcp.json.example` into the harness's MCP configuration (for omp: `~/.omp/agent/mcp.json`), replacing the path. The server exposes `librewolf_status`, `librewolf_open`, `librewolf_tabs`, `librewolf_new`, `librewolf_nav`, `librewolf_eval`, `librewolf_shot`, `librewolf_close`, `librewolf_cookies`, `librewolf_chrome`, and `librewolf_session_end`. Most harnesses load MCP configuration at session start; reload it after adding the entry.

## Stealth mode: `navigator.webdriver`

Firefox publishes `isBrowserAutomation` to every content process whenever either server runs, so pages read `navigator.webdriver === true`. Some sign-in walls — Cloudflare's dashboard is the measured case — read that value and refuse the submit before checking credentials.

`patch/` contains a two-module patch to the JavaScript in `/usr/lib/librewolf/omni.ja`:

| file | change |
|---|---|
| `chrome/remote/content/components/RemoteAgent.sys.mjs` | `updateWebdriverActiveFlag()` writes `false` for `RemoteAgent:IsBrowserAutomationRunning` |
| `chrome/remote/content/components/Marionette.sys.mjs` | same for `Marionette:IsBrowserAutomationRunning` — Marionette is a second writer and runs on every desktop-entry launch |

Both servers keep listening and the browser stays drivable; only the advertised flag is suppressed. `SHARED_DATA_ACTIVE_KEY` is untouched, so the chrome-side gates (certificate-override prompt, translations, update suppression) and the remote-control cue behave as before.

`remote.stealth.enabled` (default `true`) gates the behaviour; set it to `false` in a profile to restore upstream semantics.

Apply after every LibreWolf package upgrade:

```sh
patch/apply-stealth.sh
```

The script keeps the pristine archive at `/usr/lib/librewolf/omni.ja.dist`, rebuilds `omni.ja` with the patched modules, installs it with `doas`, and removes every profile's `~/.cache/librewolf/*/startupCache`. Clearing that cache is required: chrome-module bytecode survives an `omni.ja` replacement, so a restarted browser otherwise keeps running the old function (observed: a patched `RemoteAgent` took effect while a freshly patched `Marionette` stayed cached). Set `LIBREWOLF_LIB` to patch a non-standard install location.

Measured with LibreWolf 158.0, throwaway profiles under `xvfb-run`, same submit (email filled, password empty) to a Cloudflare-hosted dashboard:

| launch | `navigator.webdriver` | submit answer |
|---|---|---|
| `--remote-debugging-port`, unpatched | `true` | verification error |
| both flags, unpatched | `true` | verification error |
| both flags, patched `omni.ja` | `false` | `Password is required.` |

The tell is the flag, not the listening port or the ~100 "recommended" prefs the Remote Agent applies: a BiDi preload script that reports `false` in every realm — including the challenge's cross-origin iframe — clears the wall without touching either. A script injected only into the top document does not, because the challenge runs in a child frame.

Patched modules are redistributed from LibreWolf/Gecko under the MPL-2.0; they are separate files and keep their MPL headers. Everything else here is MIT.

## Verified

Against LibreWolf 158.0:

- D-Bus: `open` reaches a local probe server; `open <six urls>` opens all six in ~0.1 s.
- BiDi: `tabs`, `new`, `nav`, `eval`, `shot` (PNG bytes written), `close`, `cookies`.
- Marionette: `chrome` returns the browser's privileged JS result; without `--remote-allow-system-access` it answers `System access is required`.
- MCP: eight tool calls over one stdio session returned the expected results.
- Stealth: values in the table above, with BiDi still working after the patch.

## Limits

- Tab listing shows browsing contexts only: no titles, no window grouping, no "active tab".
- `cookies` reads; it cannot set or delete. BiDi `storage.setCookie` / `deleteCookies` in `lib/bidi.mjs` can be exposed.
- `--bidi-port` / `--marionette-port` are exercised at 9223/2828 only.
- No extension is installed, so extension-based page tooling cannot reach this browser.
- The stealth patch is tied to a Firefox 158-era module layout; re-check the file names after a major upgrade.
