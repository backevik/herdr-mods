# herdr-mods

Mods for the [Herdr app](https://herdr.dev). Each folder is one mod, laid out the way [herdr.dev/mods](https://herdr.dev/mods) expects: `mods/<name>/`, a `keys.json` snippet, a `preview.png` and a `RECIPE.md` (the brief another agent builds the mod from).

| Mod | What it does | Key |
| :--- | :--- | :--- |
| [Worktree Janitor](worktree-janitor/) | Lists every worktree in `~/.herdr/worktrees` with its PR status and removes the ones you're done with, one at a time or with Purge. | `ctrl-alt-cmd-j` |

<a href="worktree-janitor/"><img src="worktree-janitor/preview.png" alt="Worktree Janitor" width="430"></a>

## Install

Ask your agent, with the link to the mod's folder:

```text
Read ~/.config/herdr-app/AGENTS.md, then add this mod: https://github.com/backevik/herdr-mods/tree/main/worktree-janitor
```

Or follow the install steps in each mod's README.

## Development

```sh
git clone git@github.com:backevik/herdr-mods.git && cd herdr-mods
./install.sh
```

`install.sh` symlinks every `*/mods/<name>/` into `~/.config/herdr-app/mods/`. Herdr follows the link, so a save in this repo reloads the mod in the app. Then:

```sh
herdr-app check ~/.config/herdr-app/mods/<name>   # loads the mod once, fails on errors
herdr-app do mod.open --name <name>               # open it
herdr-app shot preview.png                        # screenshot the window
```

Herdr writes `gpui-kit.d.ts` and `jsconfig.json` into each mod folder for editor types. They are git-ignored. See [AGENTS.md](AGENTS.md) for conventions.

## License

[MIT](LICENSE) © Andreas Bäckevik
