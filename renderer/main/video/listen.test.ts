// renderer/main/video/listen.test.ts — what the Listen control decides, with no page.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { DEFAULT_VOLUME, VOLUME_KEY, listenPathOf, listenView, readVolume, writeVolume } from "./listen.js";

const memory = (initial: Record<string, string> = {}) => {
  const map = new Map(Object.entries(initial));
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), map };
};
const throwing = {
  getItem: (): string | null => {
    throw new Error("SecurityError");
  },
  setItem: (): void => {
    throw new Error("QuotaExceededError");
  },
};

test("the volume is what the browser kept, and the default for nothing, garbage or a refusal to read", () => {
  assert.equal(readVolume(memory()), DEFAULT_VOLUME);
  assert.equal(readVolume(memory({ [VOLUME_KEY]: "0.35" })), 0.35);
  assert.equal(readVolume(memory({ [VOLUME_KEY]: "0" })), 0, "a deliberate zero is not 'nothing'");
  for (const bad of ["loud", "", "1.5", "-0.2", "NaN"]) assert.equal(readVolume(memory({ [VOLUME_KEY]: bad })), DEFAULT_VOLUME, JSON.stringify(bad));
  assert.equal(readVolume(throwing), DEFAULT_VOLUME);
  assert.equal(readVolume(null), DEFAULT_VOLUME);
});

test("writing the volume says whether it stuck, and never throws", () => {
  const m = memory();
  assert.equal(writeVolume(0.4, m), true);
  assert.equal(m.map.get(VOLUME_KEY), "0.4");
  assert.equal(writeVolume(7, m), true);
  assert.equal(m.map.get(VOLUME_KEY), "1", "a level past the end is held to it");
  assert.equal(writeVolume(0.4, throwing), false);
  assert.equal(writeVolume(0.4, null), false);
});

test("the path a listener reads is the status's, and none for a status without one", () => {
  assert.equal(listenPathOf({ state: "direct", listenPath: "cam" }), "cam");
  assert.equal(listenPathOf({ state: "converted", listenPath: "cam-listen" }), "cam-listen");
  assert.equal(listenPathOf({ state: "pass-through", listenPath: "cam-listen" }), "cam-listen");
  for (const s of [{ state: "none" }, { state: "unknown" }, { state: "unavailable", reason: "x" }] as const) assert.equal(listenPathOf(s), null, s.state);
  assert.equal(listenPathOf(undefined), null);
});

test("each state of the control reads as the design words it", () => {
  const converted = { state: "converted", listenPath: "a-listen" } as const;
  const text = (input: Parameters<typeof listenView>[0]) => listenView(input)?.text;
  assert.equal(listenView({ audio: undefined, wanted: false, phase: "live", outcome: "off" }), null);
  assert.equal(text({ audio: { state: "none" }, wanted: false, phase: "live", outcome: "off" }), "This feed has no audio");
  assert.equal(
    text({ audio: { state: "unavailable", reason: "ffmpeg is not installed on this server" }, wanted: false, phase: "live", outcome: "off" }),
    "Audio isn't available on this server: ffmpeg is not installed on this server",
  );
  assert.equal(text({ audio: converted, wanted: false, phase: "live", outcome: "off" }), "");
  assert.equal(text({ audio: converted, wanted: true, phase: "connecting", outcome: "on" }), "Starting audio…");
  assert.equal(text({ audio: converted, wanted: true, phase: "live", outcome: "on" }), "Listening");
  assert.equal(text({ audio: converted, wanted: true, phase: "offline", outcome: "on" }), "Audio stopped, retrying");
  assert.match(text({ audio: converted, wanted: true, phase: "delayed", outcome: "hls" }) ?? "", /playing over HLS/);
  assert.match(text({ audio: converted, wanted: true, phase: "cant-play", outcome: "cant-play" }) ?? "", /which this browser cannot play/);
  assert.equal(text({ audio: converted, wanted: true, phase: "waiting", outcome: "off" }), "Waiting for the source");
  assert.equal(text({ audio: { state: "unknown" }, wanted: false, phase: "live", outcome: "off" }), "Audio is not known until the feed has been seen");
  assert.equal(text({ audio: converted, wanted: false, phase: "live", outcome: "off", failure: "WHEP 503" }), "Audio could not start: WHEP 503", "a failure shows until the next tap");
  assert.equal(listenView({ audio: converted, wanted: false, phase: "live", outcome: "off", failure: "WHEP 503" })?.disabled, false, "a failed attempt must leave the button usable");
  assert.equal(listenView({ audio: converted, wanted: true, phase: "live", outcome: "on", failure: "old" })?.text, "Listening", "a stale failure outranked a live session");

  const disabled = (audio: Parameters<typeof listenView>[0]["audio"]) => listenView({ audio, wanted: true, phase: "live", outcome: "on" })?.disabled;
  assert.equal(disabled({ state: "none" }), true);
  assert.equal(disabled({ state: "unknown" }), true);
  assert.equal(disabled({ state: "unavailable", reason: "x" }), true);
  assert.equal(disabled(converted), false);
  assert.equal(listenView({ audio: converted, wanted: true, phase: "live", outcome: "on" })?.playing, true);
  assert.equal(listenView({ audio: converted, wanted: true, phase: "connecting", outcome: "on" })?.playing, false, "the meter and slider wait for the sound");
});
