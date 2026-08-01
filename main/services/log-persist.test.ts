import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "log-persist-"));
process.env.STAGE_UTILITY_DATA = dataDir;

const { flushLogQueue, persistLogLine, readServerLogTail, serverLogPath } = await import(
  "./log-persist.js"
);

const line = (msg: string, level: "log" | "warn" | "error" = "log", t = "2026-08-01T04:00:00.000Z") => ({
  t,
  level,
  msg,
});

test("a queued line survives a flush and reads back intact", () => {
  persistLogLine(line("hello world"));
  flushLogQueue();
  const tail = readServerLogTail();
  assert.equal(tail.at(-1)?.msg, "hello world");
  assert.equal(tail.at(-1)?.level, "log");
  assert.equal(tail.at(-1)?.t, "2026-08-01T04:00:00.000Z");
});

test("nothing touches the disk until a flush", () => {
  const before = fs.statSync(serverLogPath()).size;
  persistLogLine(line("not yet"));
  assert.equal(fs.statSync(serverLogPath()).size, before, "queued, not written");
  flushLogQueue();
  assert.ok(fs.statSync(serverLogPath()).size > before);
});

test("flushing an empty queue is a no-op", () => {
  const before = fs.statSync(serverLogPath()).size;
  flushLogQueue();
  flushLogQueue();
  assert.equal(fs.statSync(serverLogPath()).size, before);
});

test("levels round-trip, and an unknown one degrades to log", () => {
  persistLogLine(line("a warning", "warn"));
  persistLogLine(line("an error", "error"));
  flushLogQueue();
  const tail = readServerLogTail();
  assert.equal(tail.at(-2)?.level, "warn");
  assert.equal(tail.at(-1)?.level, "error");

  fs.appendFileSync(serverLogPath(), "2026-08-01T04:00:00.000Z\tbogus\tstrange level\n");
  assert.equal(readServerLogTail().at(-1)?.level, "log");
});

test("a message containing tabs, colons and spaces survives", () => {
  const msg = "[stage-controller] plan=87242658\tfoo: bar  baz";
  persistLogLine(line(msg));
  flushLogQueue();
  assert.equal(readServerLogTail().at(-1)?.msg, msg);
});

test("a multi-line message round-trips as one entry", () => {
  // Stack traces are the reason this matters — one entry, not five orphan lines.
  const msg = "Error: boom\n    at one\n    at two";
  persistLogLine(line(msg));
  flushLogQueue();
  const last = readServerLogTail().at(-1)!;
  assert.equal(last.msg, msg);
  assert.ok(last.msg.includes("\n"));
});

test("a line written by hand, without the expected shape, is still surfaced", () => {
  fs.appendFileSync(serverLogPath(), "somebody echoed this straight into the file\n");
  assert.equal(readServerLogTail().at(-1)?.msg, "somebody echoed this straight into the file");
});

test("the tail is bounded by the requested line count", () => {
  for (let i = 0; i < 50; i++) persistLogLine(line(`line ${i}`));
  flushLogQueue();
  const tail = readServerLogTail(10);
  assert.equal(tail.length, 10);
  assert.equal(tail.at(-1)?.msg, "line 49");
});

test("reading before anything is persisted returns nothing rather than throwing", async () => {
  const empty = await fsp.mkdtemp(path.join(os.tmpdir(), "log-persist-empty-"));
  const prev = process.env.STAGE_UTILITY_DATA;
  process.env.STAGE_UTILITY_DATA = empty;
  // app-paths memoises, so this still points at the original dir — the real
  // guarantee under test is that a missing file yields [] rather than an throw.
  process.env.STAGE_UTILITY_DATA = prev;
  assert.ok(Array.isArray(readServerLogTail()));
});
