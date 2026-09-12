// The shared text/event-stream reader, driven the way a socket drives it.
//
// This replaced two hand-written parsers that had already drifted apart — only
// prodcom capped its accumulation buffer, only Spectera read `event:` names, and
// neither could frame a `\r\n\r\n` stream at all. Every case below is one those
// copies got wrong, disagreed about, or would have got wrong on the next stream
// somebody pointed at them.
//
// No socket anywhere: the reader takes strings and returns events, and the chunk
// boundaries are chosen by the test rather than by the network. That is the whole
// reason the framing lives in its own module — the boundary cases that break a
// parser (a separator split across two packets, a run that never terminates)
// cannot be provoked on demand through a real connection.
//
// keepSocketAlive() is the one export not covered here. It is three lines whose
// only effect is on a real TCP socket, and a test asserting that a stub's
// setKeepAlive was called would assert that the line exists, not that a half-open
// socket is detected. It is verified by the behaviour it was added for, which
// needs hardware: unplug the peer and watch the stream error out instead of
// hanging.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createSseReader, type SseEvent, type SseReaderOptions } from "./sse-reader.js";

/** Feed every chunk to one reader and collect everything it dispatched. */
function readAll(chunks: string[], options?: SseReaderOptions): SseEvent[] {
  const reader = createSseReader(options);
  const out: SseEvent[] = [];
  for (const chunk of chunks) out.push(...reader.push(chunk));
  return out;
}

describe("an event split across chunk boundaries arrives whole and once", () => {
  it("reassembles across one boundary", () => {
    const reader = createSseReader();
    assert.deepEqual(reader.push("data: hel"), [], "half an event must not dispatch");
    assert.deepEqual(reader.push("lo\n\n"), [{ event: null, data: "hello" }]);
  });

  it("reassembles when the blank-line separator itself is split", () => {
    // The case a parser that scans only the newest chunk gets wrong: both
    // newlines of the terminator are present, but never in the same packet.
    const reader = createSseReader();
    assert.deepEqual(reader.push("data: split\n"), [], "a lone newline does not end an event");
    assert.deepEqual(reader.push("\n"), [{ event: null, data: "split" }]);
  });

  it("reassembles across three boundaries", () => {
    const reader = createSseReader();
    assert.deepEqual(reader.push("eve"), []);
    assert.deepEqual(reader.push("nt: tick\nda"), []);
    assert.deepEqual(reader.push("ta: 1\n"), []);
    assert.deepEqual(reader.push("\n"), [{ event: "tick", data: "1" }]);
  });

  it("reassembles one character at a time", () => {
    const wire = "event: tick\ndata: 1\n\n";
    assert.deepEqual(readAll([...wire]), [{ event: "tick", data: "1" }]);
  });
});

describe("framing", () => {
  it("dispatches every event in a single chunk, in order", () => {
    assert.deepEqual(readAll(["data: one\n\ndata: two\n\ndata: three\n\n"]), [
      { event: null, data: "one" },
      { event: null, data: "two" },
      { event: null, data: "three" },
    ]);
  });

  it("frames a CRLF stream", () => {
    // Neither old parser could: both scanned for "\n\n", which a \r\n\r\n stream
    // never contains, so the buffer grew until its cap and not one event was ever
    // dispatched.
    assert.deepEqual(readAll(["event: a\r\ndata: x\r\n\r\nevent: b\r\ndata: y\r\n\r\n"]), [
      { event: "a", data: "x" },
      { event: "b", data: "y" },
    ]);
  });

  it("reads CRLF line endings within a block", () => {
    assert.deepEqual(readAll(["event: mixed\r\ndata: a\r\ndata: b\r\n\r\n"]), [
      { event: "mixed", data: "a\nb" },
    ]);
  });

  it("frames a CRLF separator split across chunks", () => {
    const reader = createSseReader();
    assert.deepEqual(reader.push("data: x\r\n\r"), []);
    assert.deepEqual(reader.push("\n"), [{ event: null, data: "x" }]);
  });
});

