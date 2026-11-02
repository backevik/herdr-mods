import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_RULES, DAY, ago, isCheckoutPath, parseProbe, pickPr, changed, assess, ruleCounts, rows } from "../mods/worktree-janitor/logic.js";

/** @typedef {import("../mods/worktree-janitor/logic.js").Checkout} Checkout */
/** @typedef {import("../mods/worktree-janitor/logic.js").PullRequest} PullRequest */

const NOW = Date.UTC(2026, 10, 2, 12);
const ROOT = "/home/me/.herdr/worktrees";
const HEAD = "a".repeat(40);

/** @param {Partial<Checkout>} [over] @returns {Checkout} */
function checkout(over = {}) {
  return {
    repo: "app",
    name: "fix-thing",
    path: `${ROOT}/app/fix-thing`,
    registered: true,
    main: "/home/me/src/app",
    branch: "fix/thing",
    head: HEAD,
    at: NOW / 1000 - 3 * DAY,
    unpushed: 0,
    dirty: 0,
    pr: null,
    ...over,
  };
}

/** @param {Partial<PullRequest>} [over] @returns {PullRequest} */
function pr(over = {}) {
  return { number: 7, state: "MERGED", headRefOid: HEAD, url: "https://github.com/o/app/pull/7", ...over };
}

const rules = DEFAULT_RULES;
const notUsed = () => false;

test("merged PR whose head is the local HEAD is safe and purged", () => {
  const a = assess(checkout({ pr: pr() }), rules, false, NOW);
  assert.equal(a.status, "merged");
  assert.equal(a.safe, true);
  assert.equal(a.purge, true);
  assert.deepEqual(a.notes, ["PR #7"]);
});

test("merged PR with local commits the PR doesn't have is not safe", () => {
  const a = assess(checkout({ pr: pr({ headRefOid: "b".repeat(40) }) }), rules, false, NOW);
  assert.equal(a.status, "merged");
  assert.equal(a.safe, false);
  assert.equal(a.purge, false);
  assert.ok(a.notes.includes("local commits differ from the PR"));
});

test("merged PRs are not purged with the merged rule off", () => {
  const a = assess(checkout({ pr: pr() }), { ...rules, merged: false }, false, NOW);
  assert.equal(a.safe, true);
  assert.equal(a.purge, false);
});

test("closed PRs are purged only with the closed rule on", () => {
  const c = checkout({ pr: pr({ state: "CLOSED" }) });
  assert.equal(assess(c, rules, false, NOW).purge, false);
  assert.equal(assess(c, { ...rules, closed: true }, false, NOW).purge, true);
  assert.equal(assess(c, rules, false, NOW).status, "closed");
});

test("an open PR is never safe", () => {
  const a = assess(checkout({ pr: pr({ state: "OPEN" }) }), { ...rules, closed: true, stale: true }, false, NOW);
  assert.equal(a.status, "PR open");
  assert.equal(a.safe, false);
  assert.equal(a.purge, false);
});

test("uncommitted changes win over a merged PR", () => {
  const a = assess(checkout({ pr: pr(), dirty: 3 }), rules, false, NOW);
  assert.equal(a.status, "changes");
  assert.equal(a.purge, false);
  assert.ok(a.notes.includes("3 changed files"));
});

test("in use wins over everything git says", () => {
  const a = assess(checkout({ pr: pr(), dirty: 1 }), rules, true, NOW);
  assert.equal(a.status, "in use");
  assert.equal(a.safe, false);
  assert.equal(a.purge, false);
  assert.ok(a.notes.includes("1 changed file"));
});

test("no PR: safe only with nothing unpushed, purged only when stale and the rule is on", () => {
  const fresh = checkout();
  const old = checkout({ at: NOW / 1000 - 30 * DAY });
  const stale = { ...rules, stale: true };
  assert.equal(assess(fresh, stale, false, NOW).status, "no PR");
  assert.equal(assess(fresh, stale, false, NOW).safe, true);
  assert.equal(assess(fresh, stale, false, NOW).purge, false);
  assert.equal(assess(old, rules, false, NOW).purge, false);
  assert.equal(assess(old, stale, false, NOW).purge, true);
  const unpushed = assess(checkout({ at: old.at, unpushed: 2 }), stale, false, NOW);
  assert.equal(unpushed.safe, false);
  assert.equal(unpushed.purge, false);
  assert.ok(unpushed.notes.includes("2 commits on no remote"));
});

test("detached, not a worktree and a failed PR lookup are never safe", () => {
  const all = { ...rules, closed: true, stale: true };
  assert.equal(assess(checkout({ branch: null }), all, false, NOW).status, "detached");
  const orphan = assess(checkout({ registered: false }), all, false, NOW);
  assert.equal(orphan.status, "not a worktree");
  assert.equal(orphan.safe, false);
  const unknown = assess(checkout({ pr: { error: "gh: not logged in" } }), all, false, NOW);
  assert.equal(unknown.status, "PR unknown");
  assert.deepEqual(unknown.notes, ["gh: not logged in"]);
  assert.equal(unknown.safe, false);
});

