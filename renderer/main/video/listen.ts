// renderer/main/video/listen.ts — what the Listen control decides, apart from
// how it looks: the address it plays, the one feed a page listens to, the volume
// a browser keeps, and the words for each state. Pure or store-shaped, so each
// is testable without a page.

import { useSyncExternalStore } from "react";

import { readStored, writeStored, type StorageLike } from "../../lib/safe-storage";
import type { FeedAudioStatus } from "@main/types/video";
import type { ListenOutcome, SessionPhase } from "./use-video-session";

/** The playback proxy's WHEP address for a relay path, as the relay hands out
 *  its own (mediamtx-relay.ts's `playback`). */
export function listenWhepUrl(listenPath: string): string {
  return `/video/${listenPath}/whep`;
}

/** The relay path a listener reads for this audio, or null when there is none. */
export function listenPathOf(audio: FeedAudioStatus | undefined): string | null {
  if (!audio) return null;
  return audio.state === "direct" || audio.state === "converted" || audio.state === "pass-through" ? audio.listenPath : null;
}

// ── One feed per page ───────────────────────────────────────────────────────
//
// Two rooms in your ears is never what anyone wants: the control that most
// recently asked owns the sound, and every other one reads as muted. A module
// level store, because the controls are far apart in the tree (Home cards).

let owner: string | null = null;
const listeners = new Set<() => void>();

export function listenOwner(): string | null {
  return owner;
}

/** Makes `id` the listener, or nobody (null). Another control's own claim is
 *  never cleared by `releaseListen`; see below. */
export function claimListen(id: string | null): void {
  if (owner === id) return;
  owner = id;
  for (const l of [...listeners]) l();
}

/** Gives up the sound if `id` still has it, and leaves a newer claim alone. */
export function releaseListen(id: string): void {
  if (owner === id) claimListen(null);
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}

/** The id of the control that is listening, re-rendering on a change. */
export function useListenOwner(): string | null {
  return useSyncExternalStore(subscribe, listenOwner, () => null);
}

// ── Volume ──────────────────────────────────────────────────────────────────

export const VOLUME_KEY = "stage-utility.listen-volume";
export const DEFAULT_VOLUME = 0.8;

/** 0 to 1. What a browser kept, or the default when nothing readable was. */
export function readVolume(storage?: StorageLike | null): number {
  const parse = (raw: string | null): number => {
    if (raw === null || raw.trim() === "") return DEFAULT_VOLUME;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 && n <= 1 ? n : DEFAULT_VOLUME;
  };
  return storage === undefined ? readStored(VOLUME_KEY, parse, DEFAULT_VOLUME) : readStored(VOLUME_KEY, parse, DEFAULT_VOLUME, storage);
}

/** Keeps the volume. False is a browser that will not remember it; the level
 *  still applies for this visit. */
export function writeVolume(volume: number, storage?: StorageLike | null): boolean {
  const clamped = Math.min(1, Math.max(0, volume));
  return storage === undefined ? writeStored(VOLUME_KEY, String(clamped)) : writeStored(VOLUME_KEY, String(clamped), storage);
}

// ── The element ─────────────────────────────────────────────────────────────

/** Sound on at `volume` for the element playing the listened feed. */
export function unmute(video: HTMLVideoElement, volume: number): void {
  video.muted = false;
  video.volume = volume;
}

/** The element silent again, as every video here is unless somebody is listening. */
export function mute(video: HTMLVideoElement): void {
  video.muted = true;
}

/**
 * What a browser wants from the tap itself: the element unmuted and started in the
 * gesture, so the stream the session puts on it afterwards may play with sound.
 * Resolves when the browser let it play, and rejects with its reason when not.
 */
export function startFromTap(video: HTMLVideoElement, volume: number): Promise<void> {
  unmute(video, volume);
  // A browser (or a test stub) whose play() returns nothing is not a refusal.
  return Promise.resolve(video.play());
}

// ── The words ───────────────────────────────────────────────────────────────

export type ListenTone = "muted" | "starting" | "live" | "warn" | "quiet";

export interface ListenView {
  /** Disabled: nothing can be heard from this feed here, and `text` says why. */
  disabled: boolean;
  /** Playing, or being started: the stop button and the volume show. */
  on: boolean;
  /** Playing and carrying sound: the meter and slider show. */
  playing: boolean;
  /** Empty while muted: a feed nobody is listening to carries no caption. */
  text: string;
  tone: ListenTone;
}

/**
 * The control's state, from what the feed says about its audio and how the
 * session is going. `null` means the feed offers no Listen at all (an embed or
 * an external address: nothing says what its audio is).
 */
export function listenView(input: {
  audio: FeedAudioStatus | undefined;
  /** This control holds the page's sound. */
  wanted: boolean;
  phase: SessionPhase;
  outcome: ListenOutcome;
}): ListenView | null {
  const { audio, wanted, phase, outcome } = input;
  if (!audio) return null;
  const off = { on: false, playing: false } as const;
  switch (audio.state) {
    case "none":
      return { ...off, disabled: true, text: "This feed has no audio", tone: "quiet" };
    case "unknown":
      return { ...off, disabled: true, text: "Audio is not known until the feed has been seen", tone: "quiet" };
    case "unavailable":
      return { ...off, disabled: true, text: `Audio isn't available on this server: ${audio.reason}`, tone: "warn" };
    default:
      break;
  }
  if (!wanted) return { ...off, disabled: false, text: "", tone: "muted" };
  const on = { on: true, disabled: false } as const;
  if (outcome === "needs-webrtc") {
    return { ...on, playing: false, text: "Audio needs WebRTC, and this feed is playing over HLS", tone: "warn" };
  }
  if (phase === "offline") return { ...on, playing: false, text: "Audio stopped, retrying", tone: "warn" };
  if (phase === "waiting") return { ...on, playing: false, text: "Waiting for the source", tone: "starting" };
  if (outcome === "on" && (phase === "live" || phase === "delayed")) return { ...on, playing: true, text: "Listening", tone: "live" };
  return { ...on, playing: false, text: "Starting audio…", tone: "starting" };
}
