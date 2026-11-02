#!/bin/sh
# Links every mod (<mod>/mods/<name>/) into the herdr-app home, so edits here apply at once.
set -eu

repo=$(cd "$(dirname "$0")" && pwd)
app="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
mkdir -p "$app/mods"

for mod in "$repo"/*/mods/*/; do
  [ -d "$mod" ] || continue
  name=$(basename "$mod")
  link="$app/mods/$name"
  if [ -e "$link" ] && [ ! -L "$link" ]; then
    echo "skip $name: $link exists and is not a symlink" >&2
    continue
  fi
  ln -sfn "${mod%/}" "$link"
  echo "linked $name"
done

echo "Merge each mod's keys.json into $app/keys.json for its key bindings."
