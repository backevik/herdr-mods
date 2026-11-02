// Worktrees under ~/.herdr/worktrees/<repo>/<checkout>, each with a status from its
// PR (gh), its working tree and whether a space or terminal is in it. Remove takes the
// checkout, its folder and its local branch. Purge removes every checkout the rules allow.
//
// Plain JavaScript (herdr-app runs no TypeScript), typed with JSDoc against the app's
// gpui-kit.d.ts. `../../../check.sh` type-checks it.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar } from "gpui-base";
import { exec, home, spaces, panes, terminals, theme, run, notify, props, closeOverlay, shared, setShared } from "herdr";
import * as fs from "fs/promises";

/** @typedef {import("gpui-kit").Context} Context */
/** @typedef {import("gpui-kit").AsyncContext} AsyncContext */
/** @typedef {import("gpui-kit").Color} Color */
/** @typedef {import("gpui-kit").Element} Element */

/** @typedef {{ merged: boolean, closed: boolean, stale: boolean, staleDays: number }} Rules */
/** @typedef {"merged" | "closed" | "stale"} Rule */
/** @typedef {{ repo: string, path: string, name: string }} Folder */
/** @typedef {{ number: number, state: "OPEN" | "MERGED" | "CLOSED", headRefOid: string, url: string }} PullRequest */
/** @typedef {PullRequest | { error: string } | null} PrLookup */
/**
 * What git says about a checkout, and its PR once looked up.
 * @typedef {Folder & {
 *   registered: boolean,
 *   main: string,
 *   branch: string | null,
 *   head: string | null,
 *   at: number,
 *   unpushed: number,
 *   dirty: number,
 *   pr?: PrLookup,
 * }} Checkout
 */
/** @typedef {"merged" | "closed" | "no PR" | "PR open" | "detached" | "PR unknown" | "changes" | "in use" | "not a worktree"} Status */
/** @typedef {"done" | "muted" | "dim" | "working" | "blocked" | "accent"} Tone */
/**
 * status: what the row says. safe: removing loses nothing git can't get back.
 * purge: the rules include it.
 * @typedef {{ status: Status, tone: Tone, safe: boolean, purge: boolean, notes: string[] }} Assessment
 */
/** @typedef {Checkout & Assessment} Row */
/** @typedef {{ at: number, list: Checkout[] }} Cache */

const ROOT = () => `${home()}/.herdr/worktrees`;
// Same volume as ROOT, so moving a checkout here is an instant rename.
const TRASH = () => `${home()}/.herdr/worktrees-trash`;
const RULES = "worktree-janitor.rules";
const CACHE = "worktree-janitor.cache";
/** @type {Rules} */
const DEFAULT_RULES = { merged: true, closed: false, stale: false, staleDays: 14 };
const DAY = 86400;

// One exec per checkout: tab-separated key/value lines. The path is passed as $1.
const PROBE = `
cd "$1" || exit 3
top=$(git rev-parse --show-toplevel 2>/dev/null) || exit 4
printf 'top\\t%s\\n' "$top"
printf 'common\\t%s\\n' "$(git rev-parse --path-format=absolute --git-common-dir)"
printf 'branch\\t%s\\n' "$(git symbolic-ref --short -q HEAD)"
printf 'head\\t%s\\n' "$(git rev-parse -q --verify HEAD)"
printf 'at\\t%s\\n' "$(git log -1 --format=%ct 2>/dev/null)"
printf 'unpushed\\t%s\\n' "$(git rev-list --count HEAD --not --remotes 2>/dev/null)"
printf 'dirty\\t%s\\n' "$(git --no-optional-locks -c core.fsmonitor=false status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
`;

