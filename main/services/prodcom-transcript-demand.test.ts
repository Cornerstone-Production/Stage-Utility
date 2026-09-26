// Every transcript push skips the full-buffer spread when nothing consumes the
// channel, not just the per-utterance flush. Clearing the transcript, changing
// redaction (on by default) and a backfill used to push unconditionally; this
// pins each one to the same gate, and to still reaching an in-process consumer
// (a phrase rule) when there is one.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ProdComService } from "./prodcom-service.js";
import { addBroadcastListener, addChannelDemandSource, setSubscriberCheck } from "./broadcaster.js";

// No browser is subscribed; the only possible consumer is the demand source below.
setSubscriberCheck(() => false);
let consumerWants = false;
addChannelDemandSource("prodcom:transcript", () => consumerWants);
let pushes = 0;
addBroadcastListener((channel) => {
  if (channel === "prodcom:transcript") pushes++;
});

class TestProdCom extends ProdComService {
  public applyRows(rows: unknown[]): { added: number; skipped: number } {
    return this.applyBackfillRows(rows);
  }
}

const spokenRow = (id: string) => ({
  id,
  channelId: "CH-A",
  channelName: "Lead TB",
  text: "and all the people said amen",
  source: "audio",
  inProgress: false,
  date: new Date().toISOString(),
});

const PATHS: [string, (svc: TestProdCom) => void][] = [
  ["clearing the transcript", (svc) => svc.clearTranscript()],
  ["turning redaction off", (svc) => svc.setRedactSensitive(false)],
  ["a backfill that adds a line", (svc) => void svc.applyRows([spokenRow("backfilled-1")])],
];

describe("every transcript push is gated on something consuming it", () => {
  for (const [what, act] of PATHS) {
    it(`${what}: no push with nothing listening, one push with a consumer`, () => {
      consumerWants = false;
      pushes = 0;
      const idle = new TestProdCom();
      act(idle);
      idle.stop();
      assert.equal(pushes, 0, `${what} pushed the whole buffer with nothing consuming it`);

      consumerWants = true;
      pushes = 0;
      const watched = new TestProdCom();
      act(watched);
      watched.stop();
      assert.equal(pushes, 1, `${what} did not reach an in-process consumer`);
    });
  }
});
