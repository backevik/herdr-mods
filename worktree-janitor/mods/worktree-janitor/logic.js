// The decisions, with no Herdr imports, so they run under `node --test` as well as in
// the app: what a checkout's status is, whether removing it is safe, and which rows
// the purge rules take. main.js gathers the facts (git, gh, live spaces) and acts.

/**
 * @typedef {{ merged: boolean, closed: boolean, stale: boolean, staleDays: number }} Rules
 * @typedef {"merged" | "closed" | "stale"} Rule
 * @typedef {{ repo: string, path: string, name: string }} Folder
 * @typedef {{ number: number, state: "OPEN" | "MERGED" | "CLOSED", headRefOid: string, url: string }} PullRequest
 * @typedef {PullRequest | { error: string } | null} PrLookup
 */
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

export const DAY = 86400;

/** @type {Rules} */
export const DEFAULT_RULES = { merged: true, closed: false, stale: false, staleDays: 14 };

/** @type {Status[]} */
export const ORDER = ["merged", "closed", "no PR", "PR open", "detached", "PR unknown", "changes", "in use", "not a worktree"];

/** @param {string} p @param {string} dir */
export const inside = (p, dir) => p === dir || p.startsWith(dir + "/");

/**
 * "40d", "3h": how long ago, short.
 * @param {number} s unix seconds
 * @param {number} [now] ms since the epoch
 */
export function ago(s, now = Date.now()) {
  if (!s) return "";
  const d = now / 1000 - s;
  return d < 3600 ? `${Math.max(1, Math.round(d / 60))}m` : d < DAY ? `${Math.round(d / 3600)}h` : d < DAY * 60 ? `${Math.round(d / DAY)}d` : `${Math.round(d / DAY / 30)}mo`;
}

/**
 * Only a folder directly in <root>/<repo>/ may be moved or deleted.
 * @param {string} path
 * @param {string} root
 */
export function isCheckoutPath(path, root) {
  if (!path.startsWith(root + "/")) return false;
  const rel = path.slice(root.length + 1).split("/");
  return rel.length === 2 && rel.every((part) => part !== "" && part !== "." && part !== "..");
}

/**
 * Reads the probe script's output: tab-separated key/value lines.
 * A nonzero exit, or a toplevel that isn't the folder, is not a worktree.
 * @param {Folder} f
 * @param {number} code
 * @param {string} stdout
 * @returns {Checkout}
 */
export function parseProbe(f, code, stdout) {
  const folder = { repo: f.repo, path: f.path, name: f.name };
  if (code !== 0) return { ...folder, registered: false, main: "", branch: null, head: null, at: 0, unpushed: 0, dirty: 0 };
  /** @type {Record<string, string>} */
  const v = Object.fromEntries(stdout.trim().split("\n").map((l) => [l.slice(0, l.indexOf("\t")), l.slice(l.indexOf("\t") + 1)]));
  const common = v.common ?? "";
  const main = common.endsWith("/.git") ? common.slice(0, -5) : common;
  return {
    ...folder,
    registered: v.top === f.path && main !== "" && main !== f.path,
    main,
    branch: v.branch || null,
    head: v.head || null,
    at: Number(v.at) || 0,
    unpushed: Number(v.unpushed) || 0,
    dirty: Number(v.dirty) || 0,
  };
}

/**
 * The PR for a branch: an open one if there is one, else the highest number.
 * @param {PullRequest[]} prs
 * @returns {PullRequest | null}
 */
export function pickPr(prs) {
  return prs.find((p) => p.state === "OPEN") ?? [...prs].sort((a, b) => b.number - a.number)[0] ?? null;
}

// What git says about a checkout, without its PR.
/** @type {(keyof Checkout)[]} */
const FIELDS = ["registered", "main", "branch", "head", "unpushed", "dirty"];

/** Git state differs: a cached row is out of date. @param {Checkout} a @param {Checkout} b */
export const changed = (a, b) => FIELDS.some((k) => a[k] !== b[k]);

/**
 * @param {Checkout} c
 * @param {Rules} rules
 * @param {boolean} used a space, pane or live terminal is inside the checkout
 * @param {number} [now] ms since the epoch
 * @returns {Assessment}
 */
export function assess(c, rules, used, now = Date.now()) {
  /** @type {string[]} */
  const notes = [];
  const lookup = c.pr ?? null;
  /** @type {PullRequest | null} */
  const pr = lookup && "number" in lookup ? lookup : null;
  const prError = lookup && "error" in lookup ? lookup.error : null;
  if (c.dirty) notes.push(`${c.dirty} changed file${c.dirty === 1 ? "" : "s"}`);
  if (pr) notes.push(`PR #${pr.number}`);
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
    const old = c.at > 0 && now / 1000 - c.at > rules.staleDays * DAY;
    r = { status: "no PR", tone: "dim", safe: !c.unpushed, purge: !c.unpushed && rules.stale && old };
  }
  if (c.dirty) r = { ...r, status: "changes", tone: "blocked", safe: false, purge: false };
  if (used) r = { ...r, status: "in use", tone: "accent", safe: false, purge: false };
  return { ...r, notes };
}

/**
 * How many checkouts each rule purges on its own. The rules never overlap, so the
 * ticked counts add up to the purge count.
 * @param {Checkout[]} list
 * @param {Rules} rules
 * @param {(c: Checkout) => boolean} used
 * @param {number} [now]
 * @returns {Record<Rule, number>}
 */
export function ruleCounts(list, rules, used, now = Date.now()) {
  /** @param {Rule} key */
  const only = (key) => list.filter((c) => assess(c, { ...rules, merged: false, closed: false, stale: false, [key]: true }, used(c), now).purge).length;
  return { merged: only("merged"), closed: only("closed"), stale: only("stale") };
}

/**
 * Rows in display order: by status, then oldest commit first.
 * @param {Checkout[]} list
 * @param {Rules} rules
 * @param {(c: Checkout) => boolean} used
 * @param {number} [now]
 * @returns {Row[]}
 */
export function rows(list, rules, used, now = Date.now()) {
  return list
    .map((c) => ({ ...c, ...assess(c, rules, used(c), now) }))
    .sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || a.at - b.at || a.name.localeCompare(b.name));
}