describe("field parsing", () => {
  it("concatenates every data line with a newline, per the spec", () => {
    assert.deepEqual(readAll(["data: one\ndata: two\ndata: three\n\n"]), [
      { event: null, data: "one\ntwo\nthree" },
    ]);
  });

  it("strips one space after the colon and keeps the second", () => {
    // A payload whose own first character is a space has to survive, so the rule
    // is exactly one space, not a trim. Spectera trimmed both ends of every data
    // line; prodcom stripped all leading whitespace.
    assert.deepEqual(readAll(["data:  two spaces\n\n"]), [{ event: null, data: " two spaces" }]);
    assert.deepEqual(readAll(["data:no space\n\n"]), [{ event: null, data: "no space" }]);
    assert.deepEqual(readAll(["data: trailing  \n\n"]), [{ event: null, data: "trailing  " }]);
  });

  it("reports an event that carries no data line", () => {
    assert.deepEqual(readAll(["event: ping\n\n"]), [{ event: "ping", data: "" }]);
  });

  it("dispatches nothing for a block with no fields it knows", () => {
    assert.deepEqual(readAll(["id: 7\n\n", "\n\n"]), []);
  });

  it("ignores a comment line rather than reading it as data", () => {
    // The comment text is written to look exactly like a data line: a parser that
    // searches for "data:" anywhere in a line, instead of reading the field name
    // up to the first colon, puts the decoy in the payload.
    assert.deepEqual(readAll([":data: decoy\ndata: real\n\n"]), [{ event: null, data: "real" }]);
    assert.deepEqual(readAll([": keepalive\n\n"]), []);
  });
});

describe("a run that never terminates is capped and resynced", () => {
  it("drops only the overrun, resumes at the next separator, and reports once", () => {
    let overflows = 0;
    const reader = createSseReader({ maxBuffer: 64, onOverflow: () => overflows++ });

    assert.deepEqual(reader.push("data: before\n\n"), [{ event: null, data: "before" }]);
    assert.equal(overflows, 0, "a stream under the cap must not report an overflow");

    // One event that never terminates, arriving over several chunks.
    assert.deepEqual(reader.push(`data: ${"x".repeat(200)}`), []);
    assert.equal(overflows, 1);
    assert.deepEqual(reader.push("y".repeat(200)), []);
    assert.equal(overflows, 1, "one overrun reports once, not once per chunk");

    // The rest of the dropped run keeps arriving, and its remaining lines look
    // exactly like real ones. Resuming at the first separator WITHOUT discarding
    // what precedes it dispatches the tail of a dropped event as an event of its
    // own — prodcom's own comment named that risk: a truncated fragment reaching
    // the captions wall as a line somebody spoke.
    assert.deepEqual(reader.push("\ndata: tail of the overrun\n\ndata: after\n\n"), [
      { event: null, data: "after" },
    ]);
    assert.equal(overflows, 1);

    // And the stream keeps working afterwards.
    assert.deepEqual(reader.push("data: later\n\n"), [{ event: null, data: "later" }]);
    assert.equal(overflows, 1);
  });

  it("still finds the separator that ends the overrun when it straddles the drop", () => {
    // The dropped run ended mid-separator. Discarding the buffer down to nothing
    // loses the half that already arrived, so the terminator is never recognised,
    // the NEXT event becomes the run's tail, and it is swallowed too.
    let overflows = 0;
    const reader = createSseReader({ maxBuffer: 64, onOverflow: () => overflows++ });
    assert.deepEqual(reader.push(`data: ${"x".repeat(200)}\n`), []);
    assert.equal(overflows, 1);
    assert.deepEqual(reader.push("\ndata: after\n\n"), [{ event: null, data: "after" }]);
  });

  it("defaults the cap when none is given", () => {
    let overflows = 0;
    const reader = createSseReader({ onOverflow: () => overflows++ });
    assert.deepEqual(reader.push(`data: ${"x".repeat(255_000)}`), []);
    assert.equal(overflows, 0, "255k is under the 256000 default");
    assert.deepEqual(reader.push("x".repeat(2_000)), []);
    assert.equal(overflows, 1, "257k is over it");
  });
});
