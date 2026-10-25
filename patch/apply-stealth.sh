#!/bin/sh
# Rebuild LibreWolf's omni.ja with the stealth-mode patch.
#
# The patch makes `navigator.webdriver` false while the Remote Agent or
# Marionette is running, in every realm (content process), by suppressing the
# shared-data flag those servers publish. The servers themselves keep running,
# so the browser stays drivable. `remote.stealth.enabled=false` restores the
# upstream behaviour for one profile.
#
# Two writers set the flag (RemoteAgent.sys.mjs and Marionette.sys.mjs); both
# patched copies live beside this script.
#
# The pristine archive is kept beside the installed omni.ja as omni.ja.dist, so
# a LibreWolf package upgrade can be re-patched by running this script again.
# Set LIBREWOLF_LIB to patch an install outside /usr/lib/librewolf.
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
lib=${LIBREWOLF_LIB:-/usr/lib/librewolf}
dist="$lib/omni.ja.dist"

if [ ! -f "$dist" ]; then
  tmpchk=$(mktemp -d /tmp/lw-stealth.XXXXXX)
  unzip -p "$lib/omni.ja" chrome/remote/content/components/RemoteAgent.sys.mjs \
    > "$tmpchk/RemoteAgent.sys.mjs" 2>/dev/null || true
  if grep -q 'remote\.stealth\.enabled' "$tmpchk/RemoteAgent.sys.mjs"; then
    rm -rf "$tmpchk"
    echo "no pristine archive at $dist and the installed one is already patched" >&2
    echo "restore LibreWolf (or the unpatched omni.ja) first" >&2
    exit 1
  fi
  rm -rf "$tmpchk"
  doas cp -a "$lib/omni.ja" "$dist"
fi

tmp=$(mktemp -d /tmp/lw-stealth.XXXXXX)
trap 'rm -rf "$tmp"' EXIT INT TERM

unzip -q -o "$dist" -d "$tmp" 2>/dev/null || true
for f in RemoteAgent.sys.mjs Marionette.sys.mjs; do
  cp "$here/$f" "$tmp/chrome/remote/content/components/$f"
done

(cd "$tmp" && find . -type f -print | sed 's#^\./##' | zip -0 -q "$tmp/omni.ja" -@)

doas install -m 644 -o root -g root "$tmp/omni.ja" "$lib/omni.ja"
echo "installed $lib/omni.ja"

# Chrome modules are cached as bytecode under ~/.cache/librewolf; a stale entry
# survives an omni.ja replacement and keeps the old (unpatched) function alive.
rm -rf "$HOME"/.cache/librewolf/*/startupCache
echo "cleared LibreWolf startup caches"
