// pco-live-probe.mts — dev-only diagnostic for the PCO pre-service countdown.
//
// Dumps the RAW Planning Center data the countdown depends on — plan_times (with
// types + starts_at), the item schedule (sequence / type / length), and the /live
// state — so we can see exactly what PCO's green timer counts down to and design a
// convention-independent target (no reliance on a "SERVICE START" header).
//
// Run it on the machine where PCO is configured (reuses the app's saved creds):
//     npx tsx scripts/pco-live-probe.mts
//   or pass a specific plan:
//     PCO_SERVICE_TYPE=123 PCO_PLAN=456 npx tsx scripts/pco-live-probe.mts
//
// It prints NO secrets — only plan times, item titles/lengths, and computed offsets.
// Skim before sharing; redact any item title you'd rather not send.

const PCO_BASE = "https://api.planningcenteronline.com/services/v2";

async function creds(): Promise<{ appId: string; secret: string }> {
  const envApp = process.env.PCO_APP_ID;
  const envSecret = process.env.PCO_SECRET;
  if (envApp && envSecret) return { appId: envApp, secret: envSecret };
  const { secretsStore } = await import("../main/services/secrets.js");
  const { settingsStore } = await import("../main/services/settings-store.js");
  const settings = await settingsStore.load();
  const appId = String(settings.integrationConfigs["planning-center"]?.appId ?? "");
  const secret = (await secretsStore.getSecrets("planning-center")).secret ?? "";
  if (!appId || !secret) throw new Error("No PCO creds (configure Planning Center in the app, or set PCO_APP_ID / PCO_SECRET).");
  return { appId, secret };
}

async function plan(): Promise<{ serviceTypeId: string; planId: string }> {
  if (process.env.PCO_SERVICE_TYPE && process.env.PCO_PLAN) {
    return { serviceTypeId: process.env.PCO_SERVICE_TYPE, planId: process.env.PCO_PLAN };
  }
  const { settingsStore } = await import("../main/services/settings-store.js");
  const s = await settingsStore.load();
  if (!s.serviceTypeId || !s.planId) throw new Error("No current plan set (pick a plan in the app, or set PCO_SERVICE_TYPE / PCO_PLAN).");
  return { serviceTypeId: s.serviceTypeId, planId: s.planId };
}

async function main(): Promise<void> {
  const { appId, secret } = await creds();
  const { serviceTypeId, planId } = await plan();
  const auth = "Basic " + Buffer.from(`${appId}:${secret}`).toString("base64");
  const base = `${PCO_BASE}/service_types/${serviceTypeId}/plans/${planId}`;
  const get = async (path: string) => {
    const res = await fetch(`${base}${path}`, { headers: { Authorization: auth } });
    if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
    return res.json();
  };
  const fmt = (iso?: string | null) => (iso ? new Date(iso).toLocaleString() : "—");
  const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, "0")}`;

  console.log(`\n=== PLAN ${serviceTypeId}/${planId} ===  (now: ${new Date().toLocaleString()})`);

  // ── plan_times ──
  const pt = await get(`/plan_times?per_page=100`);
  console.log(`\n--- plan_times ---`);
  const times = (pt.data ?? []).map((t: any) => ({
    id: t.id,
    type: t.attributes?.time_type,
    startsAt: t.attributes?.starts_at,
    endsAt: t.attributes?.ends_at,
  }));
  for (const t of times) console.log(`  id ${t.id}  [${t.type}] starts ${fmt(t.startsAt)}  ends ${fmt(t.endsAt)}`);
  const svcCount = times.filter((t: any) => t.type === "service").length;
  console.log(`  → ${svcCount} service-type plan_time(s). ${svcCount > 1 ? "Distinct ids per service → keys DON'T collide." : "ONE service time → back-to-back services share a serviceKey (COLLISION)."}`);
  const serviceTimes = times.filter((t: any) => t.type === "service" && t.startsAt).sort((a: any, b: any) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  const earliestAny = times.filter((t: any) => t.startsAt).sort((a: any, b: any) => Date.parse(a.startsAt) - Date.parse(b.startsAt))[0];

  // ── items (with item_times for length/live_start_at) ──
  const it = await get(`/items?per_page=200&include=item_times`);
  const incl = it.included ?? [];
  const itemTimeFor = (itemId: string) => incl.find((n: any) => n.type === "ItemTime" && n.relationships?.item?.data?.id === itemId);
  console.log(`\n--- items (in sequence) ---`);
  const items = (it.data ?? []).sort((a: any, b: any) => (a.attributes?.sequence ?? 0) - (b.attributes?.sequence ?? 0));
  let cumBefore = 0;
  const rows: { title: string; type: string; len: number; cumBefore: number }[] = [];
  for (const i of items) {
    const title = i.attributes?.title ?? "(untitled)";
    const type = i.attributes?.item_type ?? "item";
    const itemLen = typeof i.attributes?.length === "number" ? i.attributes.length : 0;
    const t = itemTimeFor(i.id);
    const tlen = typeof t?.attributes?.length === "number" ? t.attributes.length : itemLen;
    const liveStart = t?.attributes?.live_start_at ?? null;
    rows.push({ title, type, len: tlen, cumBefore });
    console.log(`  #${i.attributes?.sequence}  [${type}]  len ${mmss(tlen)}  cum-before ${mmss(cumBefore)}  ${liveStart ? `live@${fmt(liveStart)}  ` : ""}${title}`);
    cumBefore += tlen;
  }

  // ── live ──
  const live = await get(`/live?include=current_item_time`);
  const liveNode = Array.isArray(live.data) ? live.data[0] : live.data;
  const curRef = liveNode?.relationships?.current_item_time?.data;
  const curId = curRef && !Array.isArray(curRef) ? curRef.id : null;
  const curItemTime = curId ? (live.included ?? []).find((n: any) => n.id === curId) : null;
  console.log(`\n--- /live ---`);
  console.log(`  current_item_time: ${curId ?? "none (pre-service)"}${curItemTime ? `  live_start_at ${fmt(curItemTime.attributes?.live_start_at)}` : ""}`);

  // ── analysis ──
  const now = Date.now();
  const svc = serviceTimes[0];
  console.log(`\n=== ANALYSIS ===`);
  if (svc) {
    const toSvc = (Date.parse(svc.startsAt) - now) / 60000;
    console.log(`  Our current target (service plan_time.starts_at): ${fmt(svc.startsAt)}  → ${toSvc.toFixed(1)} min`);
    const planTop = Date.parse(svc.startsAt) - 0; // items flow FORWARD from service time per PCO model → first item is AT starts_at
    console.log(`  If items flow forward from service time, first item = ${fmt(new Date(planTop).toISOString())} (same as service time).`);
  }
  if (earliestAny) {
    const toEarliest = (Date.parse(earliestAny.startsAt) - now) / 60000;
    console.log(`  Earliest plan_time of ANY type [${earliestAny.type}]: ${fmt(earliestAny.startsAt)}  → ${toEarliest.toFixed(1)} min`);
  }
  console.log(`  Total plan length: ${mmss(cumBefore)}`);
  console.log(`\nWhat does PCO's green timer show right now? (minutes) — compare to the values above.`);
}

void main().catch((e) => {
  console.error("probe failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