/** @param {string} p @param {string} dir */
const inside = (p, dir) => p === dir || p.startsWith(dir + "/");
/** @param {string} p */
const tilde = (p) => (p.startsWith(home()) ? `~${p.slice(home().length)}` : p);
/** @param {number} s unix seconds */
const ago = (s) => {
  if (!s) return "";
  const d = Date.now() / 1000 - s;
  return d < 3600 ? `${Math.max(1, Math.round(d / 60))}m` : d < DAY ? `${Math.round(d / 3600)}h` : d < DAY * 60 ? `${Math.round(d / DAY)}d` : `${Math.round(d / DAY / 30)}mo`;
};

/** @param {string} cwd @param {string[]} args */
async function git(cwd, args) {
  const r = await exec("git", args, { cwd });
  return { ok: r.code === 0, out: (r.stdout ?? "").trim(), err: (r.stderr || r.stdout || "").trim() };
}

/**
 * Runs fn over items, at most `size` at a time.
 * @template T
 * @param {T[]} items
 * @param {number} size
 * @param {(item: T, i: number) => Promise<void>} fn
 */
async function pool(items, size, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
}

// Deletes everything in TRASH, one rm per checkout at once, detached: it keeps
// going after this returns and when the panel closes. Also finishes earlier runs.
async function sweep() {
  await exec("sh", ["-c", '[ -d "$1" ] || exit 0; (for d in "$1"/*; do [ -e "$d" ] && rm -rf "$d" & done; wait) >/dev/null 2>&1 &', "sweep", TRASH()]);
}

/** @returns {Promise<Folder[]>} */
async function folders() {
  const root = ROOT();
  if (!(await fs.exists(root))) return [];
  /** @type {Folder[]} */
  const out = [];
  for (const repo of await fs.readdir(root, { withFileTypes: true })) {
    if (!repo.isDirectory()) continue;
    for (const dir of await fs.readdir(`${root}/${repo.name}`, { withFileTypes: true })) {
      if (dir.isDirectory()) out.push({ repo: repo.name, path: `${root}/${repo.name}/${dir.name}`, name: dir.name });
    }
  }
  return out;
}

/** @param {Folder} f @returns {Promise<Checkout>} */
async function probe(f) {
  const folder = { repo: f.repo, path: f.path, name: f.name };
  const r = await exec("sh", ["-c", PROBE, "probe", f.path]);
  if (r.code !== 0) return { ...folder, registered: false, main: "", branch: null, head: null, at: 0, unpushed: 0, dirty: 0 };
  /** @type {Record<string, string>} */
  const v = Object.fromEntries(r.stdout.trim().split("\n").map((l) => [l.slice(0, l.indexOf("\t")), l.slice(l.indexOf("\t") + 1)]));
  const main = v.common.endsWith("/.git") ? v.common.slice(0, -5) : v.common;
  return {
    ...folder,
    registered: v.top === f.path && main !== f.path,
    main,
    branch: v.branch || null,
    head: v.head || null,
    at: Number(v.at) || 0,
    unpushed: Number(v.unpushed) || 0,
    dirty: Number(v.dirty) || 0,
  };
}

// What git says about a checkout, without its PR.
/** @type {(keyof Checkout)[]} */
const FIELDS = ["registered", "main", "branch", "head", "unpushed", "dirty"];
/** @param {Checkout} a @param {Checkout} b */
const changed = (a, b) => FIELDS.some((k) => a[k] !== b[k]);

/**
 * The PR for a branch: an open one if there is one, else the newest.
 * @param {Checkout & { branch: string }} c
 * @returns {Promise<PrLookup>}
 */
async function prOf(c) {
  const r = await exec("gh", ["pr", "list", "--head", c.branch, "--state", "all", "--limit", "20", "--json", "number,state,headRefOid,url"], { cwd: c.main });
  if (r.code !== 0) return { error: (r.stderr || r.stdout).trim() || "gh failed" };
  /** @type {PullRequest[]} */
  const prs = JSON.parse(r.stdout || "[]");
  return prs.find((p) => p.state === "OPEN") ?? prs.sort((a, b) => b.number - a.number)[0] ?? null;
}

