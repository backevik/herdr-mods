import { test } from "node:test";
import assert from "node:assert/strict";
import { decide } from "../mods/annotator-open/logic.js";

/** @typedef {import("../mods/annotator-open/logic.js").Pane} Pane */

const focus = { space: "s1", tab: "t1", pane: "p1" };
/** @type {Pane} */
const shell = { pane: "p1", tab: "t1", focused: true };

test("opens Annotator to the right of the focused pane", () => {
  assert.deepEqual(decide(focus, [shell]), { command: "pane.split", args: { direction: "right", pane: "p1", mod: "annotator" } });
});

test("ignores Annotator panes in other tabs", () => {
  const other = { pane: "p9", tab: "t2", mod: "annotator", focused: false };
  assert.equal(/** @type {any} */ (decide(focus, [shell, other])).command, "pane.split");
});

test("focuses an open Annotator pane that lacks focus", () => {
  const open = { pane: "p2", tab: "t1", mod: "annotator", focused: false };
  assert.deepEqual(decide(focus, [shell, open]), { command: "pane.focus", args: { pane: "p2" } });
});

test("closes Annotator when it has focus", () => {
  const open = { pane: "p2", tab: "t1", mod: "annotator", focused: true };
  assert.deepEqual(decide({ ...focus, pane: "p2" }, [{ ...shell, focused: false }, open]), { command: "pane.close", args: { pane: "p2" } });
});

test("splits the tab's first pane when a layout block holds focus", () => {
  assert.deepEqual(decide({ ...focus, pane: null }, [{ ...shell, focused: false }]), { command: "pane.split", args: { direction: "right", pane: "p1", mod: "annotator" } });
});

test("reports when there is no tab or pane", () => {
  assert.ok("error" in decide(null, []));
  assert.ok("error" in decide({ ...focus, pane: null }, []));
});
