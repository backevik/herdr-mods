#!/bin/sh
# Copies the type declarations herdr-app wrote into a mod folder (gpui-kit, gpui-base,
# herdr, fs/promises, ...) to types/, for CI, which has no herdr-app. Run it after
# updating Herdr, with the app open, then commit the result.
set -eu

repo=$(cd "$(dirname "$0")/.." && pwd)
src=$(ls "$repo"/*/mods/*/gpui-kit.d.ts 2>/dev/null | head -1 || true)
if [ -z "$src" ]; then
  echo "no gpui-kit.d.ts in any mod folder; run ./install.sh and open herdr-app first" >&2
  exit 1
fi

mkdir -p "$repo/types"
cp "$src" "$repo/types/gpui-kit.d.ts"
herdr-app --version > "$repo/types/VERSION"
echo "types/gpui-kit.d.ts from $(cat "$repo/types/VERSION")"
