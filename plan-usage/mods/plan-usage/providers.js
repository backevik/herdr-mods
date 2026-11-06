// Reads each provider's existing CLI login and asks its usage endpoint. Logins are only
// read, never refreshed or stored: refreshing would rotate the CLI's refresh token and log
// it out. Tokens stay in memory for the one request.

import { exec, home, readTextFile } from "herdr";
import { openCodeCredential, claudeCredential, cursorCredential, httpState, openCodeMeters, claudeMeters, cursorMeters, capitalize } from "./logic.js";

/** @typedef {import("./logic.js").Usage} Usage */
/** @typedef {import("./logic.js").State} State */
/** @typedef {import("./logic.js").Meter} Meter */
/** @typedef {{ plan: string | null, state: State, message: string, meters: Meter[] }} Reading */
/** @typedef {{ id: string, name: string, login: string[], read: (now: number) => Promise<Reading> }} Provider */

/** @param {State} state @param {string} message @param {string | null} [plan] @returns {Reading} */
const fail = (state, message, plan = null) => ({ plan, state, message, meters: [] });

/** A Keychain password (macOS), or null. @param {string} service @param {string} [account] */
async function keychain(service, account) {
  try {
    const args = ["find-generic-password", "-s", service, ...(account ? ["-a", account] : []), "-w"];
    const r = await exec("security", args);
    return r.code === 0 ? r.stdout.trim() || null : null;
  } catch {
    return null;
  }
}

/** The login name, or null. */
async function userName() {
  try {
    const r = await exec("id", ["-un"]);
    return r.code === 0 ? r.stdout.trim() || null : null;
  } catch {
    return null;
  }
}

/** @param {string} text @returns {any} */
function json(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * GET or POST, read as JSON. `noPlan`: the status meaning "no plan".
 * @param {string} url
 * @param {Record<string, string>} headers
 * @param {{ method?: string, body?: string, noPlan?: number }} [opts]
 * @returns {Promise<{ body: any } | { fail: Reading }>}
 */
async function call(url, headers, { method, body, noPlan } = {}) {
  let res;
  try {
    res = await fetch(url, { method, headers: { Accept: "application/json", ...headers }, body });
  } catch (error) {
    return { fail: fail("error", `Network: ${String(error)}`) };
  }
  const bad = httpState(res.status, noPlan);
  if (bad) return { fail: fail(bad.state, bad.message) };
  const parsed = json(await res.text());
  return parsed ? { body: parsed } : { fail: fail("error", "Unreadable response") };
}

/** @type {Provider} */
const openCode = {
  id: "opencode",
  name: "OpenCode",
  login: ["opencode", "auth", "login"],
  async read(now) {
    const db = `${home()}/.local/share/opencode/opencode.db`;
    const sql = "select value from credential where integration_id = 'opencode' and active = 1 order by time_updated desc limit 1";
    /** @type {string | null} */
    let row = null;
    try {
      const r = await exec("sqlite3", ["-readonly", db, sql]);
      if (r.code === 0) row = r.stdout.trim() || null;
    } catch {}
    // Before opencode v2: ~/.local/share/opencode/auth.json, {opencode: {...}}.
    if (!row) {
      const legacy = json((await readTextFile(`${home()}/.local/share/opencode/auth.json`)) ?? "");
      if (legacy?.opencode) row = JSON.stringify(legacy.opencode);
    }
    const cred = openCodeCredential(row, now);
    if ("state" in cred) return fail(cred.state, cred.message);
    /** @type {Record<string, string>} */
    const headers = { Authorization: `Bearer ${cred.token}` };
    if (cred.org) headers["x-opencode-org-id"] = cred.org;
    const r = await call("https://opencode.ai/zen/go/v1/usage", headers, { noPlan: 403 });
    if ("fail" in r) return { ...r.fail, plan: r.fail.state === "none" ? null : "Go", message: r.fail.state === "none" ? "No Go subscription" : r.fail.message };
    const meters = openCodeMeters(r.body);
    return meters.length ? { plan: "Go", state: "ok", message: "", meters } : fail("error", "No usage in the response", "Go");
  },
};

/** @type {Provider} */
const claude = {
  id: "claude",
  name: "Claude",
  login: ["claude", "auth", "login", "--claudeai"],
  async read(now) {
    // Without an account, `security` returns the first of several same-named items, which can be
    // a stale login of an earlier account. Claude Code stores its current one under the user name.
    const account = (await userName()) ?? undefined;
    const cred = claudeCredential(
      [await keychain("Claude Code-credentials", account), await keychain("Claude Code-credentials"), await readTextFile(`${home()}/.claude/.credentials.json`)],
      now,
    );
    if ("state" in cred) return fail(cred.state, cred.message);
    const plan = cred.plan ? capitalize(cred.plan) : null;
    const r = await call("https://api.anthropic.com/api/oauth/usage", { Authorization: `Bearer ${cred.token}`, "anthropic-beta": "oauth-2025-04-20" });
    if ("fail" in r) return { ...r.fail, plan };
    const meters = claudeMeters(r.body);
    return meters.length ? { plan, state: "ok", message: "", meters } : fail("none", "No plan limits reported", plan);
  },
};

/** @type {Provider} */
const cursor = {
  id: "cursor",
  name: "Cursor",
  login: ["cursor-agent", "login"],
  async read(now) {
    const cred = cursorCredential(await keychain("cursor-access-token"), now);
    if ("state" in cred) return fail(cred.state, cred.message);
    const headers = { Cookie: cred.token };
    const [summary, sand] = await Promise.all([
      call("https://cursor.com/api/usage-summary", headers),
      call("https://cursor.com/api/dashboard/get-sand-usage-status", { ...headers, "Content-Type": "application/json", Origin: "https://cursor.com" }, { method: "POST", body: "{}" }),
    ]);
    if ("fail" in summary) return summary.fail;
    const { plan, meters } = cursorMeters(summary.body, "body" in sand ? sand.body : null);
    return meters.length ? { plan, state: "ok", message: "", meters } : fail("none", "No plan limits reported", plan);
  },
};

/** In the order they're shown. A new provider is one more entry. */
export const PROVIDERS = [claude, cursor, openCode];

/**
 * Every provider at once; a provider that throws becomes an "error" row.
 * @param {number} now
 * @returns {Promise<Usage[]>}
 */
export async function readAll(now) {
  return Promise.all(
    PROVIDERS.map(async (p) => {
      /** @type {Reading} */
      let reading;
      try {
        reading = await p.read(now);
      } catch (error) {
        reading = fail("error", String(error));
      }
      return { id: p.id, name: p.name, checkedAt: now, ...reading };
    }),
  );
}
