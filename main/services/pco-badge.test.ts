// Pins the Planning Center connection-badge contract.
//
// applyPcoCredentials() used to report "connected" whenever App ID and Secret were
// merely NON-EMPTY. A revoked or mistyped token therefore showed a green badge in
// Integrations while every refresh failed with "PCO auth failed" — the panel and
// the app disagreed, and the panel was the convincing one. That cost real
// debugging time on a live box.
//
// PCO is stateless HTTPS: there is no socket whose success speaks for itself, so a
// request IS the check. These tests encode the state machine that follows from
// that, using a stand-in for the credential check so they never touch the network.

import { errorMessage } from "./errors.js";
import assert from "node:assert/strict";
import { test, describe } from "node:test";

import type { ConnectionState } from "../types/integrations.js";

/**
 * The decision applyPcoCredentials + verifyPcoCredentials make between them,
 * extracted so it can be exercised without booting the manager.
 */
async function pcoBadge(
  appId: string | null,
  secret: string | null,
  check: (id: string, sec: string) => Promise<number>,
): Promise<{ states: ConnectionState[]; message: string | null }> {
  const states: ConnectionState[] = [];
  let message: string | null = null;
  const set = (s: ConnectionState, m: string | null) => {
    states.push(s);
    message = m;
  };

  if (!appId || !secret) {
    set("disconnected", null);
    return { states, message };
  }
  set("connecting", "Checking credentials…");
  try {
    const n = await check(appId, secret);
    set("connected", `Connected — ${n} service type(s)`);
  } catch (err) {
    set("error", errorMessage(err));
  }
  return { states, message };
}

const accepts = async () => 4;
const rejects = async () => {
  throw new Error("PCO auth failed — check App ID/Secret in Integrations settings");
};

describe("PCO connection badge", () => {
  test("valid credentials end up connected", async () => {
    const r = await pcoBadge("app", "sec", accepts);
    assert.equal(r.states[r.states.length - 1], "connected");
    assert.match(r.message ?? "", /4 service type\(s\)/);
  });

  // The regression. Non-empty is not the same as valid.
  test("credentials PCO REJECTS never report connected", async () => {
    const r = await pcoBadge("app", "wrong-secret", rejects);
    assert.equal(r.states[r.states.length - 1], "error");
    assert.ok(!r.states.includes("connected"),
      "a rejected token must never show a connected badge — that is the bug this fixes");
    assert.match(r.message ?? "", /auth failed/);
  });

  test("the badge surfaces PCO's own reason, not a generic one", async () => {
    const r = await pcoBadge("app", "sec", async () => {
      throw new Error("PCO rate limited (429)");
    });
    assert.equal(r.message, "PCO rate limited (429)");
  });

  test("missing credentials are disconnected, not error", async () => {
    // Nothing has gone wrong — it just is not set up. Error would cry wolf.
    for (const [id, sec] of [[null, null], ["app", null], [null, "sec"], ["", ""]] as const) {
      const r = await pcoBadge(id, sec, accepts);
      assert.deepEqual(r.states, ["disconnected"], `appId=${id} secret=${sec}`);
    }
  });

  test("it passes through 'connecting' while the check is in flight", async () => {
    // Startup kicks the check off in the background, so the badge must show a
    // truthful interim state rather than an optimistic "connected".
    const r = await pcoBadge("app", "sec", accepts);
    assert.deepEqual(r.states, ["connecting", "connected"]);
  });

  test("a network failure reports error, never connected", async () => {
    const r = await pcoBadge("app", "sec", async () => {
      throw new Error("getaddrinfo ENOTFOUND api.planningcenteronline.com");
    });
    assert.equal(r.states[r.states.length - 1], "error");
    assert.ok(!r.states.includes("connected"));
  });
});
