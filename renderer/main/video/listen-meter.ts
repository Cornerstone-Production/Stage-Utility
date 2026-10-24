// renderer/main/video/listen-meter.ts — a level meter for the stream a <video> element
// is playing: a Web Audio AnalyserNode on its MediaStream, read on a timer. The analyser
// is never connected to the destination, so nothing is played twice.

import { useCallback, useEffect, useRef } from "react";

/** Bars the control draws. */
export const METER_BARS = 8;

/**
 * Starts reading `stream`'s levels, `onLevels` getting METER_BARS values from 0
 * to 1 every `intervalMs`. Null when this browser cannot (no Web Audio, or a
 * stream with no audio track): the sound is unaffected, only the meter has
 * nothing to show. The returned function stops it.
 */
export function attachMeter(
  ctx: AudioContext,
  stream: MediaStream,
  onLevels: (levels: number[]) => void,
  intervalMs = 80,
): (() => void) | null {
  if (stream.getAudioTracks().length === 0) return null;
  let source: MediaStreamAudioSourceNode;
  let analyser: AnalyserNode;
  try {
    source = ctx.createMediaStreamSource(stream);
    analyser = ctx.createAnalyser();
  } catch {
    // A context already closed, or a track that ended between the check and here.
    return null;
  }
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.6;
  source.connect(analyser);
  const bins = new Uint8Array(analyser.frequencyBinCount);
  // The speech and music band, not the empty top of the spectrum.
  const usable = Math.floor(bins.length / 2);
  const per = Math.max(1, Math.floor(usable / METER_BARS));
  const timer = setInterval(() => {
    analyser.getByteFrequencyData(bins);
    const levels: number[] = [];
    for (let b = 0; b < METER_BARS; b++) {
      let sum = 0;
      for (let i = b * per; i < (b + 1) * per; i++) sum += bins[i] ?? 0;
      levels.push(sum / per / 255);
    }
    onLevels(levels);
  }, intervalMs);
  return () => {
    clearInterval(timer);
    source.disconnect();
    analyser.disconnect();
  };
}

function audioContextCtor(): typeof AudioContext | null {
  const g = globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  return g.AudioContext ?? g.webkitAudioContext ?? null;
}

/**
 * The one AudioContext the meter reads through. `open()` makes it and must run in
 * the tap, since a context made outside a gesture starts suspended; it is closed
 * when `held` goes false or the control goes. A browser with no Web Audio, or one
 * that refuses the context, leaves `current()` null: no meter, and the sound is
 * untouched.
 */
export function useMeterContext(held: boolean): { open: () => void; current: () => AudioContext | null } {
  const ref = useRef<AudioContext | null>(null);
  const drop = useCallback(() => {
    const ctx = ref.current;
    ref.current = null;
    if (ctx && ctx.state !== "closed") ctx.close().catch((err: unknown) => console.debug("[video] the meter's audio context would not close", err));
  }, []);
  useEffect(() => (held ? drop : undefined), [held, drop]);
  const open = useCallback(() => {
    if (ref.current) return;
    const Ctor = audioContextCtor();
    if (!Ctor) return;
    try {
      const ctx = new Ctor();
      ref.current = ctx;
      ctx.resume().catch((err: unknown) => {
        console.debug("[video] the meter's audio context would not start", err);
        if (ref.current === ctx) drop();
      });
    } catch (err) {
      console.debug("[video] no audio context for the meter", err);
      ref.current = null;
    }
  }, [drop]);
  return { open, current: () => ref.current };
}