/** @param {Checkout} c */
function inUse(c) {
  /** @type {(string | null | undefined)[]} */
  const where = [
    ...spaces().map((s) => s.folder),
    ...panes().map((p) => p.cwd),
    ...terminals().filter((t) => t.state !== "finished").map((t) => t.cwd),
  ];
  return where.some((f) => f && inside(f, c.path));
}

/** @param {Checkout} c @param {Rules} rules @returns {Assessment} */
function assess(c, rules) {
  /** @type {string[]} */
  const notes = [];
  const lookup = c.pr ?? null;
  /** @type {PullRequest | null} */
  const pr = lookup && "number" in lookup ? lookup : null;
  const prError = lookup && "error" in lookup ? lookup.error : null;
  if (c.dirty) notes.push(`${c.dirty} changed file${c.dirty === 1 ? "" : "s"}`);
  if (pr) notes.push(`PR #${pr.number}`);
  const used = inUse(c);
  if (!c.registered) return { status: "not a worktree", tone: "blocked", safe: false, purge: false, notes: ["git doesn't track this folder"] };
  if (!c.branch) return { status: "detached", tone: "muted", safe: false, purge: false, notes };
  if (prError) return { status: "PR unknown", tone: "blocked", safe: false, purge: false, notes: [prError] };
  /** @type {Omit<Assessment, "notes">} */
  let r;
  if (pr && pr.state !== "OPEN") {
    const same = c.head === pr.headRefOid;
    if (!same) notes.push("local commits differ from the PR");
    const merged = pr.state === "MERGED";
    r = { status: merged ? "merged" : "closed", tone: merged ? "done" : "muted", safe: same, purge: same && (merged ? rules.merged : rules.closed) };
  } else if (pr) {
    r = { status: "PR open", tone: "working", safe: false, purge: false };
  } else {
    if (c.unpushed) notes.push(`${c.unpushed} commit${c.unpushed === 1 ? "" : "s"} on no remote`);
    const old = c.at > 0 && Date.now() / 1000 - c.at > rules.staleDays * DAY;
    r = { status: "no PR", tone: "dim", safe: !c.unpushed, purge: !c.unpushed && rules.stale && old };
  }
  if (c.dirty) r = { ...r, status: "changes", tone: "blocked", safe: false, purge: false };
  if (used) r = { ...r, status: "in use", tone: "accent", safe: false, purge: false };
  return { ...r, notes };
}

/** @type {Status[]} */
const ORDER = ["merged", "closed", "no PR", "PR open", "detached", "PR unknown", "changes", "in use", "not a worktree"];

export default class WorktreeJanitor extends View {
  /** @param {unknown} _props @param {AsyncContext} cx */
  init(_props, cx) {
    /** @type {Checkout[]} */
    this.list = [];
    /** Last full check, ms since the epoch; 0 before the first. */
    this.checkedAt = 0;
    this.loading = false;
    this.progress = "";
    this.error = "";
    /** @type {string | null} a row's path, or "purge" */
    this.confirm = null;
    /** @type {string | null} a row's path, or "purge" */
    this.busy = null;
    const cache = /** @type {Cache | undefined} */ (shared(CACHE));
    if (cache?.list) {
      this.list = cache.list;
      this.checkedAt = cache.at;
      this.refresh(cx, { onlyNew: true });
    } else {
      this.refresh(cx);
    }
    // Keeps "checked 5m ago" current.
    cx.timer.every(30000, (cx) => cx.notify());
    // Finishes deleting folders an earlier removal left in TRASH.
    cx.spawn(async () => sweep());
  }

  save() {
    setShared(CACHE, /** @type {Cache} */ ({ at: this.checkedAt, list: this.list }));
  }

  /** @returns {Rules} */
  rules() {
    return { ...DEFAULT_RULES, .../** @type {Partial<Rules> | undefined} */ (shared(RULES)) };
  }

  /** @param {Rule} key @param {boolean} value */
  setRule(key, value) {
    setShared(RULES, { ...this.rules(), [key]: value });
    this.confirm = null;
  }

