// Plan usage for Claude, Cursor and OpenCode, from the logins their CLIs already have.
// Two views of one mod: `props().view === "bar"` is the compact status-bar strip (it owns
// the polling), anything else is the dialog (`mod.open:plan-usage`).
//
// Plain JavaScript (herdr-app runs no TypeScript), typed with JSDoc against the app's
// gpui-kit.d.ts. providers.js reads logins and calls the endpoints; logic.js decides.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar } from "gpui-base";
import { theme, run, props, closeOverlay, shared, setShared } from "herdr";
import { PROVIDERS, readAll } from "./providers.js";
import { tightest, mostRoom, level, until, ago, merge, stale, WARN } from "./logic.js";

/** @typedef {import("gpui-kit").Context} Context */
/** @typedef {import("gpui-kit").Color} Color */
/** @typedef {import("gpui-kit").Element} Element */
/** @typedef {import("./logic.js").Usage} Usage */
/** @typedef {import("./logic.js").Meter} Meter */
/** @typedef {import("./logic.js").Level} Level */
/** @typedef {{ at: number, list: Usage[] }} Cache */

// Numbers only, never tokens: shared values are persisted to shared.json.
const CACHE = "plan-usage.cache";
const MIN = 60000;
// The bar refreshes at most this often; Claude's endpoint rate-limits hard polling.
const BAR_MAX_AGE = 5 * MIN;
// Opening the dialog refreshes numbers older than this.
const DIALOG_MAX_AGE = 1 * MIN;

/** @returns {Cache | undefined} */
const cache = () => /** @type {Cache | undefined} */ (shared(CACHE));

/** @param {Record<string, Color>} t @param {Level} l @returns {Color} */
const levelColor = (t, l) => (l === "high" ? t.ansi1 : l === "warn" ? t.ansi3 : t.ansi2);

export default class PlanUsage extends View {
  /** @param {unknown} _props @param {Context} cx */
  init(_props, cx) {
    this.bar = props()?.view === "bar";
    this.loading = false;
    if (stale(cache(), Date.now(), this.bar ? BAR_MAX_AGE : DIALOG_MAX_AGE)) this.refresh(cx);
    // Bar: checks once a minute whether the numbers are due. Dialog: keeps "resets in" current.
    cx.timer.every(MIN, (cx) => {
      if (this.bar && stale(cache(), Date.now(), BAR_MAX_AGE)) this.refresh(cx);
      else cx.notify();
    });
  }

  /** @param {Context} cx */
  refresh(cx) {
    if (this.loading) return;
    this.loading = true;
    cx.notify();
    cx.spawn(async (cx) => {
      const prev = new Map((cache()?.list ?? []).map((u) => [u.id, u]));
      const now = Date.now();
      const list = (await readAll(now)).map((u) => merge(prev.get(u.id), u));
      setShared(CACHE, /** @type {Cache} */ ({ at: now, list }));
      this.loading = false;
      cx.notify();
    });
  }

  /** @param {string} id */
  login(id) {
    const p = PROVIDERS.find((p) => p.id === id);
    if (!p) return;
    if (!this.bar) closeOverlay(props().overlay);
    run("tab.new", { name: `${p.name} login`, argv: p.login });
  }

  render() {
    // herdr.d.ts types theme colors as plain strings; they are always hex.
    const t = /** @type {Record<string, Color>} */ (theme());
    return this.bar ? this.renderBar(t) : this.renderDialog(t);
  }

  /** @param {Record<string, Color>} t */
  renderBar(t) {
    const list = (cache()?.list ?? []).filter((u) => u.state !== "none");
    /** @param {Usage} u */
    const item = (u) => {
      const m = u.state === "ok" ? tightest(u.meters) : null;
      const value = m
        ? div().text_color(levelColor(t, level(m.percent))).child(`${Math.round(m.percent)}%`)
        : div().text_color(u.state === "login" ? t.dim : t.blocked).child(u.state === "login" ? "log in" : "!");
      return h_flex().gap(4).items_center().child(div().text_color(t.dim).child(u.name)).child(value);
    };
    return h_flex()
      .id("plan-usage-bar")
      .size_full()
      .px(14)
      .gap(12)
      .items_center()
      .justify_end()
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(11.8)
      .text_color(t.muted)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click(() => run("mod.open", { name: "plan-usage" }))
      .child(svg(this.loading ? "mods/workspace-chrome/spinner.svg" : "mods/workspace-chrome/clock.svg").flex_none().size(13).text_color(t.muted).when(this.loading, (el) => el.spin(900)))
      .when(list.length === 0, (el) => el.child(div().text_color(t.dim).child("plan usage")))
      .children(list.map(item));
  }

