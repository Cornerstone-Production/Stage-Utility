// renderer/main/video/listen.ts — what the Listen control decides apart from how it
// looks: the one feed a page listens to, the volume a browser keeps, and the words
// for each state.

import { useSyncExternalStore } from "react";

import { readStored, writeStored, type StorageLike } from "../../lib/safe-storage";
import type { FeedAudioStatus } from "@main/types/video";
import type { ListenOutcome, SessionPhase } from "./use-video-session";

/** The relay path a listener reads for this audio, or null when there is none. */
export function listenPathOf(audio: FeedAudioStatus | undefined): string | null {
  if (!audio) return null;
  return audio.state === "direct" || audio.state === "converted" || audio.state === "pass-through" ? audio.listenPath : null;
}

// One feed per page: the control that most recently asked owns the sound and every
// other one reads as muted. Module level because the controls are far apart in the
// tree (Home cards).
let owner: string | null = null;
const listeners = new Set<() => void>();

function setOwner(id: string | null): void {
  if (owner === id) return;
  owner = id;
  for (const l of [...listeners]) l();
}

export function claimListen(id: string): void {
  setOwner(id);
}

/** Gives up the sound if `id` still has it; a newer claim by another control is left alone. */
export function releaseListen(id: string): void {
  if (owner === id) setOwner(null);
}

/** Forgets every claim (a test's). */
export function __resetListenForTests(): void {
  setOwner(null);
}

/** Who holds the sound, read outside any React tree (a test's). */
export function __listenOwnerForTests(): string | null {
  return owner;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}

/** The id of the control that is listening, re-rendering on a change. */
export function useListenOwner(): string | null {
  return useSyncExternalStore(subscribe, () => owner, () => null);
}

// ── Volume ──────────────────────────────────────────────────────────────────

export const VOLUME_KEY = "stage-utility.listen-volume";
export const DEFAULT_VOLUME = 0.8;

const parseVolume = (raw: string | null): number => {
  if (raw === null || raw.trim() === "") return DEFAULT_VOLUME;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : DEFAULT_VOLUME;
};

/** 0 to 1: what the browser kept, or the default when nothing readable was. `storage` is a test's. */
export function readVolume(storage?: StorageLike | null): number {
  return readStored(VOLUME_KEY, parseVolume, DEFAULT_VOLUME, storage);
}

/** Keeps the volume. False is a browser that will not remember it; the level still applies for this visit. */
export function writeVolume(volume: number, storage?: StorageLike | null): boolean {
  return writeStored(VOLUME_KEY, String(Math.min(1, Math.max(0, volume))), storage);
}

// ── The element ─────────────────────────────────────────────────────────────

/** Sound on at `volume`, or off for null. Here rather than in the component, which may not write to an element it is handed. */
export function setSound(video: HTMLVideoElement, volume: number | null): void {
  video.muted = volume === null;
  if (volume !== null) video.volume = volume;
}

/** What a browser wants from the tap itself: the element unmuted and started in the gesture, so the stream the session puts on it afterwards may play with sound. Rejects with the browser's reason. */
export function startFromTap(video: HTMLVideoElement, volume: number): Promise<void> {
  setSound(video, volume);
  return video.play();
}

// ── The words ───────────────────────────────────────────────────────────────

export type ListenTone = "plain" | "starting" | "live" | "warn";

export interface ListenView {
  /** Disabled: nothing can be heard from this feed here, and `text` says why. */
  disabled: boolean;
  /** Playing, or being started: the stop button shows. */
  on: boolean;
  /** Playing and carrying sound: the meter and slider show. */
  playing: boolean;
  /** Empty while muted: a feed nobody is listening to carries no caption. */
  text: string;
  /** How the caption is drawn: a warning when something is wrong but nothing is broken. */
  tone: ListenTone;
}

/**
 * The control's state, from what the feed says about its audio and how the
 * session is going. `null` means the feed offers no Listen at all (an embed or an
 * external address: nothing says what its audio is). `failure` is why the last
 * attempt to listen gave up, shown until the next tap.
 */
export function listenView(input: {
  audio: FeedAudioStatus | undefined;
  /** This control holds the page's sound. */
  wanted: boolean;
  phase: SessionPhase;
  outcome: ListenOutcome;
  failure?: string | null;
}): ListenView | null {
  const { audio, wanted, phase, outcome, failure } = input;
  if (!audio) return null;
  const idle = { on: false, playing: false } as const;
  const note = (text: string, tone: ListenTone = "plain") => ({ ...idle, disabled: true, text, tone });
  if (audio.state === "none") return note("This feed has no audio");
  if (audio.state === "unknown") return note("Audio is not known until the feed has been seen");
  if (audio.state === "unavailable") return note(`Audio isn't available on this server: ${audio.reason}`, "warn");
  if (!wanted) return failure ? { ...idle, disabled: false, text: `Audio could not start: ${failure}`, tone: "warn" } : { ...idle, disabled: false, text: "", tone: "plain" };
  const on = { on: true, disabled: false, playing: false } as const;
  if (outcome === "hls") return { ...on, text: "Audio needs WebRTC, and this feed is playing over HLS", tone: "warn" };
  if (outcome === "cant-play") return { ...on, text: "Audio needs WebRTC, which this browser cannot play for this feed", tone: "warn" };
  if (phase === "offline") return { ...on, text: "Audio stopped, retrying", tone: "warn" };
  if (phase === "waiting") return { ...on, text: "Waiting for the source", tone: "starting" };
  if (outcome === "on" && (phase === "live" || phase === "delayed")) return { ...on, playing: true, text: "Listening", tone: "live" };
  return { ...on, text: "Starting audio…", tone: "starting" };
}
