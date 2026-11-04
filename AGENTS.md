# Agent instructions

Personal mods for the [Herdr desktop app](https://herdr.dev) (herdr-app).

## Layout

- `<mod>/`: one folder per mod, in the herdr.dev/mods format: `<mod>/mods/<name>/` (`main.js`, `mod.json`, assets; same shape as `~/.config/herdr-app/mods/<name>/`), `<mod>/keys.json`, `<mod>/preview.png`, `<mod>/README.md`, and a `<mod>/RECIPE.md` before publishing.
- `keys.json`: bindings to merge into `~/.config/herdr-app/keys.json`. Never overwrite the user's file.
- `install.sh`: symlinks each `*/mods/<name>/` into `~/.config/herdr-app/mods/`. herdr-app follows the symlink and reloads on save.
- `check.sh`: everything CI runs, plus `herdr-app check` per mod and a warning when `types/gpui-kit.d.ts` is stale. Run it after every change.
- `<mod>/mods/<name>/logic.js`: the mod's decisions, no `herdr`/`gpui-*` imports, pure functions (pass `now` and live facts like "in use" in). `main.js` gathers facts and draws. Anything worth testing goes in `logic.js`.
- `<mod>/test/*.test.js`: `node:test` tests of `logic.js`. Outside the mod folder so they aren't installed.
- `types/gpui-kit.d.ts` + `types/VERSION`: committed copy of the declarations herdr-app writes into a mod folder (the app-home copy lacks the `herdr` module). Refresh with `scripts/update-types.sh` after a Herdr update, never edit.
- `jsconfig.json`: type-checks `*/mods/*/*.js` with the app's options against `types/`, no Node types. `jsconfig.test.json`: the tests, with `@types/node`. They are separate because `gpui-kit.d.ts` declares its own `fs/promises`, `process` and `console`.
- `package.json`: `npm run typecheck`, `npm test`. TypeScript is pinned to 5.x (`tsc` 7 is a rewrite; not tried).
- `.github/workflows/ci.yml`: `npm ci`, typecheck, test on push to `main` and PRs.
- Root `README.md` has a table with one row per mod. Add a row when adding a mod.
- `preview.png`: `herdr-app shot` of the window, cropped to the mod (`sips -c <h> <w> --cropOffset <y> <x>`).

## Rules

- The mod API is described in `~/.config/herdr-app/AGENTS.md`, `herdr.d.ts` and `gpui-kit.d.ts`. herdr-app rewrites them on every start; read them, never copy them here.
- herdr-app writes `gpui-kit.d.ts` and `jsconfig.json` into each mod folder. They are git-ignored.
- **Mods are JavaScript typed with JSDoc.** herdr-app runs no TypeScript: a folder without `main.js` is refused, and type annotations in `.js` or `.ts` files fail to parse ("missing initializer for variable"). Type every function, class field and callback with JSDoc; import types with `/** @typedef {import("gpui-kit").Context} Context */` (also `AsyncContext`, `Color`, `Element`). `theme()` is typed `Record<string, string>` but `.bg()` and friends want `Color` (`#…`): cast once, `/** @type {Record<string, Color>} */ (theme())`. Cast `shared()` results to their shape.
- After every change: `./check.sh` (must be all green), then open the mod (`herdr-app do mod.open --name <name>`) and look at it (`herdr-app shot`).
- Marketplace format (if a mod is published): the `<mod>/` folder above with a `RECIPE.md` (structure in `~/.config/herdr-app/AGENTS.md`, "Layouts and mods other people made"), no `layouts/`, repo topic `herdr-mod`.
- Keep each mod's README honest: its "What this does to your machine" section lists every program it runs, every file it writes and every network call. Update it with the code.
- Keep `RECIPE.md` in step with the code: sizes, labels, colors and behavior it states must be what `main.js` does. Structure: `~/.config/herdr-app/AGENTS.md`, "Layouts and mods other people made".

## Mods

### annotator-open (`annotator-open/`)

A launcher with no UI: `mod.open:annotator-open` toggles the third-party `annotator` mod ([herdr-annotator](https://github.com/jakub-tucek/herdr-annotator)) as a pane in the focused tab (split right → focus → close).

- It exists so Annotator's installed files stay unedited. Its updater refuses to update files that don't match its receipt, so never add an `overlay` to `~/.config/herdr-app/mods/annotator/mod.json`.
- Always pass `pane` to `pane.split`. With a layout terminal block focused, `focused().pane` is null and an implicit split fails.

### worktree-janitor (`worktree-janitor/`)

Lists every checkout in `~/.herdr/worktrees/<repo>/<checkout>` with a status, and removes them one by one or in bulk ("purge").

- PR state from `gh pr list --head <branch> --state all` is the main signal. Main branch is never compared (rebase merges rewrite SHAs).
- A merged or closed PR is safe only when local `HEAD` equals the PR's `headRefOid` and `git status --porcelain` is empty. Git-ignored files don't count.
- `in use` (a space folder, pane cwd or live terminal cwd is inside the checkout) and uncommitted changes always block purge.
- Remove: closes spaces and terminals in the checkout, moves the folder to `~/.herdr/worktrees-trash/` (same volume, an instant rename), runs `git worktree remove --force` (the folder is gone, so git only drops its record; on failure the folder is moved back), then `git branch -D`. `sweep()` deletes the trash in a detached background `rm -rf` per folder, so it survives the panel closing and the 30 s `exec` limit. Opening the panel sweeps leftovers. Only folders directly under `<root>/<repo>/` are touched.
- Purge rules are checkboxes stored in `shared("worktree-janitor.rules")`: merged PRs (on by default), closed PRs and stale no-PR checkouts (off by default). Each shows how many checkouts it matches. The safety conditions that always block purge are listed under them.
- Results are cached in `shared("worktree-janitor.cache")` (`{at, list}`). Opening the dialog shows the cache and only checks folders it doesn't have (and drops gone ones); `refresh` checks everything and resets `at`. Removing a row drops it from the cache. "in use" is never cached: it is computed from live spaces, panes and terminals.
- Before removing, the checkout is probed again; if git state differs from the cached row, the row is updated and nothing is removed.
