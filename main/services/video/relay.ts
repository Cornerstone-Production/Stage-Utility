// main/services/video/relay.ts — the one interface everything outside
// main/services/video/ sees for the video relay.
//
// mediamtx-relay.ts is the only implementation: MediaMTX's own loopback REST
// API, made to match a feed list. reconcile-plan.ts works out WHAT to change
// without ever touching the network; mediamtx-relay.ts is what turns that
// plan into HTTP calls.

/** A feed as the relay needs to know it — nothing more. A pull feed's
 *  `source` is a full URL with any credentials already folded in (query
 *  string or userinfo, whichever the protocol takes); a push feed's
 *  `password` is what a device must send to publish to it. */
export type RelayFeed =
  | { id: string; kind: "pull"; source: string }
  | { id: string; kind: "push"; password: string };

/** One path as the relay's runtime API reports it. */
export interface RelayPath {
  name: string;
  ready: boolean;
  readyTime: string | null;
  source: { type: string; id: string } | null;
  video: { codec: string; width?: number; height?: number; profile?: string } | null;
  readers: number;
}

/** What `reconcile` throws when the relay took the user change and some
 *  paths but rejected others. `failedPaths` names the paths that were NOT
 *  set up (a feed's path is its id), so a caller can still treat every other
 *  feed as given to the relay. The message names each failure. */
export class RelayReconcileError extends Error {
  constructor(
    message: string,
    readonly failedPaths: readonly string[],
  ) {
    super(message);
    this.name = "RelayReconcileError";
  }
}

export interface VideoRelay {
  /** Make the relay's paths and publish users match `feeds` exactly. Throws
   *  a RelayReconcileError when only some paths failed. */
  reconcile(feeds: RelayFeed[]): Promise<void>;
  /** Every path the relay has, or throws when the relay does not answer. */
  status(): Promise<RelayPath[]>;
  /** Same-origin playback URLs for a feed. */
  playback(feedId: string): { whep: string; hls: string };
  /** Drop whoever is publishing to a feed, so a new password takes effect
   *  now. Resolves true when a publisher was actually dropped, false when
   *  nobody was publishing — the editor tells the operator which one
   *  happened, not just that the call did not throw. */
  kickPublisher(feedId: string): Promise<boolean>;
}
