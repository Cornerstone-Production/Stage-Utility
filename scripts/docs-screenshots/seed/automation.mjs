// seed/automation.mjs — rules, and the OSC target they point at.

export async function seedAutomation(api, { groups } = {}) {
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
  return { rules: created, groups };
}
