import { test } from "node:test";
import assert from "node:assert/strict";
import {
  base64Decode, jwtPayload, openCodeCredential, claudeCredential, cursorCredential, httpState,
  openCodeMeters, claudeMeters, cursorMeters, tightest, mostRoom, level, until, ago, merge, stale,
} from "../mods/plan-usage/logic.js";

/** @typedef {import("../mods/plan-usage/logic.js").Usage} Usage */
/** @typedef {import("../mods/plan-usage/logic.js").Meter} Meter */

const NOW = Date.UTC(2026, 10, 5, 9);
const HOUR = 3600000;

/** @param {object} payload */
const jwt = (payload) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;

/** @param {Partial<Usage>} over @returns {Usage} */
const usage = (over) => ({ id: "x", name: "X", plan: null, state: "ok", message: "", meters: [], checkedAt: NOW, ...over });

/** @param {string} label @param {number} percent @param {boolean} [counts] @returns {Meter} */
const meter = (label, percent, counts = true) => ({ label, percent, resetsAt: null, counts });

test("base64Decode handles base64url without padding", () => {
  const s = '{"sub":"google-oauth2|user_1","n":"å"}';
  assert.equal(base64Decode(Buffer.from(s).toString("base64url")), s);
  assert.equal(base64Decode("not*base64"), null);
});

test("jwtPayload reads the middle part, null otherwise", () => {
  assert.deepEqual(jwtPayload(jwt({ sub: "a", exp: 1 })), { sub: "a", exp: 1 });
  assert.equal(jwtPayload("plain-token"), null);
});

test("openCodeCredential: oauth, api key, expired, missing", () => {
  assert.deepEqual(openCodeCredential(JSON.stringify({ type: "oauth", access: "a", expires: NOW + HOUR, metadata: { orgID: "wrk_1" } }), NOW), { token: "a", org: "wrk_1" });
  assert.deepEqual(openCodeCredential(JSON.stringify({ type: "api", key: "k" }), NOW), { token: "k", org: undefined });
  assert.equal(/** @type {any} */ (openCodeCredential(JSON.stringify({ type: "oauth", access: "a", expires: NOW - 1 }), NOW)).state, "login");
  assert.equal(/** @type {any} */ (openCodeCredential(null, NOW)).state, "login");
  assert.equal(/** @type {any} */ (openCodeCredential("garbage", NOW)).state, "login");
});

test("claudeCredential picks the copy that expires last", () => {
  const old = JSON.stringify({ claudeAiOauth: { accessToken: "old", expiresAt: NOW - HOUR } });
  const fresh = JSON.stringify({ claudeAiOauth: { accessToken: "new", expiresAt: NOW + HOUR, subscriptionType: "max", scopes: ["user:profile"] } });
  assert.deepEqual(claudeCredential([old, fresh], NOW), { token: "new", plan: "max" });
  assert.equal(/** @type {any} */ (claudeCredential([old, null], NOW)).state, "login");
  assert.equal(/** @type {any} */ (claudeCredential([null, null], NOW)).state, "login");
});

