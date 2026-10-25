# Troubleshooting

## `Maximum number of active sessions`

The browser holds exactly one WebDriver session, shared by BiDi and Marionette.
A client that disconnects without `session.end` leaves it registered, and every
later client is refused.

- BiDi leak: restart the browser. There is no sessionless way to clear it.
- Marionette leak: `librewolfctl session-end` is a sessionless Marionette
  command and clears it.

`librewolfctl` (and the MCP server) end their session in a `finally` block. Raw
scripts that connect to `ws://127.0.0.1:9223/session` must do the same.

## `cannot connect to ws://127.0.0.1:<port>/session`

The browser was started without `--remote-debugging-port`, or on another port.
`librewolfctl --bidi-port <n>` selects a non-default port; the flag and the
client must agree. Check the listening socket rather than guessing:

```sh
ss -ltn | grep -E '9223|2828'
```

## `no Marionette banner from 127.0.0.1:<port>`

The browser was started without `--marionette`. The default is 2828; a profile
pref `marionette.port` can move it, and the client flag is
`--marionette-port`.

## `System access is required`

`librewolfctl eval` can start working and then fail after navigating to another
site when the browser lacks `--remote-allow-system-access`. Either relaunch with
the `LibreWolf (privileged debug)` action, or use a probe that needs only
`tabs` / `new` / `nav` / `shot`, which do not require the flag.

The same flag is required for `librewolfctl chrome` at all times.

## A verified launch still advertises `navigator.webdriver`

If the stealth patch was just installed, the profile's chrome-module cache is
stale. Delete `~/.cache/librewolf/*/startupCache` and restart. The installer
does this; a manual copy of `omni.ja` does not.

Confirm what is installed before debugging further:

```sh
unzip -p /usr/lib/librewolf/omni.ja \
  chrome/remote/content/components/RemoteAgent.sys.mjs | grep -c remote.stealth.enabled
```

`0` means the installed archive is unpatched.

## The robot icon and red stripes are back

An update replaced `chrome/userChrome.css`, the stylesheet pref was reset, or the
browser is reading a different profile. The pref
`toolkit.legacyUserProfileCustomizations.stylesheets` must be `true`, and the
file must be at `<profile>/chrome/userChrome.css`.

## D-Bus `open` reports success but nothing opens

A wrong bus name or wrong argument offsets still return a successful D-Bus
reply. The bus name is derived from the profile path; a second profile or a
changed path produces a different name. Verify by the page loading. `status`
prints the instance the client will use.

## A second `librewolf <url>` fails with `no DISPLAY`

One profile takes one instance. A second launch does hand off, but it
initialises GTK first and dies without a display. Use `librewolfctl open`, which
goes over D-Bus and needs no X11.

## `EPIPE: broken pipe`

The command was piped into something that closed early, e.g.
`librewolfctl tabs | head -3`. Harmless.

## Testing without touching the live browser

Launch a throwaway instance under a virtual display and a private environment:
`xvfb-run`, a throwaway `HOME`, `DBUS_SESSION_BUS_ADDRESS=disabled:`, a private
`XDG_RUNTIME_DIR`, and audio pointed at a null PCM. Never `-profile` under the
real `HOME`: LibreWolf writes that path into `profiles.ini` as the install
default, and the next normal launch opens the empty test profile while the real
one appears to have lost its bookmarks.

## `omni.ja` patching fails

`zip` cannot update Mozilla's archive in place. Rebuild from
`/usr/lib/librewolf/omni.ja.dist` as the installer does, and do not delete the
`.dist` copy — it is the only pristine source after the first install.