  /**
   * Checks every checkout, or with onlyNew, only folders the cache doesn't have yet
   * (and drops the ones that are gone). The cache's age is that of the last full check.
   * @param {Context} cx
   */
  refresh(cx, { onlyNew = false } = {}) {
    if (this.loading) return;
    this.loading = true;
    this.error = "";
    this.confirm = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const all = await folders();
        const known = new Map(onlyNew ? this.list.map((c) => [c.path, c]) : []);
        const found = all.filter((f) => !known.has(f.path));
        /** @type {Checkout[]} */
        const list = all.filter((f) => known.has(f.path)).map((f) => /** @type {Checkout} */ (known.get(f.path)));
        let done = 0;
        this.progress = `checking 0/${found.length}`;
        cx.notify();
        await pool(found, 6, async (f) => {
          const c = await probe(f);
          if (c.registered && c.branch) c.pr = await prOf({ ...c, branch: c.branch });
          list.push(c);
          this.progress = `checking ${++done}/${found.length}`;
          cx.notify();
        });
        this.list = list;
        if (!onlyNew || !this.checkedAt) this.checkedAt = Date.now();
        this.save();
      } catch (error) {
        this.error = String(error);
      }
      this.loading = false;
      this.progress = "";
      cx.notify();
    });
  }

  /** @returns {Row[]} */
  rows() {
    const rules = this.rules();
    return this.list
      .map((c) => ({ ...c, ...assess(c, rules) }))
      .sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || a.at - b.at || a.name.localeCompare(b.name));
  }

  /** @param {Checkout} c */
  open(c) {
    closeOverlay(props().overlay);
    const s = spaces().find((s) => s.folder && inside(s.folder, c.path));
    if (s) run("space.select", { id: s.id });
    else run("space.new", { folder: c.path });
  }

  /**
   * Checks the checkout again first: the row may be from an old cache. If git
   * says something else now, the row is updated and nothing is removed.
   * Then closes what's in the checkout, moves its folder to TRASH, lets git forget
   * it and deletes its local branch. The folder itself is deleted by sweep().
   * @param {Row} c
   * @returns {Promise<string>} an error, or ""
   */
  async remove(c) {
    const now = await probe(c);
    if (changed(now, c)) {
      this.list = this.list.map((x) => (x.path === c.path ? { ...now, pr: x.pr } : x));
      this.save();
      return "changed since it was checked, look again";
    }
    const rel = c.path.slice(ROOT().length + 1).split("/");
    if (!c.path.startsWith(ROOT() + "/") || rel.length !== 2 || rel.includes("..")) return "refusing to touch a folder outside the worktrees folder";
    for (const s of spaces()) {
      const tabs = new Set(s.tabs.map((t) => t.id));
      const there = [s.folder, ...panes().filter((p) => tabs.has(p.tab)).map((p) => p.cwd)];
      if (there.some((f) => f && inside(f, c.path))) run("space.close", { id: s.id, confirmed: true });
    }
    for (const t of terminals()) if (t.state !== "finished" && t.cwd && inside(t.cwd, c.path)) run("terminal.kill", { terminal: t.address });
    const dest = `${TRASH()}/${c.repo}-${c.name}-${Date.now()}`;
    const mv = await exec("sh", ["-c", 'mkdir -p "$1" && mv "$2" "$3"', "mv", TRASH(), c.path, dest]);
    if (mv.code !== 0) return mv.stderr.trim() || "couldn't move the folder";
    if (c.registered) {
      // The folder is gone, so git only drops its record of the checkout.
      const r = await git(c.main, ["worktree", "remove", "--force", c.path]);
      if (!r.ok) {
        await exec("mv", [dest, c.path]);
        return r.err || "git worktree remove failed";
      }
    }
    this.list = this.list.filter((x) => x.path !== c.path);
    this.save();
    if (c.registered && c.branch) {
      const r = await git(c.main, ["branch", "-D", c.branch]);
      if (!r.ok) return `checkout removed, branch kept: ${r.err}`;
    }
    return "";
  }

  /** @param {Row} c @param {Context} cx */
  removeRow(c, cx) {
    if (this.busy) return;
    if (!c.safe && this.confirm !== c.path) {
      this.confirm = c.path;
      return cx.notify();
    }
    this.confirm = null;
    this.busy = c.path;
    cx.notify();
    cx.spawn(async (cx) => {
      const err = await this.remove(c);
      await sweep();
      this.busy = null;
      if (err) this.error = `${c.name}: ${err}`;
      cx.notify();
    });
  }

  /** @param {Context} cx */
  purge(cx) {
    const targets = this.rows().filter((c) => c.purge);
    if (this.busy || !targets.length) return;
    if (this.confirm !== "purge") {
      this.confirm = "purge";
      return cx.notify();
    }
    this.confirm = null;
    this.busy = "purge";
    cx.notify();
    cx.spawn(async (cx) => {
      // One after another: they are quick now, and git locks the branch refs.
      /** @type {string[]} */
      const failed = [];
      for (const c of targets) {
        const err = await this.remove(c);
        if (err) failed.push(`${c.name}: ${err}`);
        cx.notify();
      }
      await sweep();
      this.busy = null;
      this.error = failed.join("\n");
      const removed = targets.length - failed.length;
      notify({
        title: `Removed ${removed} worktree${removed === 1 ? "" : "s"}`,
        body: failed.length ? `${failed.length} failed` : "Disk space frees up in the background.",
        level: failed.length ? "warning" : "success",
      });
      cx.notify();
    });
  }

  render() {
    // herdr.d.ts types theme colors as plain strings; they are always hex.
    const t = /** @type {Record<string, Color>} */ (theme());
    const rules = this.rules();
    const rows = this.rows();
    const purgeable = rows.filter((c) => c.purge).length;
    // How many each rule purges on its own (the rules never overlap).
    /** @param {Rule} key */
    const only = (key) => this.list.filter((c) => assess(c, { ...rules, merged: false, closed: false, stale: false, [key]: true }).purge).length;
    const matches = { merged: only("merged"), closed: only("closed"), stale: only("stale") };

    /**
     * @param {string} id
     * @param {string | Element} label
     * @param {(cx: Context) => void} onClick
     * @param {{ tone?: Tone, disabled?: boolean }} [opts]
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
        .border_color(tone ? t[tone] : t.border)
        .text_size(12)
        .text_color(disabled ? t.dim : tone ? t[tone] : t.foreground)
        .when(!disabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => onClick(cx)))
        .child(label);

    /** @param {string} label */
    const working = (label) =>
      h_flex().gap(6).items_center().child(svg("mods/worktree-janitor/spinner.svg").w(12).h(12).text_color(t.muted).spin(900)).child(label);

    /** @param {string} id @param {string} label @param {boolean} on @param {() => void} onClick */
    const toggle = (id, label, on, onClick) =>
      h_flex()
        .id(id)
        .gap(6)
        .items_center()
        .cursor_pointer()
        .text_color(on ? t.foreground : t.muted)
        .on_click((_e, cx) => { onClick(); cx.notify(); })
        .child(div().w(14).h(14).rounded(3).border(1).border_color(on ? t.accent : t.input).when(on, (el) => el.bg(t.accent)))
        .child(label);

    /** @param {Row} c */
    const row = (c) => {
      const confirming = this.confirm === c.path;
      const busy = this.busy === c.path;
      return h_flex()
        .id(`wt-${c.path}`)
        .flex_none()
        .gap(10)
        .px(10)
        .py(6)
        .items_center()
        .rounded(6)
        .hover((s) => s.bg(t.hover))
        .child(div().flex_none().w(96).text_size(12).text_color(t[c.tone]).child(`${c.purge ? "● " : ""}${c.status}`))
        .child(
          v_flex()
            .flex_1()
            .min_w(0)
            .child(div().truncate().text_color(t.foreground).child(c.branch ?? c.name))
            .child(div().truncate().text_size(11.5).text_color(confirming ? t.blocked : t.dim).child(
              confirming
                ? `Not safe: ${[...c.notes, c.status === "in use" ? "closes its spaces and terminals" : null].filter(Boolean).join(", ") || c.status}. Click again to remove.`
                : [c.repo, ...c.notes].join(" · "),
            )),
        )
        .child(div().flex_none().w(40).text_size(11.5).text_color(t.dim).child(ago(c.at)))
        .child(button(`open-${c.path}`, "open", () => this.open(c), { disabled: !c.registered }))
        .child(button(`rm-${c.path}`, busy ? working("removing…") : confirming ? "Are you sure?" : "remove", (cx) => this.removeRow(c, cx), { tone: confirming || !c.safe ? "blocked" : undefined, disabled: Boolean(this.busy) }));
    };

    return v_flex()
      .id("worktree-janitor")
      .size_full()
      .p(16)
      .gap(12)
      .bg(t.popover)
      .text_size(13)
      .child(
        h_flex()
          .gap(10)
          .items_center()
          .child(div().font_semibold().text_color(t.foreground).child("Worktrees"))
          .child(div().flex_1().text_size(12).text_color(t.dim).child(`${this.list.length} in ${tilde(ROOT())}`))
          .child(
            v_flex()
              .flex_none()
              .items_end()
              .gap(2)
              .child(button("refresh", this.loading ? this.progress || "checking…" : "refresh", (cx) => this.refresh(cx), { disabled: this.loading || Boolean(this.busy) }))
              .when(this.checkedAt > 0, (el) =>
                el.child(div().text_size(11).text_color(t.dim).child(Date.now() - this.checkedAt < 60000 ? "checked just now" : `checked ${ago(this.checkedAt / 1000)} ago`)),
              ),
          ),
      )
      .child(
        h_flex()
          .gap(16)
          .items_center()
          .text_size(12)
          .child(div().text_color(t.dim).child("Purge removes"))
          .child(toggle("rule-merged", `merged PRs (${matches.merged})`, rules.merged, () => this.setRule("merged", !rules.merged)))
          .child(toggle("rule-closed", `closed PRs (${matches.closed})`, rules.closed, () => this.setRule("closed", !rules.closed)))
          .child(toggle("rule-stale", `no PR, nothing unpushed, older than ${rules.staleDays}d (${matches.stale})`, rules.stale, () => this.setRule("stale", !rules.stale)))
          .child(div().flex_1())
          .child(button(
            "purge",
            this.busy === "purge" ? working("Removing…") : this.confirm === "purge" ? "Are you sure?" : `purge ${purgeable}`,
            (cx) => this.purge(cx),
            { tone: this.confirm === "purge" ? "blocked" : "accent", disabled: this.loading || Boolean(this.busy) || purgeable === 0 },
          )),
      )
      .child(div().mt(-6).text_size(11.5).text_color(this.busy ? t.blocked : t.dim).child(
        this.busy ? "Removing. Don't close this panel until it's done." : "Never purged: in use, uncommitted changes, local commits the PR doesn't have, or commits on no remote.",
      ))
      .child(
        div()
          .relative()
          .flex_1()
          .min_h(0)
          .child(
            v_flex()
              .id("wt-list")
              .size_full()
              .overflow_y_scroll()
              .children(rows.map(row))
              .when(rows.length === 0, (el) => el.child(div().p(10).text_color(t.dim).child(this.loading ? "…" : "No worktrees."))),
          )
          .child(Scrollbar.vertical("wt-list").absolute().inset_0()),
      )
      .when(Boolean(this.error), (el) => el.child(div().text_size(12).text_color(t.blocked).child(this.error)))
      .child(h_flex().justify_end().text_size(11).text_color(t.dim).child("● purged by the rules · esc close"));
  }
}
