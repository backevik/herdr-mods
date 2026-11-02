#!/bin/sh
# Everything CI runs (type-check, tests), plus what only works here: `herdr-app check`
# for every mod, and a warning when types/gpui-kit.d.ts is older than the app's.
set -eu

repo=$(cd "$(dirname "$0")" && pwd)
cd "$repo"
status=0

[ -d node_modules ] || npm ci --silent

for mod in "$repo"/*/mods/*/; do
  [ -f "$mod/gpui-kit.d.ts" ] || continue
  if ! cmp -s "$mod/gpui-kit.d.ts" types/gpui-kit.d.ts; then
    echo "types/gpui-kit.d.ts differs from what $(herdr-app --version) writes; run scripts/update-types.sh and commit it" >&2
    status=1
  fi
  break
done

echo "== typecheck"
npm run --silent typecheck || status=1
echo "== test"
npm test --silent || status=1

for mod in "$repo"/*/mods/*/; do
  [ -d "$mod" ] || continue
  echo "== herdr-app check $(basename "$mod")"
  herdr-app check "$mod" || status=1
done

exit $status
