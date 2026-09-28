import { strict as assert } from "node:assert";
import { test } from "node:test";

import { parsePorts, PORT_KEYS } from "./ports.js";

const GOOD = { rtmp: 1935, srt: 8890, webrtcUdp: 8189, webrtcHttp: 8889, hls: 8888, api: 9997 };

test("accepts six distinct in-range integers", () => {
  const r = parsePorts(GOOD);
  assert.ok(r.ok);
  assert.deepEqual(r.ports, GOOD);
});

test("the boundary values 1024 and 65535 are both accepted", () => {
  const r = parsePorts({ rtmp: 1024, srt: 1025, webrtcUdp: 1026, webrtcHttp: 1027, hls: 65535, api: 65534 });
  assert.ok(r.ok);
});

test("refuses one below 1024 or above 65535, naming the rule", () => {
  for (const bad of [{ ...GOOD, rtmp: 1023 }, { ...GOOD, api: 65536 }]) {
    const r = parsePorts(bad);
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /1024 to 65535/);
  }
});

test("refuses a non-integer, a string, and a missing key", () => {
  for (const bad of [{ ...GOOD, hls: 8888.5 }, { ...GOOD, srt: "8890" }, { rtmp: 1935 }]) {
    const r = parsePorts(bad);
    assert.equal(r.ok, false);
  }
});

test("refuses two ports sharing a value, naming that rule instead", () => {
  const r = parsePorts({ ...GOOD, api: GOOD.hls });
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /must be different/);
});

test("a non-object body refuses every key as missing, not as a crash", () => {
  assert.equal(parsePorts(null).ok, false);
  assert.equal(parsePorts("nope").ok, false);
  assert.equal(parsePorts(undefined).ok, false);
});

test("PORT_KEYS is exactly VideoPorts's six fields — every one this validates", () => {
  assert.deepEqual([...PORT_KEYS].sort(), ["api", "hls", "rtmp", "srt", "webrtcHttp", "webrtcUdp"]);
});
