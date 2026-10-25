# librewolf-omp-remote-control

**Remote debugging and browser automation for LibreWolf and Firefox** — a CLI and an MCP server that drive a running browser over WebDriver BiDi, Marionette and D-Bus. No extension, no second browser process, no X11 automation, no Selenium, no Playwright, no Puppeteer.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![LibreWolf 158](https://img.shields.io/badge/LibreWolf-158-00a6a6.svg)](https://librewolf.net)
[![WebDriver BiDi](https://img.shields.io/badge/protocol-WebDriver%20BiDi-6e4aff.svg)](https://w3c.github.io/webdriver-bidi/)
[![MCP](https://img.shields.io/badge/MCP-stdio-black.svg)](https://modelcontextprotocol.io)

```sh
librewolfctl status|open|prefs|send                 # D-Bus, any running instance
librewolfctl tabs|new|nav|eval|shot|close|cookies   # page control (BiDi)
librewolfctl chrome|context|session-end             # browser internals (Marionette)
```

If you searched for any of these, this is the project:

- *LibreWolf remote debugging* / *enable remote debugging in LibreWolf*
- *Firefox MCP server* / *control Firefox from an AI agent*
- *WebDriver BiDi client for Firefox without Selenium*
- *Marionette client in JavaScript/Bun*
- *hide `navigator.webdriver`* / *navigator.webdriver false Firefox*
- *Firefox sign-in wall "There was a problem with verification"*
- *Firefox automation without geckodriver*

## What it can do

| task | channel | command |
|---|---|---|
| open a URL, window, private window in the running browser | D-Bus | `librewolfctl open <url>...` |
| list, create, navigate, close tabs | BiDi | `librewolfctl tabs\|new\|nav\|close` |
| evaluate JavaScript in a page | BiDi | `librewolfctl eval '<js>' --tab <sel>` |
| screenshot a tab to PNG | BiDi | `librewolfctl shot out.png --tab <sel>` |
| read cookies (names, values with `--values`) | BiDi | `librewolfctl cookies` |
| run system-principal JS: `Services`, prefs, profile path | Marionette | `librewolfctl chrome '<expr>'` |
| expose all of the above to an MCP agent | MCP stdio | `mcp/server.mjs` |

All of it attaches to a browser that is already running. The browser keeps its own profile, logins, extensions and session — nothing is launched in a separate automation profile.

## Quick start

```sh
git clone https://github.com/iacore/librewolf-omp-remote-control.git \
  ~/.local/share/librewolf-omp-remote-control
ln -s ~/.local/share/librewolf-omp-remote-control/bin/librewolfctl ~/.local/bin/librewolfctl

# 1. start LibreWolf with the remote flags on every launch
cp ~/.local/share/librewolf-omp-remote-control/config/librewolf.desktop \
   ~/.local/share/applications/librewolf.desktop

# 2. profile switches (background hand-off, enable userChrome.css)
cat ~/.local/share/librewolf-omp-remote-control/config/user.js >> <profile>/user.js
mkdir -p <profile>/chrome
cp ~/.local/share/librewolf-omp-remote-control/config/userChrome.css <profile>/chrome/

# 3. restart LibreWolf, then
librewolfctl tabs
librewolfctl eval 'document.title' --tab 0
```

Full setup, including the optional MCP registration, is in [docs/install.md](docs/install.md).

## Three channels, and why

LibreWolf (Gecko) exposes three independent remote surfaces with different launch flags and reach:

| channel | needs | can do |
|---|---|---|
| D-Bus remote | nothing | hand a URL/window/preferences request to the already-running instance |
| WebDriver BiDi | `--remote-debugging-port=9223` | tabs, navigation, JS evaluation, screenshots, cookies, synthetic input |
| Marionette | `--marionette` (2828), plus `--remote-allow-system-access` for privileged work | everything above, and system-principal JS: `Services`, prefs, profile path, other windows |

A wrong D-Bus bus name or wrong argument offsets still returns a successful reply and opens nothing — verify by the page loading, never by the return value. One profile takes one instance, and the browser holds exactly one WebDriver session across BiDi and Marionette.

## MCP server

The same client is an MCP stdio server, so an agent can drive the user's real browser instead of a headless copy:

```json
{
  "mcpServers": {
    "librewolf-ctl": {
      "type": "stdio",
      "command": "bun",
      "args": ["/home/USER/.local/share/librewolf-omp-remote-control/mcp/server.mjs"]
    }
  }
}
```

Tools: `librewolf_status`, `librewolf_open`, `librewolf_tabs`, `librewolf_new`, `librewolf_nav`, `librewolf_eval`, `librewolf_shot`, `librewolf_close`, `librewolf_cookies`, `librewolf_chrome`, `librewolf_session_end`. Written for [omp](https://github.com/can1357/oh-my-pi); any MCP client that speaks stdio works.

## Stealth mode: make `navigator.webdriver` false

Firefox publishes `isBrowserAutomation` to every content process while either remote server runs, so pages see `navigator.webdriver === true`. Some sign-in walls read that property and refuse the submit before checking credentials. Cloudflare's dashboard is the measured case: it answers *"There was a problem with verification. Please reload and try again."*

`patch/` suppresses the published flag in both writers — `RemoteAgent.sys.mjs` and `Marionette.sys.mjs` — while leaving both servers listening. The browser stays drivable; only the advertisement disappears.

| launch | `navigator.webdriver` | submit answer |
|---|---|---|
| `--remote-debugging-port`, unpatched | `true` | verification error |
| both flags, unpatched | `true` | verification error |
| both flags, patched `omni.ja` | `false` | `Password is required.` |

```sh
patch/apply-stealth.sh          # after every LibreWolf upgrade
```

Why both files, why the startup cache must be cleared, and the measurement method: [docs/stealth.md](docs/stealth.md).

## Documentation

- [Installing and configuring](docs/install.md) — desktop entry, profile prefs, cue suppression, MCP registration, permissions.
- [Stealth mode](docs/stealth.md) — the `navigator.webdriver` patch, cache invalidation, verification.
- [Troubleshooting](docs/troubleshooting.md) — session leaks, port conflicts, stale bytecode, cues, focus.
- [All changes and rationale](CHANGES.md) — every LibreWolf and omp modification, and what is deliberately out of scope.

## Verified

Against LibreWolf 158.0 on Linux: D-Bus open (six URLs in ~0.1 s), BiDi tabs/new/nav/eval/shot/close/cookies, Marionette privileged JS, eight MCP calls over one stdio session, and the stealth table above with BiDi still working after the patch.

## FAQ

**Does this use geckodriver or Selenium?** No. It talks to Gecko's own Remote Agent (WebDriver BiDi) and Marionette protocols over a WebSocket and a TCP socket. There is no driver binary and no `webdriver` HTTP server.

**Is it Playwright or Puppeteer?** No. Those drive Chromium (and Playwright can drive patched Firefox builds, not an installed LibreWolf). This drives the browser the user is already using, with its real profile.

**Why not `--headless`?** The point is the real session: existing logins, cookies, extensions and window. Headless gives up exactly what makes the browser worth attaching to.

**Can it drive a different Firefox-based browser?** The client speaks the protocols, not LibreWolf-specific APIs; the desktop entry and the stealth patch are LibreWolf/Gecko paths and may need adjusting for another build.

**Is the browser exposed to other local users?** It listens on `127.0.0.1` only, with no authentication. Treat the profile as trusted-local while the flags are on.

## Limits

- Tab listing shows browsing contexts only: no titles, no window grouping, no "active tab".
- `cookies` reads; it cannot set or delete. BiDi `storage.setCookie` / `deleteCookies` exist in `lib/bidi.mjs` but are not exposed.
- `--bidi-port` / `--marionette-port` are exercised at 9223/2828 only.
- No extension is installed, so extension-based page tooling cannot reach this browser.
- The stealth patch is tied to a Firefox 158-era module layout; re-check file names after a major upgrade.

## License

MIT, except the patched Gecko modules under `patch/`, which are MPL-2.0 and keep their headers.
