// Opens, focuses or closes the Annotator review pane in the focused tab, so a key can
// reach it: keys.json binds "mod.open:annotator-open". The launcher closes itself at once.
//
// Plain JavaScript (herdr-app runs no TypeScript), typed with JSDoc. logic.js decides.

import { View, div } from "gpui-kit";
import { focused, panes, run, notify, props, closeOverlay } from "herdr";
import { decide } from "./logic.js";

export default class AnnotatorOpen extends View {
  init() {
    const overlay = props()?.overlay;
    if (overlay) closeOverlay(overlay);
    const action = decide(focused(), panes());
    if ("error" in action) notify({ title: "Annotator", body: action.error, level: "warning" });
    else run(action.command, action.args);
  }

  render() {
    return div();
  }
}
