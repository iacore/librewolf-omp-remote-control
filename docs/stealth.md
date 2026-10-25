# Stealth mode: `navigator.webdriver` under remote control

## The problem

Starting LibreWolf with `--remote-debugging-port` or `--marionette` makes every
page read `navigator.webdriver === true`. Some sign-in walls treat that as a
bot signal. Cloudflare's dashboard is the measured case: the login form answers

> There was a problem with verification. Please reload and try again.

on submit, before any password is checked.

## What the browser does

Both remote servers write a shared-data boolean that content processes read for
the property:

| module | write |
|---|---|
| `chrome/remote/content/components/RemoteAgent.sys.mjs` | `RemoteAgent:IsBrowserAutomationRunning` |
| `chrome/remote/content/components/Marionette.sys.mjs` | `Marionette:IsBrowserAutomationRunning` |

A desktop entry that passes both `--remote-debugging-port` and `--marionette`
has **two writers**. Patching one is not enough.

`SHARED_DATA_ACTIVE_KEY` is separate and stays `true`. It drives the chrome-side
gates (certificate-override prompt, translations, update suppression) and the
remote-control cue, which is why the patch does not disturb them.

## What the patch does

`patch/RemoteAgent.sys.mjs` and `patch/Marionette.sys.mjs` change only
`updateWebdriverActiveFlag()`: when `remote.stealth.enabled` (default `true`)
is set, the value published for `IsBrowserAutomationRunning` is forced to
`false`. Both servers still bind, still accept clients, and the browser remains
fully drivable.

Set `remote.stealth.enabled` to `false` in a profile to restore upstream
behaviour without uninstalling anything.

## Installing

```sh
patch/apply-stealth.sh
```

The script:

1. keeps the unpatched archive at `/usr/lib/librewolf/omni.ja.dist` (created on
   first run, only if the installed archive is not already patched);
2. extracts that pristine archive to a temporary directory;
3. replaces the two modules with the patched copies from `patch/`;
4. repacks a stored-entry ZIP as `omni.ja` and installs it with `doas`;
5. deletes every profile's `~/.cache/librewolf/*/startupCache`.

Set `LIBREWOLF_LIB` to patch an install outside `/usr/lib/librewolf`.

After a LibreWolf package upgrade, `omni.ja` is replaced and the patch is gone;
run the script again.

## Two packaging details that cost time

**`omni.ja` cannot be updated in place with `zip`.** Mozilla's archive places
the central directory first, after a 4-byte offset prefix, and the offsets do not
match a normal ZIP layout. `zip` refuses or produces an unreadable archive.
Rebuild from the pristine copy: a plain stored-entry ZIP named `omni.ja` is
accepted and was verified entry-for-entry.

**Chrome module bytecode is cached per profile.** The cache lives at
`~/.cache/librewolf/<profile>/startupCache` and survives replacing `omni.ja`.
A restart can therefore run the old function even though the archive on disk is
patched. This was observed directly: after replacing both modules, the patched
`RemoteAgent` took effect while the newly patched `Marionette` kept running the
old bytecode. Deleting the cache directory fixes it; a fresh profile also does.

## Verification

Measured on LibreWolf 158.0, throwaway profiles under `xvfb-run`, same submit
(email filled, password empty) to a Cloudflare-hosted dashboard:

| launch | `navigator.webdriver` | submit answer |
|---|---|---|
| `--remote-debugging-port`, unpatched | `true` | verification error |
| both flags, unpatched | `true` | verification error |
| both flags, patched `omni.ja` | `false` | `Password is required.` |

The tell is the property, not the other things the Remote Agent changes:

- `remote.prefs.recommended=false` does not clear the wall.
- A decoy HTTP listener on 9222 does not create it.
- A content script that patches only the top document does not clear it. The
  challenge runs in a cross-origin iframe, and the property is per-realm.
- A WebDriver BiDi `script.addPreloadScript` that reports `false` in **every**
  realm does clear it — that is how the property was confirmed as the tell
  before patching the archive. Preload scripts do reach cross-origin child
  frames.

An instrumented getter gave the reading stack:
`.../cdn-cgi/challenge-platform/scripts/precursor/main.js:1:8366`.

## Limits

This is a measurement against one engine build and one site's bundle, not a
claim that the check is stable. A site may move its test to other signals
(worker realms, timing, server-side scoring). The reusable method is the
instrumented getter plus an all-realm preload probe, not the exact detector.
