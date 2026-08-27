// resi-probe.mts — one-shot diagnostic: can Resi tell us a STREAM is live?
//
// THE QUESTION.
//
// resi-service reports the ENCODER (`status === "started"`), which is true from
// the moment somebody begins a soundcheck — an hour before anything goes out.
// What an operator wants on a wall is whether the BROADCAST is live.
//
// Bitfocus's resi-studio module answers that on Resi's PUBLIC API, and it is
// worth knowing exactly how, because it is the shape we are looking for here:
//
//     GET api.resi.io/v1/schedules/{scheduleId}
//       → { destinations: [ { id, name, type, status } ] }
//
//     status ∈ IDLE | SET_UP | STARTING | STARTED | STOPPING | STOPPED
//               | ABORTED | ERROR
//
// A DESTINATION is where the stream actually goes, so a destination STARTED is
// the real "we are live". Bitfocus filters by destination `type`, so a webstream
// can be distinguished from an RTMP push.
//
// That path is closed to us and it is worth being precise about why: a
// scheduleId only comes back from the POST that STARTS a stream, so the module
// persists the ids it created (self.SCHEDULE_IDS, saved to its config). A stream
// started on Resi's own schedule — which is how Cornerstone goes live — was
// never created by us, so we never have its id.
//
// SO THIS PROBES THE INTERNAL API INSTEAD.
//
// central.resi.io is what the Resi web app itself talks to, and it lists things
// for the whole account rather than only what the caller created. If any endpoint
// here returns a schedule, event, webstream or destination with a status, that is
// the signal the layout object should read.
//
// It prints only SHAPES and status-ish values — never a token, never a password.
//
// Run it on the machine where Resi is configured (it reuses the app's saved,
// encrypted credentials):
//
//     STAGE_UTILITY_DATA=/path/to/your/data-dir npx tsx scripts/resi-probe.mts
//
//   • Default data dir (~/.stage-utility) — just:
//         npx tsx scripts/resi-probe.mts
//   • Or pass credentials directly:
//         RESI_USERNAME=you@example.org RESI_PASSWORD=secret npx tsx scripts/resi-probe.mts
//
// Then send back resi-capture.json.

import { writeFileSync } from "node:fs";

import { errorMessage } from "@main/services/errors";

const API = "https://central.resi.io/api/v3";
const API_V2 = "https://central.resi.io/api_v2.svc";
const TIMEOUT = 20_000;

/** Keys whose VALUE must never be written out, however they are nested. */
const SECRET_KEYS = /^(password|token|access_token|refresh_token|secret|key|authorization)$/i;

/**
 * A value reduced to its shape.
 *
 * Strings are kept only when they look like a status or a name — the things we
 * are trying to identify — and anything that could be a credential is replaced
 * outright rather than truncated.
 */
function shape(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    // One element is enough to learn a shape; the count says whether it is a list
    // worth paging.
    return { __array: value.length, sample: value.length ? shape(value[0], depth + 1) : null };
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEYS.test(k) ? "<redacted>" : shape(v, depth + 1);
    }
    return out;
  }
  if (typeof value === "string") {
    // Short strings are the interesting ones: STARTED, webstream, a name. A long
    // one is a blob and only its length matters.
    return value.length <= 48 ? value : `<string len=${value.length}>`;
  }
  return value;
}

async function req(url: string, token: string): Promise<{ ok: boolean; status: number; body: unknown }> {
  try {
    const res = await fetch(url, {
      headers: { "Content-Type": "application/json", Authorization: `X-Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text.slice(0, 200);
    }
    return { ok: res.ok, status: res.status, body: parsed };
  } catch (err) {
    return { ok: false, status: 0, body: errorMessage(err) };
  }
}

async function resolveCreds(): Promise<{ username: string; password: string }> {
  const username = process.env.RESI_USERNAME;
  const password = process.env.RESI_PASSWORD;
  if (username && password) return { username, password };
  const { secretsStore } = await import("../main/services/secrets.js");
  const secrets = await secretsStore.getSecrets("resi");
  const u = secrets.username;
  const p = secrets.password;
  if (!u || !p) {
    throw new Error(
      "No Resi credentials. Configure Resi in the app, or pass RESI_USERNAME and RESI_PASSWORD.",
    );
  }
  return { username: u, password: p };
}

async function main(): Promise<void> {
  const { username, password } = await resolveCreds();

  const authRes = await fetch(`${API}/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password, grant_type: "password_cookie" }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!authRes.ok) throw new Error(`Auth failed HTTP ${authRes.status}`);
  const auth = (await authRes.json()) as { access_token?: string };
  const token = auth.access_token;
  if (!token) throw new Error("Auth response had no access_token");
  console.log("  auth ok");

  const me = await req(`${API_V2}/users/me`, token);
  const customerId =
    me.ok && me.body && typeof me.body === "object"
      ? ((me.body as { customerId?: string }).customerId ?? null)
      : null;
  if (!customerId) throw new Error("Could not read a customerId from /users/me");
  console.log("  customer id ok");

  const c = encodeURIComponent(customerId);

  // Candidates, in rough order of how likely they are to carry a broadcast state.
  // Every one is a GET; nothing here starts, stops or changes anything.
  const targets: [string, string][] = [
    ["encoders_status_wide", `${API}/customers/${c}/encoders/status?wide=true`],
    ["schedules", `${API}/customers/${c}/schedules`],
    ["events", `${API}/customers/${c}/events`],
    ["webstreams", `${API}/customers/${c}/webstreams`],
    ["destinations", `${API}/customers/${c}/destinations`],
    ["destination_groups", `${API}/customers/${c}/destinationgroups`],
    ["live", `${API}/customers/${c}/live`],
    ["v2_schedules", `${API_V2}/customers/${c}/schedules`],
    ["v2_events", `${API_V2}/customers/${c}/events`],
    ["v2_webstreams", `${API_V2}/customers/${c}/webstreams`],
  ];

  const results: Record<string, unknown> = {};
  for (const [name, url] of targets) {
    const r = await req(url, token);
    results[name] = {
      // The path without the customer id: that is account-identifying and adds
      // nothing to the question.
      path: url.replace(c, "{customerId}"),
      httpStatus: r.status,
      shape: r.ok ? shape(r.body) : undefined,
      error: r.ok ? undefined : shape(r.body),
    };
    console.log(`  ${r.status === 200 ? "ok  " : String(r.status).padEnd(4)} ${name}`);
  }

  const out = "resi-capture.json";
  writeFileSync(out, JSON.stringify({ capturedAt: new Date().toISOString(), results }, null, 2));
  console.log(`\nWrote ${out}`);
  console.log("It carries endpoint shapes and status words only — no token, no password.");
  console.log("Look for a `status` that reads STARTED/STOPPED on something that is NOT an encoder.");
}

main().catch((err) => {
  console.error(`resi-probe failed: ${errorMessage(err)}`);
  process.exitCode = 1;
});
