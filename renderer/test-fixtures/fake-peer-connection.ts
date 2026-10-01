// fake-peer-connection.ts — the RTCPeerConnection the video player's tests run
// against.
//
// Node has no RTCPeerConnection and jsdom ships none either, so every test that
// drives a WHEP session needs a stand-in. It extends Node's real EventTarget, so
// a `connectionstatechange` listener registered with `{ signal }` is removed by
// the real abort machinery rather than a simulation of it, and a test flips the
// state with `setConnectionState`, which dispatches the real event.
//
// Import this module STATICALLY, at the top of the test file. `installDom()`
// replaces `globalThis.Event` with jsdom's, which is a different class from
// Node's; an Event built from jsdom's constructor cannot be dispatched into
// Node's EventTarget ("parameter 1 is not of type 'Event'"). Static imports are
// evaluated before the file body calls installDom, so the constructor captured
// below is always Node's own.

/** Node's own Event constructor, for a test dispatching into any Node
 *  EventTarget (a fake <video> too) after installDom has replaced the global. */
export const NodeEvent = globalThis.Event;

/** What the fake's createOffer and every stubbed WHEP answer carry. */
export const FAKE_SDP = "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n";

export class FakePeerConnection extends EventTarget {
  /** Every instance constructed since the last `reset()`, oldest first. */
  static instances: FakePeerConnection[] = [];
  /**
   * Runs inside setRemoteDescription, before it resolves: for a test that needs
   * something to happen while the answer is still being applied (a caller
   * aborting, the browser firing `track` for a session already abandoned).
   */
  static onSetRemoteDescription: ((pc: FakePeerConnection) => void) | null = null;
  /** Every call the order of which a test asserts: "close", and whatever a
   *  test's own stubs push beside it (a fetch's method, say). */
  static log: string[] = [];

  /** When set, every answer applied fires `track` carrying this as its
   *  stream, as a browser does once the relay's video track is negotiated. */
  static trackStream: unknown = null;

  static reset(): void {
    FakePeerConnection.instances.length = 0;
    FakePeerConnection.onSetRemoteDescription = null;
    FakePeerConnection.log.length = 0;
    FakePeerConnection.trackStream = null;
  }

  iceGatheringState: RTCIceGatheringState = "complete";
  connectionState: RTCPeerConnectionState = "new";
  localDescription: { sdp: string } | null = null;
  remoteDescription: unknown = null;
  ontrack: ((e: { streams: unknown[]; track: unknown }) => void) | null = null;
  closed = false;
  /** What getStats() reports for the one inbound video stream. */
  framesReceived = 0;

  constructor() {
    super();
    FakePeerConnection.instances.push(this);
  }

  addTransceiver(): void {}

  async createOffer(): Promise<{ type: "offer"; sdp: string }> {
    return { type: "offer", sdp: FAKE_SDP };
  }

  async setLocalDescription(desc: { sdp: string }): Promise<void> {
    this.localDescription = desc;
  }

  async setRemoteDescription(desc: unknown): Promise<void> {
    this.remoteDescription = desc;
    FakePeerConnection.onSetRemoteDescription?.(this);
    if (FakePeerConnection.trackStream) this.ontrack?.({ streams: [FakePeerConnection.trackStream], track: {} });
  }

  /** The inbound-rtp video report, the one entry a player reads. */
  async getStats(): Promise<Map<string, { type: string; kind: string; framesReceived: number; framesDecoded: number }>> {
    return new Map([["in", { type: "inbound-rtp", kind: "video", framesReceived: this.framesReceived, framesDecoded: 0 }]]);
  }

  close(): void {
    this.closed = true;
    FakePeerConnection.log.push("close");
  }

  /** Flips connectionState and dispatches the real event. */
  setConnectionState(s: RTCPeerConnectionState): void {
    this.connectionState = s;
    this.dispatchEvent(new NodeEvent("connectionstatechange"));
  }
}

/** Puts FakePeerConnection on globalThis; returns the function that puts back
 *  whatever was there before. */
export function installFakePeerConnection(): () => void {
  const g = globalThis as unknown as { RTCPeerConnection?: unknown };
  const real = g.RTCPeerConnection;
  g.RTCPeerConnection = FakePeerConnection;
  return () => {
    g.RTCPeerConnection = real;
  };
}
