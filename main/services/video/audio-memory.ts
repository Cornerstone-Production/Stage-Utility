// main/services/video/audio-memory.ts — what the video service remembers about each
// relay feed's audio between polls and log events, in one place so forgetting a
// feed is one call.

import { OutageLog } from "../repeat-log.js";
import type { ConverterWhy } from "./audio-listen.js";

export interface AudioFeedState {
  /** The codec last seen on the feed's path while it was ready; null for "no
   *  audio track"; undefined when never seen. Kept while the feed is idle: an
   *  on-demand pull feed lists no tracks until someone watches it. */
  codec?: string | null;
  /** Why its converter is wanted, as of the last reconcile. */
  why?: ConverterWhy;
  /** The audio settings (see sourceCodec's key) the feed's `-listen` command was
   *  last applied to the relay from. What the relay reports of that path describes
   *  these settings only; after an edit it still describes the old ones until the
   *  next reconcile replaces the path. */
  plannedKey?: string;
  /** The command was replaced after an edit and the new one has not started: an
   *  exit reported now is the old process going, not the new one failing. */
  replacedUntilStart?: boolean;
  /** What a pass-through `-listen` path was seen carrying when it was not a codec
   *  a browser plays, for the audio settings in `key` only: a changed address or
   *  conversion no longer matches it. Survives a relay restart, being a fact
   *  about the source. */
  sourceCodec?: { key: string; codec: string | null };
  /** The "audio unavailable" reason last logged, so it is said once. */
  unavailableLogged?: string;
  /** MediaMTX is running its converter now, so a restart after a failure is not
   *  announced as a new start. */
  running?: boolean;
}

export class AudioMemory {
  private readonly feeds = new Map<string, AudioFeedState>();
  /** A failing converter restarts every few seconds; one failure line per run. */
  readonly outage = new OutageLog();

  get(id: string): AudioFeedState {
    let s = this.feeds.get(id);
    if (!s) {
      s = {};
      this.feeds.set(id, s);
    }
    return s;
  }

  peek(id: string): AudioFeedState | undefined {
    return this.feeds.get(id);
  }

  /** Everything about one feed, when it is removed or its source changes. */
  forget(id: string): void {
    this.feeds.delete(id);
    this.outage.forget(id);
  }

  /** What was learned from a relay process that is gone: codecs and running
   *  converters are facts about it. */
  relayGone(): void {
    for (const s of this.feeds.values()) {
      s.codec = undefined;
      s.running = false;
    }
  }
}
