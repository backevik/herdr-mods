# Annotator Open

A key that toggles the Herdr Annotator review pane in the focused tab. It has no UI of its own: pressing it opens, focuses or closes the `annotator` mod as a pane.

## What you see

Nothing from this mod. The key's result is the `annotator` mod's pane, split to the right of the focused pane at Herdr's default half width.

## How it behaves

- `ctrl-alt-cmd-r` runs `mod.open:annotator-open`.
- No `annotator` pane in the focused tab: `pane.split {direction: "right", pane, mod: "annotator"}`. `pane` is the focused pane, or the tab's first pane when a layout terminal block has focus (`focused().pane` is null).
- An `annotator` pane in the tab without focus: `pane.focus {pane}`.
- An `annotator` pane with focus: `pane.close {pane}`.
- No focused tab, or no pane in it: a warning toast, nothing else.
- Agent statuses don't matter to it.

## Built from

- `mods/annotator-open/mod.json`: `place: "none"`, overlay `{kind: "popup", width: 1, height: 1, frame: "none"}`, so `mod.open` can start it.
- `main.js`: in `init`, closes its own overlay (`closeOverlay(props().overlay)`), then acts on `decide(focused(), panes())` with `run` or `notify`. `render` returns an empty `div()`.
- `logic.js`: `decide`, a pure function. It finds the `annotator` pane through `panes()[i].mod` in the focused tab.
- `keys.json`: `global` → `ctrl-alt-cmd-r`.

## Watch out

- Don't add an `overlay` to Annotator's own `mod.json`. Its updater compares installed files to its receipt and refuses to update edited ones.
- An implicit `pane.split` fails while a layout terminal block has focus, so always pass `pane`.
- The launcher overlay has to close itself in `init`, or a 1×1 popup stays open and swallows Esc.

## Done when

- `herdr-app check` passes. The `node --test` cases cover open, focus, close, other tabs, a null pane and a missing tab.
- From a terminal pane, the key opens Annotator to the right. Pressing it again in Annotator closes it, and focus goes back.
- With Annotator open and a terminal focused, the key moves focus to Annotator without opening a second one.
