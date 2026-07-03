// sensource-probe.mts — one-shot diagnostic for the SenSource Vea integration.
//
// Captures the RAW response shapes of the endpoints we need to (a) verify zone
// scoping and (b) build authoritative space-occupancy that matches the Vea
// website. It NEVER writes your token or client secret to the output file.
//
// Run it on the machine where SenSource is configured (it reuses the app's saved,
// encrypted credentials):
//
//     STAGE_UTILITY_DATA=/path/to/your/data-dir npx tsx scripts/sensource-probe.mts
//
//   • If you run the app with the default data dir (~/.stage-utility), just:
//         npx tsx scripts/sensource-probe.mts
//   • Or pass creds directly instead of reading the saved ones:
//         SENSOURCE_CLIENT_ID=xxx SENSOURCE_CLIENT_SECRET=yyy npx tsx scripts/sensource-probe.mts
//         SENSOURCE_TOKEN=zzz npx tsx scripts/sensource-probe.mts
//
// Then send me the file it writes: sensource-capture.json
// (It contains location/zone/space NAMES + counts — no secrets. Skim it first if
//  you like; redact any name you'd rather not share.)

import { writeFileSync } from "node:fs";

const AUTH_URL = "https://auth.sensourceinc.com/oauth/token";
const API_BASE = "https://vea.sensourceinc.com/api";
const TIMEOUT = 20000;

async function resolveCreds(): Promise<{ clientId?: string; clientSecret?: string; token?: string }> {
  const env = {
    clientId: process.env.SENSOURCE_CLIENT_ID,
    clientSecret: process.env.SENSOURCE_CLIENT_SECRET,
    token: process.env.SENSOURCE_TOKEN,
  };
  if (env.token || (env.clientId && env.clientSecret)) return env;
  // Fall back to the app's saved, encrypted credentials.
  const { secretsStore } = await import("../main/services/secrets.js");
  const { settingsStore } = await import("../main/services/settings-store.js");
  const secrets = await secretsStore.getSecrets("sensource");
  const cfg = (await settingsStore.get()).integrationConfigs.sensource ?? {};
  return {
    clientId: typeof cfg.clientId === "string" ? cfg.clientId : undefined,
    clientSecret: secrets.clientSecret,
    token: secrets.apiToken,
  };
}

async function authHeader(c: { clientId?: string; clientSecret?: string; token?: string }): Promise<string> {
  if (c.token) return /^bearer\s/i.test(c.token) ? c.token : `Bearer ${c.token}`;
  if (!c.clientId || !c.clientSecret) throw new Error("No usable credentials (set SENSOURCE_* env vars or configure SenSource in the app)");
  const res = await fetch(AUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ grant_type: "client_credentials", client_id: c.clientId, client_secret: c.clientSecret }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) throw new Error(`Auth failed HTTP ${res.status}`);
  const j = (await res.json()) as { access_token?: string; expires_in?: number; token_type?: string };
  if (!j.access_token) throw new Error("Auth response had no access_token");
  console.log(`  auth ok — token_type=${j.token_type ?? "?"} expires_in=${j.expires_in ?? "?"}`);
  return `Bearer ${j.access_token}`;
}

async function get(auth: string, path: string): Promise<unknown> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json", Authorization: auth },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Pull the row array out of either {results:[...]} or a bare array. */
function rows(v: unknown): Record<string, unknown>[] {
  const a = Array.isArray(v) ? v : v && typeof v === "object" && Array.isArray((v as any).results) ? (v as any).results : [];
  return a.filter((r: unknown) => r && typeof r === "object");
}

const ENDPOINTS: { label: string; path: string }[] = [
  { label: "location", path: "/location" },
  { label: "site", path: "/site" },
  { label: "zone", path: "/zone" },
  { label: "space", path: "/space" },
  { label: "sensor", path: "/sensor" },
  { label: "traffic_today_by_zone", path: "/data/traffic?relativeDate=today&dateGroupings=day&entityType=zone&metrics=ins,outs&excludeClosedHours=true" },
  { label: "occupancy_space_day", path: "/data/occupancy?relativeDate=today&dateGroupings=day&entityType=space&metrics=occupancy(max),occupancy(min),occupancy(avg)" },
  { label: "occupancy_space_hour", path: "/data/occupancy?relativeDate=today&dateGroupings=hour&entityType=space&metrics=occupancy(max),occupancy(avg)" },
  { label: "occupancy_space_15min", path: "/data/occupancy?relativeDate=today&dateGroupings=15min&entityType=space&metrics=occupancy(max),occupancy(avg)" },
  { label: "occupancy_space_nogroup", path: "/data/occupancy?relativeDate=today&entityType=space&metrics=occupancy(max)" },
  { label: "occupancy_zone_day", path: "/data/occupancy?relativeDate=today&dateGroupings=day&entityType=zone&metrics=occupancy(max),occupancy(avg)" },
];

async function main() {
  const creds = await resolveCreds();
  console.log("Authenticating…");
  const auth = await authHeader(creds);

  const capture: Record<string, unknown> = { capturedAtLocal: new Date().toString() };
  for (const ep of ENDPOINTS) {
    process.stdout.write(`  GET ${ep.path.slice(0, 60)}… `);
    try {
      const body = await get(auth, ep.path);
      const r = rows(body);
      capture[ep.label] = body;
      const keys = r[0] ? Object.keys(r[0]) : [];
      console.log(`ok — ${r.length} row(s)${keys.length ? `, fields: ${keys.join(", ")}` : ""}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      capture[ep.label] = { error: msg };
      console.log(`FAILED — ${msg}`);
    }
  }

  const out = "sensource-capture.json";
  writeFileSync(out, JSON.stringify(capture, null, 2));
  console.log(`\nWrote ${out}. Send me that file (it has names + counts, no secrets).`);
  console.log("If you can, also tell me roughly how many people were actually in the room just now.");
}

main().catch((e) => {
  console.error("Probe failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
