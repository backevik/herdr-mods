// Decisions for plan-usage, without Herdr: parse each provider's credential and usage
// response into one shape, pick the tightest window, format resets. Pure functions;
// `now` (ms since the epoch) is always passed in.

/**
 * One usage meter, e.g. "Weekly 47%".
 * `counts`: part of the plan quota. False for overflow (on-demand, extra usage) and side
 * products (Grok Bot), which are shown but never the headline number.
 * @typedef {{ label: string, percent: number, resetsAt: string | null, note?: string, counts: boolean }} Meter
 */

/**
 * - ok: meters are fresh
 * - login: no credential, or it expired; the CLI's login fixes it
 * - none: logged in, but no plan with usage limits
 * - error: anything else (network, 5xx, an unknown response)
 * @typedef {"ok" | "login" | "none" | "error"} State
 */

/** @typedef {{ id: string, name: string, plan: string | null, state: State, message: string, meters: Meter[], checkedAt: number }} Usage */

/** @typedef {{ token: string, org?: string } | { state: State, message: string }} Credential */

/** @typedef {"ok" | "warn" | "high"} Level */

export const WARN = 80;
export const HIGH = 95;

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Decodes base64 or base64url to a string (ASCII/UTF-8 JSON is all we need). The app has no atob.
 * @param {string} s
 * @returns {string | null}
 */
export function base64Decode(s) {
  const clean = s.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  /** @type {number[]} */
  const bytes = [];
  let bits = 0;
  let value = 0;
  for (const c of clean) {
    const i = B64.indexOf(c);
    if (i < 0) return null;
    value = (value << 6) | i;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >> bits) & 0xff);
    }
  }
  try {
    return decodeURIComponent(bytes.map((b) => `%${b.toString(16).padStart(2, "0")}`).join(""));
  } catch {
    return null;
  }
}

/**
 * The payload of a JWT, or null when it isn't one.
 * @param {string} token
 * @returns {Record<string, any> | null}
 */
