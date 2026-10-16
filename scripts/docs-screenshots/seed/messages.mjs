// seed/messages.mjs — stage message groups, the screens' membership, a day's thread
// and the replies that came back from the stage panels.

export async function seedMessages(api, layouts) {
  const { outputs, widgets } = layouts;
  const current = await api.get("/api/messaging");
  const saved = await api.put("/api/messaging", {
    version: current.version,
    groups: [{ name: "Stage" }, { name: "Green Room" }, { name: "Booth" }],
    quickMessages: current.quickMessages,
    quickReplies: current.quickReplies,
  });
  const group = (name) => saved.groups.find((g) => g.name === name).id;

  const membership = [
    [outputs.stageMonitors, ["Stage"]],
    [outputs.wall, ["Stage"]],
    [outputs.stageLeft, ["Stage", "Booth"]],
    [outputs.greenRoom, ["Green Room"]],
    [outputs.greenPanel, ["Green Room"]],
    [outputs.lobby, []],
  ];
  for (const [id, names] of membership) await api.patch(`/api/outputs/${id}`, { groups: names.map(group) });

  const send = (to, text, from) => api.post("/api/messages", { to, text, from });
  const first = await send([group("Stage")], "Band back on stage in 5 minutes", "Jamie Park");
  const second = await send([group("Stage")], "You're on after this song", "Jamie Park");
  const third = await send([group("Green Room")], "Pastor, you're up after the second song", "Quinn Murphy");
  const fourth = await send(["everyone"], "Running about 3 minutes long, trim the last chorus", "Jamie Park");

  const reply = (message, text, outputId, objectId) =>
    api.post(`/api/messages/${message.id}/replies`, { text, objectId, outputId });
  await reply(first, "Copy", outputs.stageLeft, widgets.panelMessages);
  await reply(second, "Walking now", outputs.stageLeft, widgets.panelMessages);
  await reply(third, "Need 2 min", outputs.greenPanel, widgets.panelMessages);
  await reply(fourth, "Copy", outputs.stageLeft, widgets.panelMessages);
  await reply(fourth, "Copy", outputs.greenPanel, widgets.panelMessages);

  return { groups: saved.groups };
}
