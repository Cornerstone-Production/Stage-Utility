// What a ProdCom box says back cannot forge a line on `/log`.
//
// ProdCom's frames carry text that people type into an intercom — a channel, a
// source, the `type` of a frame, an error message — and `/log` is a LAN-visible
// page with one record per line. A newline in any of them, written to the log
// unescaped, produces a line indistinguishable from one the server wrote.
//
// log-injection.test.ts holds the file to the rule by reading its source; this
// file runs the real handlers with hostile values and reads what actually
// reaches the console, so a scrub() that stopped working would fail here even
// where the source still looks right.
//
// The handlers are private and are reached by bracket access: they are what a
// frame arrives at, and driving them skips a socket that would add nothing to
// what is being proven.

import assert from "node:assert/strict";
import { afterEach, describe, it, type TestContext } from "node:test";

import { captureConsole } from "./fixtures/capture-console.js";
import { ProdComService } from "./prodcom-service.js";

/** What follows the newline in every hostile value. A forged record is exactly
 *  this text starting a line of its own. */
const FORGED = "[prodcom] FORGED the operator pressed Clear";

const priorDebug = process.env.PRODCOM_DEBUG;
afterEach(() => {
  if (priorDebug === undefined) delete process.env.PRODCOM_DEBUG;
  else process.env.PRODCOM_DEBUG = priorDebug;
});

/**
 * Assert that `lines` carry the hostile value, and that none of it can start a
 * record of its own.
 *
 * Both halves matter. "No line break anywhere" alone passes on a handler that
 * logged nothing; "the escaped form is present" alone passes on one that logged
 * the raw value as well as the escaped one.
 */
function assertNothingForged(lines: string[], why: string): void {
  assert.ok(lines.length > 0, `${why}: nothing was logged, so nothing was proven`);
  for (const text of lines) {
    // eslint-disable-next-line no-control-regex
    assert.doesNotMatch(text, /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/, `${why}: a control character reached the log: ${JSON.stringify(text)}`);
  }
  assert.ok(
    lines.some((l) => l.includes("\\n" + FORGED)),
    `${why}: the hostile value should appear escaped and visible: ${JSON.stringify(lines)}`,
  );
}

const frame = (o: Record<string, unknown>): string => JSON.stringify(o);
const hostile = (label: string): string => `${label}\n${FORGED}`;

/** A transcript entry in the shape findTranscriptEntry accepts. */
const entry = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "e1",
  channelId: "CH-A",
  channelName: "Lead TB",
  text: "check one two",
  final: true,
  ...extra,
});

/** Run a WebSocket frame through the real handler on a fresh service. */
function ws(t: TestContext, raw: string): string[] {
  const lines = captureConsole(t, "log", "warn", "error");
  new ProdComService()["handleWsFrame"](raw);
  return lines;
}

/** Run an SSE event's data through the real handler on a fresh service. */
function sse(t: TestContext, data: string): string[] {
  const lines = captureConsole(t, "log", "warn", "error");
  new ProdComService()["handleSseEvent"]({ event: null, data });
  return lines;
}

describe("a ProdCom frame cannot forge a /log line", () => {
  it("the welcome frame's stream names", (t) => {
    assertNothingForged(ws(t, frame({ type: "welcome", streams: [hostile("transcript")] })), "welcome streams");
  });

  it("an error frame's message", (t) => {
    assertNothingForged(ws(t, frame({ type: "error", message: hostile("boom") })), "error message");
  });

  it("the type named when a transcript frame's envelope is first seen", (t) => {
    assertNothingForged(ws(t, frame({ ...entry(), type: hostile("transcript") })), "envelope type");
  });

  it("the type named when a frame is not a transcript entry", (t) => {
    assertNothingForged(ws(t, frame({ type: hostile("mystery") })), "unknown frame type");
  });

  it("the keys named when a frame is not a transcript entry", (t) => {
    assertNothingForged(ws(t, frame({ [hostile("key")]: 1 })), "unknown frame key");
  });

  it("the source named when an entry is not spoken audio", (t) => {
    assertNothingForged(ws(t, frame({ ...entry(), source: hostile("typed") })), "entry source");
  });

  it("a frame that is not JSON, under PRODCOM_DEBUG", (t) => {
    process.env.PRODCOM_DEBUG = "1";
    assertNothingForged(ws(t, `not json\n${FORGED}`), "raw ws frame");
  });

  it("a pretty-printed JSON frame, under PRODCOM_DEBUG", (t) => {
    // Real newlines between the members: valid JSON, so the frame reaches the
    // type dispatch and not just the not-JSON branch.
    process.env.PRODCOM_DEBUG = "1";
    const raw = JSON.stringify({ type: "error", message: hostile("boom") }, null, 2);
    assert.ok(raw.includes("\n  \"type\""), "the fixture should span lines");
    assertNothingForged(ws(t, raw), "raw ws frame, pretty-printed");
  });

  it("an SSE payload, raw and not JSON", (t) => {
    process.env.PRODCOM_DEBUG = "1";
    assertNothingForged(sse(t, `not json\n${FORGED}`), "raw sse payload");
  });

  it("a raw ws frame is captured past scrub()'s default cut", (t) => {
    // See RAW_FRAME_LOG_MAX.
    process.env.PRODCOM_DEBUG = "1";
    const body = "x".repeat(1_500);
    assert.ok(ws(t, `not json ${body}`).some((l) => l.includes(body)), "a 1,500-character ws frame was cut short");
  });

  it("a raw SSE payload is captured past it too", (t) => {
    process.env.PRODCOM_DEBUG = "1";
    const body = "x".repeat(1_500);
    assert.ok(sse(t, `not json ${body}`).some((l) => l.includes(body)), "a 1,500-character sse payload was cut short");
  });
});
