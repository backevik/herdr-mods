#!/bin/sh
# Type-checks every mod with tsc (JSDoc against the app's gpui-kit.d.ts) and loads it
# with `herdr-app check`. herdr-app writes gpui-kit.d.ts and jsconfig.json into a mod
# folder the first time it loads it, so run ./install.sh and open the app once first.
set -eu

repo=$(cd "$(dirname "$0")" && pwd)
status=0

for mod in "$repo"/*/mods/*/; do
  [ -d "$mod" ] || continue
  name=$(basename "$mod")
  if [ ! -f "$mod/gpui-kit.d.ts" ] || [ ! -f "$mod/jsconfig.json" ]; then
    echo "$name: no gpui-kit.d.ts or jsconfig.json yet; run ./install.sh and open herdr-app" >&2
    status=1
    continue
  fi
  echo "== $name: tsc"
  npx --yes --package typescript@5 tsc -p "$mod/jsconfig.json" || status=1
  echo "== $name: herdr-app check"
  herdr-app check "$mod" || status=1
done

exit $status
