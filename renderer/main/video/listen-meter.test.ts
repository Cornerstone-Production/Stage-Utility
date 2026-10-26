// renderer/main/video/listen-meter.test.ts — the level meter, against a fake Web
// Audio graph: what it reads, that it is never played a second time, and that it
// lets go.

import { strict as assert } from "node:assert";
import { mock, test } from "node:test";

import { METER_BARS, attachMeter } from "./listen-meter.js";

function graph(fill: (bins: Uint8Array) => void) {
  const log: string[] = [];
  const analyser = {
    fftSize: 0,
    smoothingTimeConstant: 0,
    get frequencyBinCount() {
      return 128;
    },
    getByteFrequencyData: fill,
    connect: () => log.push("analyser.connect"),
    disconnect: () => log.push("analyser.disconnect"),
  };
  const ctx = {
    destination: {},
    createMediaStreamSource: () => ({ connect: (to: unknown) => log.push(to === analyser ? "source->analyser" : "source->other"), disconnect: () => log.push("source.disconnect") }),
    createAnalyser: () => analyser,
  } as unknown as AudioContext;
  return { ctx, log };
}
const withTracks = (n: number) => ({ getAudioTracks: () => new Array(n).fill({}) }) as unknown as MediaStream;

test("the analyser's bands come out as METER_BARS levels from 0 to 1, and only the analyser is wired", () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const { ctx, log } = graph((bins) => bins.fill(255));
    const seen: number[][] = [];
    const stop = attachMeter(ctx, withTracks(1), (l) => seen.push(l), 50);
    assert.ok(stop);
    mock.timers.tick(50);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.length, METER_BARS);
    assert.ok(seen[0]!.every((v) => v === 1), "a full-scale signal did not read as full");
    assert.deepEqual(log, ["source->analyser"], "the stream was wired anywhere but the analyser (sound would play twice)");
    stop();
    mock.timers.tick(500);
    assert.equal(seen.length, 1, "the meter went on reading after it was stopped");
    assert.ok(log.includes("source.disconnect") && log.includes("analyser.disconnect"));
  } finally {
    mock.timers.reset();
  }
});

test("silence reads as zero, so a quiet feed is told apart from a broken one", () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const { ctx } = graph((bins) => bins.fill(0));
    const seen: number[][] = [];
    const stop = attachMeter(ctx, withTracks(1), (l) => seen.push(l), 50);
    mock.timers.tick(50);
    stop?.();
    assert.deepEqual(seen.at(-1), new Array(METER_BARS).fill(0));
  } finally {
    mock.timers.reset();
  }
});

test("a stream with no audio track, or a context that refuses, gives no meter and no error", () => {
  const { ctx } = graph(() => {});
  assert.equal(attachMeter(ctx, withTracks(0), () => {}), null);
  const refusing = { createMediaStreamSource: () => { throw new Error("InvalidStateError"); }, createAnalyser: () => ({}) } as unknown as AudioContext;
  assert.equal(attachMeter(refusing, withTracks(1), () => {}), null);
});
