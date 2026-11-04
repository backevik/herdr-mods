# Annotator Open, a Herdr mod

**One key for the [Herdr Annotator](https://github.com/jakub-tucek/herdr-annotator) review pane.** It opens Annotator next to the pane you're in, jumps to it if it's already open in the tab, and closes it if you're in it.

Annotator's own `mod.json` has no overlay, so `mod.open:annotator` does nothing. Adding one would change an installed file, and Annotator's updater refuses to update a mod with local edits. This small launcher leaves Annotator's files alone.

## Install

Requires the [Herdr app](https://herdr.dev) (tested on 0.1.11, macOS) and [Herdr Annotator](https://github.com/jakub-tucek/herdr-annotator) installed as the `annotator` mod.

```sh
git clone https://github.com/backevik/herdr-mods.git
cp -R herdr-mods/annotator-open/mods/annotator-open ~/.config/herdr-app/mods/
herdr-app check ~/.config/herdr-app/mods/annotator-open
```

Then merge [`keys.json`](keys.json) into `~/.config/herdr-app/keys.json`:

```json
{ "global": { "ctrl-alt-cmd-r": "mod.open:annotator-open" } }
```

Without a key, run `herdr-app do mod.open --name annotator-open`.

## Use

Press `ctrl-alt-cmd-r`:

| In the focused tab | The key |
| --- | --- |
| No Annotator pane | Opens one to the right of the focused pane |
| An Annotator pane, focus elsewhere | Focuses it |
| An Annotator pane with focus | Closes it |

It only looks at the focused tab. Annotator panes in other tabs don't count.

## What this does to your machine

- Runs `pane.split`, `pane.focus` or `pane.close` in the window. Nothing else.
- Runs no programs, reads and writes no files, makes no network calls. Annotator does those things itself; see its README.
