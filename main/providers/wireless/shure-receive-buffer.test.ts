// A Shure link's receive buffer is capped, and resyncs at the next frame.
//
// Shure frames are `< ... >`. handleData appended every chunk to one string and
// kept whatever followed the last `>`, so a peer on 2202 streaming bytes with no
// `>` grew that string without bound and re-split it on every chunk, for as long
// as the socket stayed up. Every SSE reader in this repo is capped
// (sse-reader.ts); this one was not.
//
// Three things are pinned, from the real parser fed real chunks:
//   - the buffer stays under the cap and the drop is logged, once per run;
//   - the tail of the dropped run, up to its `>`, is NOT parsed as a frame —
//     a cap that simply emptied the buffer would hand the parser a fragment
//     that reads as a real report;
//   - the next whole frame parses normally.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ChannelState } from "./device-provider-base.js";
import { SHURE_MAX_RECEIVE_BUFFER } from "./shure-base.js";
import { ShureUlxd } from "./shure-ulxd.js";
import { captureConsole } from "../../services/fixtures/capture-console.js";

type Inner = {
  handleData(chunk: string): void;
  initChannelStates(count: number): void;
  receiveBuffer: string;
  channelStates: Map<number, ChannelState>;
};

function fresh(): Inner {
  const p = new ShureUlxd() as unknown as Inner;
  p.initChannelStates(4);
  return p;
}

/** An unterminated run longer than the cap, in chunks the size a socket hands over. */
function flood(p: Inner, chars: number): void {
  const chunk = "x ".repeat(4096);
  for (let sent = 0; sent < chars; sent += chunk.length) p.handleData(chunk);
}

describe("a Shure receive buffer", () => {
  it("is dropped past its cap, with a line saying so", (t) => {
    const lines = captureConsole(t, "warn");
    const p = fresh();
    p.handleData("< ");
    flood(p, SHURE_MAX_RECEIVE_BUFFER * 3);
    assert.ok(
      p.receiveBuffer.length <= SHURE_MAX_RECEIVE_BUFFER,
      `the buffer grew to ${p.receiveBuffer.length} chars with no frame end in sight`,
    );
    const overflow = lines.filter((l) => /receive buffer/.test(l));
    assert.equal(overflow.length, 1, `expected one overflow line per run, saw: ${JSON.stringify(lines)}`);
    assert.match(overflow[0], /^\[shure:shure-ulxd\] /);
  });

  it("does not parse the tail of the dropped run as a frame", (t) => {
    captureConsole(t, "warn", "log");
    const p = fresh();
    // One chunk past the cap, so the drop leaves the buffer empty and the next
    // chunk is all that remains of the run. Flooded in smaller chunks, some
    // padding survives the last drop and the fragment never looks like a frame,
    // so the case passes with no resync at all.
    p.handleData("< " + "x ".repeat(SHURE_MAX_RECEIVE_BUFFER));
    assert.equal(p.receiveBuffer, "", "the oversized run was not dropped");
    // This closes the oversized frame. Everything before its `>` belongs to it.
    p.handleData("REP 1 CHAN_NAME {Fragment} >");
    assert.notEqual(p.channelStates.get(1)?.name, "Fragment", "the dropped run's tail was parsed as a report");

    // And the stream is whole again from here.
    p.handleData("< REP 1 CHAN_NAME {Lead} >");
    assert.equal(p.channelStates.get(1)?.name, "Lead", "the first whole frame after a drop was not parsed");
  });

  it("leaves ordinary traffic alone", (t) => {
    const lines = captureConsole(t, "warn");
    captureConsole(t, "log");
    const p = fresh();
    // A frame split across chunks is the normal case, not an overflow.
    p.handleData("< REP 2 CHAN_NAME {Spl");
    p.handleData("it} >");
    assert.equal(p.channelStates.get(2)?.name, "Split");
    assert.equal(lines.filter((l) => /receive buffer/.test(l)).length, 0);
  });
});
