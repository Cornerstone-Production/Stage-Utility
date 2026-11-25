// The fake Core answers in the shapes a real Core sends (Q-SYS Designer 10.0.1 in
// Emulate, probed over QRC), so every test written against it exercises them.
// Each case here is one of those shapes, as raw JSON off the wire.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { FakeQrcServer } from "./fake-qrc-server.js";
import { QrcClient } from "./qrc-client.js";

let fake: FakeQrcServer;
let client: QrcClient;

beforeEach(async () => {
  fake = new FakeQrcServer();
  fake.components.set("Lobby_Mixer", [
    { Name: "output.1.gain", Type: "Float", Value: -10, String: "-10.0dB", Position: 0.5, Direction: "Read/Write", ValueMin: -100, ValueMax: 10 },
    { Name: "output.1.mute", Type: "Boolean", Value: false, String: "unmuted", Position: 0, Direction: "Read/Write" },
  ]);
  client = await QrcClient.connect("127.0.0.1", await fake.start());
});

afterEach(async () => {
  client.close();
  await fake.stop();
});

test("Component.Set with ResponseValues answers a bare list naming the component; without it, true", async () => {
  const back = await client.send("Component.Set", { Name: "Lobby_Mixer", Controls: [{ Name: "output.1.gain", Value: -20 }], ResponseValues: true });
  assert.ok(Array.isArray(back), `a Core answers a bare list, not ${JSON.stringify(back)}`);
  assert.equal(back.length, 1);
  const [entry] = back as Record<string, unknown>[];
  assert.deepEqual(Object.keys(entry!).sort(), ["Component", "Name", "Position", "String", "Value"]);
  assert.equal(entry!.Component, "Lobby_Mixer");
  assert.equal(entry!.Value, -20);
  assert.equal(await client.send("Component.Set", { Name: "Lobby_Mixer", Controls: [{ Name: "output.1.gain", Value: -30 }] }), true);
});

test("a Boolean is true/false from GetControls, and 1/0 from Component.Get, a change group and a Set read-back", async () => {
  const listed = (await client.send("Component.GetControls", { Name: "Lobby_Mixer" })) as { Controls: { Name: string; Value: unknown }[] };
  assert.equal(listed.Controls.find((c) => c.Name === "output.1.mute")!.Value, false);

  const got = (await client.send("Component.Get", { Name: "Lobby_Mixer", Controls: [{ Name: "output.1.mute" }] })) as { Name: string; Controls: Record<string, unknown>[] };
  assert.equal(got.Name, "Lobby_Mixer");
  assert.deepEqual(got.Controls, [{ Name: "output.1.mute", Value: 0, String: "unmuted", Position: 0 }]);

  const pushes: unknown[] = [];
  client.onNotification((method, params) => {
    if (method === "ChangeGroup.Poll") pushes.push(params);
  });
  await client.send("ChangeGroup.AddComponentControl", { Id: "g", Component: { Name: "Lobby_Mixer", Controls: [{ Name: "output.1.mute" }] } });
  await client.send("ChangeGroup.AutoPoll", { Id: "g", Rate: 0.03 });
  const back = (await client.send("Component.Set", { Name: "Lobby_Mixer", Controls: [{ Name: "output.1.mute", Value: true }], ResponseValues: true })) as { Value: unknown }[];
  assert.equal(back[0]!.Value, 1, "a Set read-back carries a Boolean as a number");
  for (let i = 0; i < 1000 && pushes.length < 2; i++) await new Promise((r) => setImmediate(r));
  const values = (pushes as { Changes: { Value: unknown }[] }[]).flatMap((p) => p.Changes.map((c) => c.Value));
  assert.deepEqual(values, [0, 1], "a change group carries a Boolean as a number");
});
