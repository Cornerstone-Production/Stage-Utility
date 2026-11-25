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
