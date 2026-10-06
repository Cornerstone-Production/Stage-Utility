// fake-hls.ts — a stand-in for hls.js, handed to hls-player.ts through
// __setHlsLoaderForTests.
//
// Under Node hls.js loads but has no MediaSource to attach to, so it cannot be
// driven here. This records what startHls asked of it, raises ERROR events the
// way hls.js does, and reports a fixed latency for the "N s behind" badge.
// `installFakeHls` also defines a MediaSource, which is what sends startHls to
// hls.js rather than native HLS.

import { __setHlsLoaderForTests } from "../main/video/hls-player.js";

type Listener = (event: string, data: { fatal: boolean; details?: string; type: string }) => void;

export class FakeHls {
  static Events = { ERROR: "hlsError" };
  /** The most recently constructed instance, or null. */
  static last: FakeHls | null = null;
  /** Every instance constructed since installFakeHls. */
  static instances: FakeHls[] = [];
  readonly calls: string[] = [];
  latency = 3.4;
  private listeners: Listener[] = [];
  constructor() {
    FakeHls.last = this;
    FakeHls.instances.push(this);
  }
  on(event: string, fn: Listener): void {
    if (event === FakeHls.Events.ERROR) this.listeners.push(fn);
  }
  loadSource(url: string): void {
    this.calls.push(`loadSource ${url}`);
  }
  attachMedia(): void {
    this.calls.push("attachMedia");
  }
  destroy(): void {
    this.calls.push("destroy");
  }
  /** Raise an ERROR the way hls.js does. */
  raise(data: { fatal: boolean; details?: string; type: string }): void {
    for (const fn of this.listeners) fn(FakeHls.Events.ERROR, data);
  }
}

const g = globalThis as unknown as { MediaSource?: unknown };

/**
 * Routes startHls to FakeHls. `load` defaults to resolving at once; a test that
 * needs the import still in flight passes its own. Returns the undo.
 */
export function installFakeHls(load?: () => Promise<unknown>): () => void {
  FakeHls.last = null;
  FakeHls.instances.length = 0;
  const hadMediaSource = "MediaSource" in g;
  const realMediaSource = g.MediaSource;
  g.MediaSource = class {};
  __setHlsLoaderForTests((load ?? (async () => ({ default: FakeHls }))) as () => Promise<typeof import("hls.js")>);
  return () => {
    __setHlsLoaderForTests(null);
    if (hadMediaSource) g.MediaSource = realMediaSource;
    else delete g.MediaSource;
  };
}
