// seed/app.mjs — everything seeded through the running server's own API.
//
// Each step is a function so a failure names the feature that failed. Returns the
// ids the capture step needs (views, screens, widget ids, wireless channels).

import { until } from "../lib/api.mjs";
import { LIVE_PLAN_ID, SERVICE_TYPES, WIRELESS_RECEIVERS, planFor } from "../world.mjs";
import { seedAutomation } from "./automation.mjs";
import { seedHome } from "./home.mjs";
import { seedLayouts } from "./layouts.mjs";
import { seedMessages } from "./messages.mjs";
import { seedPatch } from "./patch.mjs";
import { seedVideo } from "./video.mjs";

async function connectPlanningCenter(api) {
  await api.post("/api/integrations/planning-center/config", { config: { appId: "demo-app-id", secret: "demo-secret" } });
  await api.post("/api/integrations/planning-center/enabled", { enabled: true });
  await until(async () => {
    const { states } = await api.get("/api/integrations");
    return states.find((s) => s.id === "planning-center")?.connection === "connected";
  }, "Planning Center (the fake) to connect");
  await api.post("/api/allowed-service-types", { ids: SERVICE_TYPES.map((t) => t.id) });
}

async function connectWireless(api) {
  const ids = [];
  for (const rx of WIRELESS_RECEIVERS) {
    const list = await api.post("/api/wireless/connections", { name: rx.name, providerId: rx.provider });
    const created = list.find((c) => c.name === rx.name);
    await api.patch(`/api/wireless/connections/${created.id}`, {
      config: { host: rx.host, port: 2202, channels: rx.channels },
      enabled: true,
    });
    ids.push(created.id);
  }
  await api.post("/api/integrations/wireless/enabled", { enabled: true });
  await until(async () => {
    const statuses = await api.get("/api/integrations/wireless/statuses");
    return statuses.filter((s) => s.online).length >= 6;
  }, "the fake receivers to report");
  return ids;
}

/** Follow the upcoming Weekend plan, as a machine in auto mode does. */
async function followWeekend(api, now) {
  // Manual, with the plan chosen: auto mode follows whichever service is soonest,
  // which on a Thursday is the Friday one, and the screenshots would change with
  // the weekday they were made on.
  const plan = planFor("weekend", 0, now);
  await api.post("/api/service-type", { id: SERVICE_TYPES[0].id });
  await api.post("/api/plan/mode", { mode: "manual" });
  await api.post("/api/plan", { id: plan.id });
  await until(async () => {
    const state = await api.get("/api/state");
    return state.planSeriesTitle === plan.series ? state : null;
  }, `the ${plan.title} plan to load`);
}

export async function seedApp(api, { now }) {
  await connectPlanningCenter(api);
  const wirelessIds = await connectWireless(api);
  await followWeekend(api, now);
  const layouts = await seedLayouts(api, { wirelessIds, now });
  await seedMessages(api, layouts);
  await seedAutomation(api, layouts);
  await seedVideo(api);
  await seedPatch(api, now);
  await seedHome(api);
  return { ...layouts, wirelessIds, livePlanId: LIVE_PLAN_ID };
}
