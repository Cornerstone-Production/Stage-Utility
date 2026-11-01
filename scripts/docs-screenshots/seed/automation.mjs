// seed/automation.mjs — rules, and the OSC target they point at.

export async function seedAutomation(api, { groups, consoleId, panelId } = {}) {
  const targets = await api.post("/api/osc/targets", { name: "Lighting Console" });
  const target = targets.find((t) => t.name === "Lighting Console") ?? targets[targets.length - 1];
  await api.patch(`/api/osc/targets/${target.id}`, { host: "192.168.1.80", port: 8000 });

  const rules = [
    {
      name: "Ten minutes to service",
      trigger: { id: "pco.before-plan-time", params: { minutes: 10, timeTypes: "service" } },
      action: { id: "messages.send", params: { to: "everyone", text: "Ten minutes to service" } },
      oncePerService: true,
    },
    {
      name: "House lights down for the first song",
      trigger: { id: "pco.item-reached", params: { title: "Open Up the Sky" } },
      action: { id: "osc.send", params: { targetId: target.id, address: "/lights/preset/2" } },
      oncePerService: true,
    },
    {
      name: "Sermon lights",
      trigger: { id: "pco.item-reached", params: { title: "Message: Rooted, Part 3" } },
      action: { id: "osc.send", params: { targetId: target.id, address: "/lights/preset/5" } },
      oncePerService: true,
    },
    {
      name: "Warn when a pack runs low",
      trigger: { id: "wireless.battery-below", params: { threshold: 25 } },
      action: { id: "messages.send", params: { to: "everyone", text: "A wireless pack is below 25%, check the spares" } },
      cooldownSec: 600,
    },
    {
      name: "Announce a long service",
      trigger: { id: "service.running-over", params: { minutes: 5 } },
      conditions: [{ id: "service.is-live", params: {} }],
      action: { id: "messages.send", params: { to: "everyone", text: "We are running over, trim the last item", alert: "yes" } },
      oncePerService: true,
    },
    {
      name: "Lobby lights on",
      trigger: { id: "call.by-name", params: { name: "lobby_lights_on", says: "turn on the lobby lights", room: "Lobby" } },
      action: { id: "osc.send", params: { targetId: target.id, address: "/lights/lobby/on" } },
    },
    {
      name: "Lobby lights off",
      trigger: { id: "call.by-name", params: { name: "lobby_lights_off", says: "turn off the lobby lights", room: "Lobby" } },
      action: { id: "osc.send", params: { targetId: target.id, address: "/lights/lobby/off" } },
    },
    {
      name: "Walk-in look",
      trigger: { id: "call.by-name", params: { name: "walk_in_look", says: "start the walk-in look", room: "Auditorium" } },
      action: { id: "osc.send", params: { targetId: target.id, address: "/lights/preset/1" } },
    },
    {
      name: "Stage wash",
      trigger: { id: "call.by-name", params: { name: "stage_wash", homeAssistant: "hidden" } },
      action: { id: "osc.send", params: { targetId: target.id, address: "/lights/preset/6" } },
    },
    {
      name: "Log when Planning Center drops",
      trigger: { id: "planning-center.disconnected", params: {} },
      action: { id: "log.message", params: { message: "Planning Center disconnected" } },
    },
  ];
  const created = [];
  for (const r of rules) {
    created.push(
      await api.post("/api/automation/rules", {
        enabled: true,
        conditions: [],
        cooldownSec: 0,
        oncePerService: false,
        ...r,
      }),
    );
  }

  // Buttons on two screens name the commands, so the Commands tab has screens to put on its
  // "Used on" lines. A pair's Buttons store its base, `lobby_lights`.
  const button = (id, cue, label, x, y) => ({
    id,
    x,
    y,
    w: 0.3,
    h: 0.14,
    z: 50,
    config: { type: "cue-button", cue, label },
  });
  const onScreen = async (viewId, buttons) => {
    if (!viewId) return;
    const state = await api.get("/api/state");
    const view = state.views.find((v) => v.id === viewId);
    if (!view?.layout) return;
    await api.patch(`/api/views/${viewId}`, {
      layout: { ...view.layout, objects: [...view.layout.objects, ...buttons] },
      layoutRev: view.layoutRev ?? 0,
    });
  };
  await onScreen(consoleId, [
    button("lobby-lights-button", "lobby_lights", "Lobby lights", 0.64, 0.04),
    button("walk-in-button", "walk_in_look", "Walk-in look", 0.64, 0.2),
  ]);
  await onScreen(panelId, [button("panel-walk-in-button", "walk_in_look", "Walk-in", 0.64, 0.04)]);
  return { rules: created, groups };
}
