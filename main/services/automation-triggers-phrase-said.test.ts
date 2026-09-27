// prodcom.phrase-said, driven end-to-end.
//
// automation-triggers.test.ts proves the trigger's own didFire logic against
// hand-built snapshots. This file proves the same fix through the REAL path a
// phrase spoken mid-service actually takes: a live ProdCom box revising one
// utterance id from its first partial through to its final, over the real SSE
// client and the real prodcom:transcript broadcast — because the bug this
// guards was exactly a mismatch between what the trigger assumed about ids and
// what ProdCom actually sends on the wire.

import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";

import { ProdComService } from "./prodcom-service.js";
import { startProdComStub, type StubEntry } from "./fixtures/prodcom-stub.js";
import { addBroadcastListener, addChannelDemandSource } from "./broadcaster.js";
import { AUTOMATION_TRIGGERS } from "./automation-triggers.js";

const NOW = Date.parse("2026-09-23T12:00:00Z");

class TestProdCom extends ProdComService {
  protected override now(): number {
    return NOW;
  }
  protected override get reconnectMs(): number {
    return 25;
  }
  public settled(): Promise<void> {
    return this.priming;
  }
}

const entry = (text: string, inProgress: boolean): StubEntry => ({
  id: "utt-1",
  channelId: "CH-A",
  channelName: "Pastor",
  text,
  source: "audio",
  inProgress,
  date: new Date(NOW).toISOString(),
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

it("'let us pray' said mid-utterance fires the phrase trigger", async (t: TestContext) => {
  // The demand-gating rule (demand-gating.test.ts) requires an in-process
  // consumer registered before prodcom-service will push the channel at all.
  addChannelDemandSource("prodcom:transcript", () => true);
  const frames: unknown[] = [];
  addBroadcastListener((channel, payload) => {
    if (channel === "prodcom:transcript") frames.push(payload);
  });

  const stub = await startProdComStub({ channels: [{ id: "CH-A", name: "Pastor" }], refuseWebSocket: true });
  const svc = new TestProdCom();
  t.after(async () => {
    svc.stop();
    await stub.close();
  });
  svc.configure("127.0.0.1", stub.port, null);
  await stub.waitForSse(1);
  await svc.settled();
  await sleep(50);

  // One utterance, revised in place under one id, the way ProdCom actually
  // sends it — never a fresh id per revision.
  stub.sseSend(entry("so", true));
  await sleep(350);
  stub.sseSend(entry("so now let us", true));
  await sleep(350);
  stub.sseSend(entry("so now let us pray", true));
  await sleep(350);
  stub.sseSend(entry("So now let us pray.", false));
  await sleep(100);

  assert.ok(frames.length >= 4, `expected at least 4 transcript frames, got ${frames.length}`);

  const trigger = AUTOMATION_TRIGGERS["prodcom.phrase-said"];
  let fired = 0;
  for (let i = 1; i < frames.length; i++) {
    if (trigger.didFire(frames[i - 1], frames[i], { phrase: "let us pray" }, NOW)) fired++;
  }
  assert.equal(
    fired,
    1,
    `expected exactly one fire across ${frames.length} frames, got ${fired}: ` +
      JSON.stringify(frames.map((f) => (f as { text: string }[]).map((l) => l.text))),
  );
});