test("claudeCredential refuses an inference-only token", () => {
  const t = JSON.stringify({ claudeAiOauth: { accessToken: "a", expiresAt: NOW + HOUR, scopes: ["user:inference"] } });
  assert.match(/** @type {any} */ (claudeCredential([t], NOW)).message, /can't read usage/);
});

test("cursorCredential builds the session cookie from sub after the pipe", () => {
  const token = jwt({ sub: "google-oauth2|user_01ABC", exp: NOW / 1000 + 3600 });
  assert.deepEqual(cursorCredential(token, NOW), { token: `WorkosCursorSessionToken=user_01ABC%3A%3A${token}` });
  assert.equal(/** @type {any} */ (cursorCredential(jwt({ sub: "a|b", exp: NOW / 1000 - 1 }), NOW)).state, "login");
  assert.equal(/** @type {any} */ (cursorCredential(null, NOW)).state, "login");
  assert.equal(/** @type {any} */ (cursorCredential("nope", NOW)).state, "error");
});

test("httpState maps statuses", () => {
  assert.equal(httpState(200), null);
  assert.equal(httpState(403, 403)?.state, "none");
  assert.equal(httpState(403)?.state, "login");
  assert.equal(httpState(401)?.state, "login");
  assert.equal(httpState(429)?.state, "error");
  assert.equal(httpState(500)?.message, "HTTP 500");
});

test("openCodeMeters reads rolling, weekly and monthly", () => {
  const m = openCodeMeters({
    usage: {
      rolling: { status: "ok", percent: 4, resetsAt: "2026-11-05T11:36:57.000Z" },
      weekly: { status: "ok", percent: 47, resetsAt: "2026-11-09T00:00:00.000Z" },
      monthly: { status: "rate-limited", percent: 100, resetsAt: "2026-12-05T08:36:39.000Z" },
    },
  });
  assert.deepEqual(m.map((x) => [x.label, x.percent]), [["5-hour window", 4], ["Weekly", 47], ["Monthly", 100]]);
  assert.equal(m[2].note, "limit reached");
  assert.deepEqual(openCodeMeters({}), []);
});

test("claudeMeters reads named windows, scoped limits and extra usage", () => {
  const m = claudeMeters({
    five_hour: { utilization: 12, resets_at: "2026-11-05T12:00:00Z" },
    seven_day: { utilization: 40, resets_at: "2026-11-10T00:00:00Z" },
    seven_day_opus: null,
    seven_day_sonnet: { utilization: 5, resets_at: null },
    limits: [
      { kind: "weekly_scoped", percent: 70, resets_at: "2026-11-10T00:00:00Z", scope: { model: { display_name: "Opus" } } },
      { kind: "weekly_scoped", percent: 1, scope: { model: { display_name: "Sonnet" } } },
      { kind: "other", percent: 99 },
    ],
    extra_usage: { is_enabled: true, utilization: 30 },
  });
  assert.deepEqual(m.map((x) => [x.label, x.percent, x.counts]), [
    ["5-hour window", 12, true],
    ["Weekly", 40, true],
    ["Weekly Sonnet", 5, true],
    ["Weekly Opus", 70, true],
    ["Extra usage", 30, false],
  ]);
});

test("cursorMeters reads plan, on-demand and Grok Bot", () => {
  const { plan, meters } = cursorMeters(
    {
      billingCycleEnd: "2026-11-12T06:42:45.000Z",
      membershipType: "pro",
      individualUsage: {
        plan: { enabled: true, autoPercentUsed: 58.07, apiPercentUsed: 0 },
        onDemand: { enabled: true, used: 250, limit: 1000 },
      },
    },
    { usagePercent: 3, nextResetTimestampUtc: "2026-11-11T12:06:00.228Z", hasNonZeroIncludedLimit: true },
  );
  assert.equal(plan, "Pro");
  assert.deepEqual(meters.map((x) => [x.label, Math.round(x.percent), x.counts, x.note]), [
    ["Cursor models", 58, true, undefined],
    ["Other models", 0, true, undefined],
    ["On-demand", 25, false, "$2.50 / $10"],
    ["Grok Bot weekly", 3, false, undefined],
  ]);
});

test("cursorMeters: unlimited on-demand, no Grok Bot", () => {
  const { meters } = cursorMeters({ individualUsage: { plan: { autoPercentUsed: 1, apiPercentUsed: 2 }, onDemand: { enabled: true, used: 0, limit: null } } }, null);
  assert.equal(meters.find((m) => m.label === "On-demand")?.note, "$0, no limit");
  assert.equal(meters.some((m) => m.label.startsWith("Grok")), false);
});

test("tightest ignores meters that don't count", () => {
  assert.equal(tightest([meter("a", 10), meter("b", 60), meter("od", 99, false)])?.label, "b");
  assert.equal(tightest([meter("od", 99, false)]), null);
});

test("mostRoom compares the tightest meter of fresh providers", () => {
  const list = [
    usage({ id: "a", meters: [meter("w", 64)] }),
    usage({ id: "b", meters: [meter("w", 58), meter("x", 0)] }),
    usage({ id: "c", state: "login" }),
  ];
  assert.equal(mostRoom(list)?.usage.id, "b");
  assert.equal(mostRoom([usage({ state: "error" })]), null);
});

test("level thresholds", () => {
  assert.equal(level(79.9), "ok");
  assert.equal(level(80), "warn");
  assert.equal(level(95), "high");
});

test("until formats days, hours and minutes", () => {
  const at = (/** @type {number} */ ms) => new Date(NOW + ms).toISOString();
  assert.equal(until(at(3 * HOUR + 9 * 60000), NOW), "3h 9m");
  assert.equal(until(at(87 * HOUR), NOW), "3d 15h");
  assert.equal(until(at(9 * 60000 + 30000), NOW), "9m");
  assert.equal(until(at(-1), NOW), "now");
  assert.equal(until(null, NOW), null);
  assert.equal(until("nope", NOW), null);
});

test("ago", () => {
  assert.equal(ago(NOW - 30000, NOW), "just now");
  assert.equal(ago(NOW - 4 * 60000, NOW), "4m ago");
  assert.equal(ago(NOW - 2 * HOUR, NOW), "2h ago");
});

test("merge keeps the last good numbers on an error, not on a login problem", () => {
  const prev = usage({ meters: [meter("w", 40)], checkedAt: NOW - HOUR });
  const kept = merge(prev, usage({ state: "error", message: "Rate limited" }));
  assert.equal(kept.state, "ok");
  assert.equal(kept.meters.length, 1);
  assert.equal(kept.checkedAt, NOW - HOUR);
  assert.equal(kept.message, "Rate limited");
  assert.equal(merge(prev, usage({ state: "login" })).state, "login");
  assert.equal(merge(undefined, usage({ state: "error" })).state, "error");
});

test("stale", () => {
  assert.equal(stale(undefined, NOW, 1000), true);
  assert.equal(stale({ at: NOW - 999 }, NOW, 1000), false);
  assert.equal(stale({ at: NOW - 1000 }, NOW, 1000), true);
});
