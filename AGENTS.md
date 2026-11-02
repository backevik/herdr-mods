# Agent instructions

Personal mods for the [Herdr desktop app](https://herdr.dev) (herdr-app).

## Layout

- `<mod>/`: one folder per mod, in the herdr.dev/mods format: `<mod>/mods/<name>/` (`main.js`, `mod.json`, assets; same shape as `~/.config/herdr-app/mods/<name>/`), `<mod>/keys.json`, `<mod>/preview.png`, `<mod>/README.md`, and a `<mod>/RECIPE.md` before publishing.
- `keys.json`: bindings to merge into `~/.config/herdr-app/keys.json`. Never overwrite the user's file.
- `install.sh`: symlinks each `*/mods/<name>/` into `~/.config/herdr-app/mods/`. herdr-app follows the symlink and reloads on save.
- Root `README.md` has a table with one row per mod. Add a row when adding a mod.
- `preview.png`: `herdr-app shot` of the window, cropped to the mod (`sips -c <h> <w> --cropOffset <y> <x>`).

## Rules

- The mod API is described in `~/.config/herdr-app/AGENTS.md`, `herdr.d.ts` and `gpui-kit.d.ts`. herdr-app rewrites them on every start; read them, never copy them here.
- herdr-app writes `gpui-kit.d.ts` and `jsconfig.json` into each mod folder. They are git-ignored.
- After every change: `herdr-app check ~/.config/herdr-app/mods/<name>`, then open the mod (`herdr-app do mod.open --name <name>`) and look at it (`herdr-app shot`).
- Marketplace format (if a mod is published): the `<mod>/` folder above with a `RECIPE.md` (structure in `~/.config/herdr-app/AGENTS.md`, "Layouts and mods other people made"), no `layouts/`, repo topic `herdr-mod`.
- Keep each mod's README honest: its "What this does to your machine" section lists every program it runs, every file it writes and every network call. Update it with the code.
- Keep `RECIPE.md` in step with the code: sizes, labels, colors and behavior it states must be what `main.js` does. Structure: `~/.config/herdr-app/AGENTS.md`, "Layouts and mods other people made".

## Mods

### worktree-janitor (`worktree-janitor/`)

Lists every checkout in `~/.herdr/worktrees/<repo>/<checkout>` with a status, and removes them one by one or in bulk ("purge").

- PR state from `gh pr list --head <branch> --state all` is the main signal. Main branch is never compared (rebase merges rewrite SHAs).
- A merged or closed PR is safe only when local `HEAD` equals the PR's `headRefOid` and `git status --porcelain` is empty. Git-ignored files don't count.
- `in use` (a space folder, pane cwd or live terminal cwd is inside the checkout) and uncommitted changes always block purge.
- Remove: closes spaces and terminals in the checkout, moves the folder to `~/.herdr/worktrees-trash/` (same volume, an instant rename), runs `git worktree remove --force` (the folder is gone, so git only drops its record; on failure the folder is moved back), then `git branch -D`. `sweep()` deletes the trash in a detached background `rm -rf` per folder, so it survives the panel closing and the 30 s `exec` limit. Opening the panel sweeps leftovers. Only folders directly under `<root>/<repo>/` are touched.
- Purge rules are checkboxes stored in `shared("worktree-janitor.rules")`: merged PRs (on by default), closed PRs and stale no-PR checkouts (off by default). Each shows how many checkouts it matches. The safety conditions that always block purge are listed under them.
- Results are cached in `shared("worktree-janitor.cache")` (`{at, list}`). Opening the dialog shows the cache and only checks folders it doesn't have (and drops gone ones); `refresh` checks everything and resets `at`. Removing a row drops it from the cache. "in use" is never cached: it is computed from live spaces, panes and terminals.
- Before removing, the checkout is probed again; if git state differs from the cached row, the row is updated and nothing is removed.