test("rule counts match each rule on its own and add up to the purge count", () => {
  const list = [
    checkout({ name: "a", path: `${ROOT}/app/a`, pr: pr() }),
    checkout({ name: "b", path: `${ROOT}/app/b`, pr: pr({ state: "CLOSED" }) }),
    checkout({ name: "c", path: `${ROOT}/app/c`, at: NOW / 1000 - 30 * DAY }),
    checkout({ name: "d", path: `${ROOT}/app/d`, pr: pr(), dirty: 1 }),
  ];
  const all = { ...rules, closed: true, stale: true };
  const counts = ruleCounts(list, all, notUsed, NOW);
  assert.deepEqual(counts, { merged: 1, closed: 1, stale: 1 });
  assert.equal(rows(list, all, notUsed, NOW).filter((r) => r.purge).length, 3);
});

test("rows sort by status, then oldest commit first", () => {
  const list = [
    checkout({ name: "used", path: `${ROOT}/app/used`, pr: pr() }),
    checkout({ name: "new", path: `${ROOT}/app/new`, pr: pr(), at: 200 }),
    checkout({ name: "old", path: `${ROOT}/app/old`, pr: pr(), at: 100 }),
    checkout({ name: "open", path: `${ROOT}/app/open`, pr: pr({ state: "OPEN" }) }),
  ];
  const order = rows(list, rules, (c) => c.name === "used", NOW).map((r) => r.name);
  assert.deepEqual(order, ["old", "new", "open", "used"]);
});

test("pickPr prefers an open PR, else the highest number", () => {
  assert.equal(pickPr([]), null);
  assert.equal(pickPr([pr({ number: 3 }), pr({ number: 9, state: "CLOSED" })])?.number, 9);
  assert.equal(pickPr([pr({ number: 9 }), pr({ number: 4, state: "OPEN" })])?.number, 4);
});

test("parseProbe reads the probe output", () => {
  const f = { repo: "app", name: "fix-thing", path: `${ROOT}/app/fix-thing` };
  const out = [
    `top\t${f.path}`,
    "common\t/home/me/src/app/.git",
    "branch\tfix/thing",
    `head\t${HEAD}`,
    "at\t1760000000",
    "unpushed\t2",
    "dirty\t5",
  ].join("\n");
  assert.deepEqual(parseProbe(f, 0, out), {
    ...f,
    registered: true,
    main: "/home/me/src/app",
    branch: "fix/thing",
    head: HEAD,
    at: 1760000000,
    unpushed: 2,
    dirty: 5,
  });
});

test("parseProbe: a failed probe, a folder inside another repo, or detached HEAD", () => {
  const f = { repo: "app", name: "x", path: `${ROOT}/app/x` };
  assert.equal(parseProbe(f, 4, "").registered, false);
  const nested = parseProbe(f, 0, `top\t/home/me\ncommon\t/home/me/.git\nbranch\tmain\n`);
  assert.equal(nested.registered, false);
  const detached = parseProbe(f, 0, `top\t${f.path}\ncommon\t/home/me/src/app/.git\nbranch\t\nhead\t${HEAD}\n`);
  assert.equal(detached.registered, true);
  assert.equal(detached.branch, null);
});

test("changed spots a cached row git no longer agrees with", () => {
  const c = checkout({ pr: pr() });
  assert.equal(changed(checkout({ pr: null }), c), false);
  assert.equal(changed(checkout({ head: "c".repeat(40) }), c), true);
  assert.equal(changed(checkout({ dirty: 1 }), c), true);
  assert.equal(changed(checkout({ unpushed: 1 }), c), true);
});

test("isCheckoutPath only allows a folder directly in <root>/<repo>/", () => {
  assert.equal(isCheckoutPath(`${ROOT}/app/fix-thing`, ROOT), true);
  assert.equal(isCheckoutPath(`${ROOT}/app`, ROOT), false);
  assert.equal(isCheckoutPath(`${ROOT}/app/fix-thing/frontend`, ROOT), false);
  assert.equal(isCheckoutPath(`${ROOT}/app/..`, ROOT), false);
  assert.equal(isCheckoutPath(`${ROOT}/../other/x`, ROOT), false);
  assert.equal(isCheckoutPath(`${ROOT}-trash/app/x`, ROOT), false);
  assert.equal(isCheckoutPath("/home/me/src/app", ROOT), false);
});

test("ago", () => {
  const s = NOW / 1000;
  assert.equal(ago(0, NOW), "");
  assert.equal(ago(s - 30, NOW), "1m");
  assert.equal(ago(s - 5 * 3600, NOW), "5h");
  assert.equal(ago(s - 40 * DAY, NOW), "40d");
  assert.equal(ago(s - 90 * DAY, NOW), "3mo");
});