export function jwtPayload(token) {
  const part = token.split(".")[1];
  if (!part) return null;
  const text = base64Decode(part);
  if (!text) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

/** @param {string} text @returns {any} */
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** @param {unknown} v @returns {v is number} */
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/**
 * OpenCode's stored login: a `credential.value` row from opencode.db (v2), or the
 * `opencode` entry of the legacy auth.json. `{type: "oauth", access, expires, metadata: {orgID}}`
 * or `{type: "api", key}`.
 * @param {string | null} text
 * @param {number} now
 * @returns {Credential}
 */
export function openCodeCredential(text, now) {
  const v = text ? parseJson(text.trim()) : null;
  if (!v) return { state: "login", message: "Not logged in" };
  const org = v.metadata?.orgID ?? undefined;
  if (v.type === "api" && v.key) return { token: v.key, org };
  if (v.type === "oauth" && v.access) {
    if (isNum(v.expires) && v.expires <= now) return { state: "login", message: "Login expired" };
    return { token: v.access, org };
  }
  return { state: "login", message: "Not logged in" };
}

/**
 * Claude Code's login (`Claude Code-credentials` in the Keychain, or ~/.claude/.credentials.json):
 * `{claudeAiOauth: {accessToken, expiresAt, subscriptionType, scopes}}`. Of several copies, the one
 * that expires last wins (the file goes stale on macOS).
 * @param {(string | null)[]} texts
 * @param {number} now
 * @returns {Credential & { plan?: string | null }}
 */
export function claudeCredential(texts, now) {
  const all = texts
    .map((t) => (t ? parseJson(t.trim())?.claudeAiOauth : null))
    .filter((o) => o && o.accessToken)
    .sort((a, b) => (b.expiresAt ?? 0) - (a.expiresAt ?? 0));
  const best = all[0];
  if (!best) return { state: "login", message: "Not logged in" };
  if (isNum(best.expiresAt) && best.expiresAt <= now) return { state: "login", message: "Login expired, open claude or log in again" };
  if (Array.isArray(best.scopes) && !best.scopes.includes("user:profile")) {
    return { state: "login", message: "This login can't read usage (setup-token?), log in again" };
  }
  return { token: best.accessToken, plan: best.subscriptionType ?? null };
}

/**
 * The cursor-agent access token (a JWT) and the dashboard cookie built from it:
 * `WorkosCursorSessionToken=<user id>%3A%3A<jwt>`, the user id being `sub` after the "|".
 * @param {string | null} token
 * @param {number} now
 * @returns {Credential}
 */
export function cursorCredential(token, now) {
  const t = token?.trim();
  if (!t) return { state: "login", message: "Not logged in" };
  const p = jwtPayload(t);
  const user = typeof p?.sub === "string" ? p.sub.split("|").pop() : null;
  if (!p || !user) return { state: "error", message: "Unreadable Cursor token" };
  if (isNum(p.exp) && p.exp * 1000 <= now) return { state: "login", message: "Login expired" };
  return { token: `WorkosCursorSessionToken=${user}%3A%3A${t}` };
}

/**
 * The state an HTTP status means for a usage call. `noPlan`: the status a provider answers
 * when the account has no plan (OpenCode: 403 for a workspace without Go).
 * @param {number} status
 * @param {number | null} [noPlan]
 * @returns {{ state: State, message: string } | null} null for 2xx
 */
export function httpState(status, noPlan = null) {
  if (status >= 200 && status < 300) return null;
  if (status === noPlan) return { state: "none", message: "No plan with usage limits" };
  if (status === 401 || status === 403) return { state: "login", message: "Login rejected, log in again" };
  if (status === 429) return { state: "error", message: "Rate limited, try again in a few minutes" };
  return { state: "error", message: `HTTP ${status}` };
}

/** @param {unknown} v */
const pct = (v) => (isNum(v) ? Math.max(0, v) : null);

/**
 * GET opencode.ai/zen/go/v1/usage:
 * `{usage: {rolling|weekly|monthly: {status, percent, resetsAt}}}`.
 * @param {any} json
 * @returns {Meter[]}
 */
export function openCodeMeters(json) {
  const u = json?.usage ?? {};
  /** @type {[string, string][]} */
  const windows = [["rolling", "5-hour window"], ["weekly", "Weekly"], ["monthly", "Monthly"]];
  /** @type {Meter[]} */
  const out = [];
  for (const [key, label] of windows) {
    const w = u[key];
    const percent = pct(w?.percent);
    if (percent === null) continue;
    out.push({ label, percent, resetsAt: w.resetsAt ?? null, counts: true, ...(w.status === "rate-limited" ? { note: "limit reached" } : {}) });
  }
  return out;
}

/**
 * GET api.anthropic.com/api/oauth/usage: `five_hour`, `seven_day`, `seven_day_opus`,
 * `seven_day_sonnet` as `{utilization: 0-100, resets_at}` or null; newer answers add
 * `limits[]` (`{kind: "weekly_scoped", percent, resets_at, scope.model.display_name}`)
 * and `extra_usage` (`{is_enabled, utilization}`).
 * @param {any} json
 * @returns {Meter[]}
 */
export function claudeMeters(json) {
  /** @type {[string, string][]} */
  const known = [["five_hour", "5-hour window"], ["seven_day", "Weekly"], ["seven_day_opus", "Weekly Opus"], ["seven_day_sonnet", "Weekly Sonnet"]];
  /** @type {Meter[]} */
  const out = [];
  for (const [key, label] of known) {
    const w = json?.[key];
    const percent = pct(w?.utilization);
    if (percent !== null) out.push({ label, percent, resetsAt: w.resets_at ?? null, counts: true });
  }
  for (const l of Array.isArray(json?.limits) ? json.limits : []) {
    const name = l?.scope?.model?.display_name;
    const percent = pct(l?.percent ?? l?.utilization);
    if (l?.kind !== "weekly_scoped" || !name || percent === null) continue;
    const label = `Weekly ${name}`;
    if (!out.some((m) => m.label === label)) out.push({ label, percent, resetsAt: l.resets_at ?? null, counts: true });
  }
  const extra = json?.extra_usage;
  const extraPct = pct(extra?.utilization);
  if (extra?.is_enabled && extraPct !== null) out.push({ label: "Extra usage", percent: extraPct, resetsAt: null, counts: false });
  return out;
}

/** "$10", "$2.50". @param {number} cents */
const dollars = (cents) => `$${cents % 100 === 0 ? cents / 100 : (cents / 100).toFixed(2)}`;

/**
 * GET cursor.com/api/usage-summary and POST /api/dashboard/get-sand-usage-status (Grok Bot).
 * Amounts are in cents. `autoPercentUsed` is "Cursor models", `apiPercentUsed` "Other models".
 * @param {any} summary
 * @param {any} [sand]
 * @returns {{ plan: string | null, meters: Meter[] }}
 */
export function cursorMeters(summary, sand) {
  const plan = summary?.individualUsage?.plan;
  const reset = summary?.billingCycleEnd ?? null;
  /** @type {Meter[]} */
  const meters = [];
  if (plan?.enabled !== false) {
    const auto = pct(plan?.autoPercentUsed);
    const api = pct(plan?.apiPercentUsed);
    if (auto !== null) meters.push({ label: "Cursor models", percent: auto, resetsAt: reset, counts: true });
    if (api !== null) meters.push({ label: "Other models", percent: api, resetsAt: reset, counts: true });
  }
  const od = summary?.individualUsage?.onDemand;
  if (od?.enabled && isNum(od.used)) {
    const limited = isNum(od.limit) && od.limit > 0;
    meters.push({
      label: "On-demand",
      percent: limited ? (od.used / od.limit) * 100 : 0,
      resetsAt: reset,
      note: limited ? `${dollars(od.used)} / ${dollars(od.limit)}` : `${dollars(od.used)}, no limit`,
      counts: false,
    });
  }
  const grok = pct(sand?.usagePercent);
  if (grok !== null && sand?.hasNonZeroIncludedLimit !== false) {
    meters.push({ label: "Grok Bot weekly", percent: grok, resetsAt: sand.nextResetTimestampUtc ?? null, counts: false });
  }
  const type = summary?.membershipType;
  return { plan: typeof type === "string" ? capitalize(type) : null, meters };
}

/** @param {string} s */
export const capitalize = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/**
 * The plan meter with the least room left, the provider's headline number.
 * @param {Meter[]} meters
 * @returns {Meter | null}
 */
export function tightest(meters) {
  return meters.filter((m) => m.counts).reduce((/** @type {Meter | null} */ a, m) => (a && a.percent >= m.percent ? a : m), null);
}

/**
 * The provider with the most room in its tightest meter, among those with fresh numbers.
 * @param {Usage[]} list
 * @returns {{ usage: Usage, meter: Meter } | null}
 */
export function mostRoom(list) {
  /** @type {{ usage: Usage, meter: Meter } | null} */
  let best = null;
  for (const usage of list) {
    if (usage.state !== "ok") continue;
    const meter = tightest(usage.meters);
    if (meter && (!best || meter.percent < best.meter.percent)) best = { usage, meter };
  }
  return best;
}

/** @param {number} percent @returns {Level} */
export function level(percent) {
  return percent >= HIGH ? "high" : percent >= WARN ? "warn" : "ok";
}

/**
 * "3h 9m", "4d 15h", "9m", "now". Null when there's no reset time.
 * @param {string | null} resetsAt
 * @param {number} now
 * @returns {string | null}
 */
export function until(resetsAt, now) {
  if (!resetsAt) return null;
  const at = Date.parse(resetsAt);
  if (!Number.isFinite(at)) return null;
  const min = Math.floor((at - now) / 60000);
  if (min <= 0) return "now";
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/**
 * "just now", "4m ago", "2h ago".
 * @param {number} at ms since the epoch
 * @param {number} now
 */
export function ago(at, now) {
  const min = Math.floor((now - at) / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  return `${Math.floor(min / 60)}h ago`;
}

/**
 * A fresh result, keeping the last good meters when a refresh failed with "error"
 * (a 429 or the network), so a hiccup doesn't blank the numbers. The kept result keeps its
 * own `checkedAt`, so the UI shows how old the numbers are.
 * @param {Usage | undefined} prev
 * @param {Usage} next
 * @returns {Usage}
 */
export function merge(prev, next) {
  if (next.state === "error" && prev?.state === "ok") return { ...prev, message: next.message };
  return next;
}

/**
 * Whether the cache is older than `maxAge` ms.
 * @param {{ at: number } | undefined} cache
 * @param {number} now
 * @param {number} maxAge
 */
export function stale(cache, now, maxAge) {
  return !cache || now - cache.at >= maxAge;
}
