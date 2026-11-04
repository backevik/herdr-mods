// What the key does, decided from live facts. No herdr or gpui imports, so node --test runs it.

/** The mod this launcher opens. */
export const TARGET = "annotator";

/**
 * @typedef {{ space: string, tab: string, pane: string | null }} Focus
 * @typedef {{ pane: string, tab: string, mod?: string, focused: boolean }} Pane
 * @typedef {{ command: string, args: Record<string, unknown> } | { error: string }} Action
 */

/**
 * Toggles Annotator in the focused tab: opens it to the right, focuses it when it is
 * open elsewhere in the tab, closes it when it has focus.
 * @param {Focus | null} focus
 * @param {Pane[]} panes
 * @returns {Action}
 */
export function decide(focus, panes) {
  if (!focus?.tab) return { error: "No tab to open Annotator in" };
  const inTab = panes.filter((p) => p.tab === focus.tab);
  const open = inTab.find((p) => p.mod === TARGET);
  if (open) {
    return open.focused || open.pane === focus.pane
      ? { command: "pane.close", args: { pane: open.pane } }
      : { command: "pane.focus", args: { pane: open.pane } };
  }
  // A focused layout terminal block has no pane; split the tab's first one instead.
  const beside = focus.pane ?? inTab[0]?.pane;
  if (!beside) return { error: "No pane to open Annotator beside" };
  return { command: "pane.split", args: { direction: "right", pane: beside, mod: TARGET } };
}