  /** @param {Record<string, Color>} t */
  renderDialog(t) {
    const c = cache();
    const list = c?.list ?? [];
    const now = Date.now();
    const best = mostRoom(list);

    /**
     * @param {string} id
     * @param {string | Element} label
     * @param {(cx: Context) => void} onClick
     * @param {{ tone?: Color, disabled?: boolean }} [opts]
     */
    const button = (id, label, onClick, { tone, disabled } = {}) =>
      h_flex()
        .id(id)
        .flex_none()
        .h(26)
        .px(10)
        .items_center()
        .rounded(6)
        .border(1)
        .border_color(tone ?? t.border)
        .text_size(12)
        .text_color(disabled ? t.dim : tone ?? t.foreground)
        .when(!disabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => onClick(cx)))
        .child(label);

    /** @param {Meter} m @param {string} key */
    const meter = (m, key) => {
      const color = m.counts ? levelColor(t, level(m.percent)) : t.muted;
      const reset = until(m.resetsAt, now);
      return h_flex()
        .id(key)
        .flex_none()
        .gap(12)
        .items_center()
        .child(div().flex_none().w(130).truncate().text_color(m.counts ? t.foreground : t.muted).child(m.label))
        .child(
          div()
            .flex_1()
            .h(6)
            .rounded(3)
            .bg(t.border)
            .child(div().h_full().rounded(3).bg(color).w(`${Math.min(100, Math.max(m.percent > 0 ? 2 : 0, m.percent))}%`)),
        )
        .child(div().flex_none().w(90).text_size(12).text_color(color).child(m.note ?? `${Math.round(m.percent)}% used`))
        .child(div().flex_none().w(96).text_size(11.5).text_color(t.dim).child(reset ? (reset === "now" ? "resets now" : `resets in ${reset}`) : ""));
    };

    /** @param {Usage} u */
    const section = (u) =>
      v_flex()
        .id(`p-${u.id}`)
        .flex_none()
        .gap(8)
        .p(12)
        .rounded(8)
        .border(1)
        .border_color(t.border)
        .child(
          h_flex()
            .gap(8)
            .items_center()
            .child(div().font_semibold().text_color(t.foreground).child(u.name))
            .when(Boolean(u.plan), (el) => el.child(div().text_size(12).text_color(t.dim).child(u.plan ?? "")))
            .child(div().flex_1())
            .when(Boolean(u.message), (el) =>
              el.child(div().truncate().text_size(12).text_color(u.state === "error" || (u.state === "ok" && u.message) ? t.blocked : t.muted).child(u.message)),
            )
            .when(u.state === "ok" && now - u.checkedAt >= 2 * MIN, (el) => el.child(div().text_size(11.5).text_color(t.dim).child(ago(u.checkedAt, now))))
            .when(u.state === "login", (el) => el.child(button(`login-${u.id}`, "Log in", () => this.login(u.id), { tone: t.accent }))),
        )
        .children(u.meters.map((m, i) => meter(m, `m-${u.id}-${i}`)));

    return v_flex()
      .id("plan-usage")
      .size_full()
      .p(16)
      .gap(12)
      .bg(t.popover)
      .text_size(13)
      .child(
        h_flex()
          .gap(10)
          .items_center()
          .child(div().font_semibold().text_color(t.foreground).child("Plan usage"))
          .child(
            div().flex_1().truncate().text_size(12).text_color(t.dim).child(
              best ? `Most room: ${best.usage.name}, ${best.meter.label.toLowerCase()} at ${Math.round(best.meter.percent)}%` : "",
            ),
          )
          .when(Boolean(c), (el) => el.child(div().text_size(11).text_color(t.dim).child(`checked ${ago(c?.at ?? now, now)}`)))
          .child(button("refresh", this.loading ? "checking…" : "refresh", (cx) => this.refresh(cx), { disabled: this.loading })),
      )
      .child(
        div()
          .relative()
          .flex_1()
          .min_h(0)
          .child(
            v_flex()
              .id("pu-list")
              .size_full()
              .gap(10)
              .overflow_y_scroll()
              .children(list.map(section))
              .when(list.length === 0, (el) => el.child(div().p(10).text_color(t.dim).child(this.loading ? "Checking…" : "Nothing yet."))),
          )
          .child(Scrollbar.vertical("pu-list").absolute().inset_0()),
      )
      .child(h_flex().justify_end().text_size(11).text_color(t.dim).child(`yellow from ${WARN}% · esc close`));
  }
}
