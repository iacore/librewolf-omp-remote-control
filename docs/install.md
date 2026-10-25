# Installing and configuring

## Requirements

- LibreWolf 158 or a Firefox build with the Remote Agent. The paths and module
  names below are for the LibreWolf Linux layout.
- `bun` for the CLI and the MCP server.
- `dbus-send` and `busctl` for the D-Bus channel.
- For the stealth patch: `unzip`, `zip`, and a privileged runner (`doas` in the
  examples; `sudo` works if that is the system's tool).

Nothing here launches a browser. Every command attaches to an instance that is
already running.

## 1. Clone and expose the CLI

```sh
git clone https://github.com/iacore/librewolf-omp-remote-control.git \
  ~/.local/share/librewolf-omp-remote-control
ln -s ~/.local/share/librewolf-omp-remote-control/bin/librewolfctl \
  ~/.local/bin/librewolfctl
```

`~/.local/bin` must be on `PATH`. Running `bin/librewolfctl` by path works too;
nothing depends on the symlink.

## 2. Start LibreWolf with the remote flags

The packaged desktop entry starts LibreWolf without any remote surface. A
per-user override changes every launch:

```sh
mkdir -p ~/.local/share/applications
cp ~/.local/share/librewolf-omp-remote-control/config/librewolf.desktop \
   ~/.local/share/applications/librewolf.desktop
```

`Exec` lines use `--remote-debugging-port=9223 --marionette`:

- `9223`, not the Gecko default `9222`, because Chromium commonly holds 9222.
- `--marionette` is what gives `librewolfctl chrome` access to `Services` and
  prefs.
- `--remote-allow-system-access` is deliberately **not** on normal launches.
  It lets any local process run code as the browser, so it lives in the
  `LibreWolf (privileged debug)` action.
- The `LibreWolf (no remote control)` action starts with `--no-remote` and no
  flags. Use it for sites whose challenge refuses a drivable browser. The
  running instance must be quit first: one profile takes one instance.

A desktop environment picks up a changed entry on its next menu scan; logging
out and back in is the blunt way to force it.

Any local process can drive the browser while the flags are on. There is no
authentication on either port. The profile is trusted-local only.

## 3. Profile switches

Find the profile directory (`about:support` → Profile Directory, or
`~/.librewolf/*.default-release`). Append the relevant lines to `user.js`:

```sh
cat ~/.local/share/librewolf-omp-remote-control/config/user.js >> <profile>/user.js
```

- `browser.tabs.loadDivertedInBackground = true` — a URL handed over by another
  application opens as a background tab instead of taking focus.
- `toolkit.legacyUserProfileCustomizations.stylesheets = true` — enables
  `chrome/userChrome.css`.

Appending twice is harmless, but check the file if a value is later changed
elsewhere: the last assignment wins.

## 4. Hide the remote-control cue (optional)

Every launch with either flag draws a robot icon in the urlbar and red
45-degree stripes on the address bar. To remove them:

```sh
mkdir -p <profile>/chrome
cp ~/.local/share/librewolf-omp-remote-control/config/userChrome.css \
   <profile>/chrome/userChrome.css
```

Only the two `:root[remotecontrol]` rules are required; the file in `config/`
contains exactly those.

## 5. MCP registration (optional)

Merge into the harness's MCP configuration — for omp, `~/.omp/agent/mcp.json`:

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

Replace the path. Use an absolute path: the harness does not run from the repo.
Most harnesses load MCP configuration at session start, so a running session
needs its MCP reload before the `librewolf_*` tools appear.

## 6. Verify

```sh
librewolfctl status                 # D-Bus: pid, profile, version
librewolfctl tabs                   # BiDi: index, context id, url
librewolfctl eval 'document.title' --tab 0
librewolfctl chrome 'Services.appinfo.version'   # privileged debug launch only
```

Expected failures are diagnostic:

| message | meaning |
|---|---|
| `no LibreWolf instance answered on D-Bus` | the browser is not running, or the profile's bus name does not match |
| `cannot connect to ws://127.0.0.1:9223/session` | launched without `--remote-debugging-port` |
| `session not created: Maximum number of active sessions` | a previous client leaked a session; restart the browser |
| `System access is required` | launched without `--remote-allow-system-access` |
| `no Marionette banner` | launched without `--marionette` |
