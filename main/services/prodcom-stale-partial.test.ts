// A transcript line whose final never arrives must not sit there for ever.
//
// A partial is held per CHANNEL KEY and removed on exactly one event: a final on
// that same key. Rename or re-route a channel in ProdCom mid-service and the key
// changes — the final for the speech already in flight arrives under the NEW key,
// nothing ever deletes the old entry, and because getBuffer() appends partials
// AFTER finals it is pinned to the bottom of the display.
//
// That is not hypothetical. At a kickoff, channels were renamed and re-routed
// mid-service; one grey line sat under everything for the rest of the night,
// dropping back to the bottom as real lines scrolled past, and nothing in the UI
// could clear it. `partials` had no cap, no TTL, and was not cleared on
// reconnect, so the only exit was restarting the server.
//
// This drives the REAL SSE path — raw event text through handleEvent — rather
// than calling ingest() with hand-made objects, because the bug is about which
// key a line lands under, and a test that picked the key itself would assert
// nothing.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ProdComService } from "./prodcom-service.js";

/** The service with a clock we control and its event entry point exposed. */
class TestProdCom extends ProdComService {
  public clock = 1_000_000;
  protected override now(): number {
    return this.clock;
  }
  public feed(payload: Record<string, unknown>): void {
    this.handleEvent(`data: ${JSON.stringify(payload)}`);
  }
  public lines(): { text: string; isFinal: boolean }[] {
    return this.getBuffer().map((l) => ({ text: l.text, isFinal: l.isFinal }));
  }
}

const partial = (channelId: string, text: string) => ({
  id: `${channelId}-live`, channelId, channelName: channelId, text, inProgress: true,
});
const final = (channelId: string, text: string) => ({
  id: `${channelId}-${text}`, channelId, channelName: channelId, text, inProgress: false,
});

describe("a partial orphaned by a channel rename", () => {
  it("is dropped once it goes stale, instead of sitting at the bottom for ever", () => {
    const svc = new TestProdCom();

    // Somebody is talking on channel "EM".
    svc.feed(partial("EM", "that's good yeah we're good what was that"));
    assert.equal(svc.lines().length, 1, "the partial is showing, as it should be");

    // The operator renames/re-routes the channel in ProdCom. The final for that
    // same speech now arrives under a DIFFERENT key.
    svc.feed(final("EM-2", "that's good yeah we're good what was that"));

    // Before the fix this stayed at 2 for ever: the orphan plus the real line.
    svc.clock += 31_000;
    const after = svc.lines();
    assert.equal(after.length, 1, `the orphaned partial is still here: ${JSON.stringify(after)}`);
    assert.equal(after[0].isFinal, true, "what survives is the finalised line");
  });

  it("but a partial that is still being spoken is never dropped", () => {
    // The TTL must not cut off live speech. Partials update many times a second,
    // so each update refreshes the entry.
    const svc = new TestProdCom();
    svc.feed(partial("EM", "this is"));
    for (let i = 0; i < 5; i++) {
      svc.clock += 20_000; // under the TTL each time
      svc.feed(partial("EM", `this is a long sentence ${i}`));
    }
    assert.equal(svc.lines().length, 1);
    assert.equal(svc.lines()[0].isFinal, false, "still live");
  });

  it("a final on the same channel still clears its partial immediately", () => {
    // The original mechanism has to keep working — the TTL is a backstop, not a
    // replacement for it.
    const svc = new TestProdCom();
    svc.feed(partial("EM", "hello"));
    svc.feed(final("EM", "hello there"));
    const lines = svc.lines();
    assert.equal(lines.length, 1);
    assert.equal(lines[0].isFinal, true);
    assert.equal(lines[0].text, "hello there");
  });

  it("clearTranscript empties both halves", () => {
    // What the operator's button calls. Finals AND partials, because a stuck line
    // is a partial and "clear the screen" means the finals.
    const svc = new TestProdCom();
    svc.feed(final("A", "one"));
    svc.feed(final("A", "two"));
    svc.feed(partial("B", "mid sentence"));
    assert.equal(svc.lines().length, 3);

    svc.clearTranscript();
    assert.deepEqual(svc.lines(), [], "the display must go empty");
  });

  it("dropping the stream clears in-flight speech but keeps the record", () => {
    // A reconnect must not blank a display mid-service, but an utterance that was
    // in flight when the socket went will be re-sent or finalised on the other
    // side — keeping it here is how the orphan outlived the connection too.
    const svc = new TestProdCom();
    svc.feed(final("A", "already said"));
    svc.feed(partial("B", "half a sentence"));
    svc.stop();
    const lines = svc.lines();
    assert.equal(lines.length, 1, "the partial went with the stream");
    assert.equal(lines[0].text, "already said", "the finalised line stayed");
  });
});
