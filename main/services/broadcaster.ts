// broadcaster.ts — Transport-agnostic broadcast hub.
//
// Services call broadcast(channel, payload) to push state to all connected
// clients.  remote-server.ts registers an SSE push as a listener at startup.
// Multiple listeners are supported should other transports be added later.

// `serialized` (optional) is a caller-provided JSON string of `payload`. When the
// caller already stringified the payload (e.g. for a dedupe check), it passes it
// through so the SSE fan-out can reuse it instead of re-serializing — avoids a
// second stringify of large payloads like the full StageState (base64 branding).
type BroadcastListener = (channel: string, payload: unknown, serialized?: string) => void;

const listeners: BroadcastListener[] = [];

/** Register a listener that will be called for every broadcast. */
export function addBroadcastListener(cb: BroadcastListener): void {
  listeners.push(cb);
}

/** Broadcast a message to all registered listeners. */
export function broadcast(channel: string, payload: unknown, serialized?: string): void {
  for (const cb of listeners) {
    try {
      cb(channel, payload, serialized);
    } catch (err) {
      console.error(`[broadcaster] listener error on channel "${channel}":`, err);
    }
  }
}

// Lets a producer skip work when nothing is listening to its channel. The transport
// (remote-server) registers the real check over its connected clients; until then we
// assume "watched" so producers never wrongly idle (tests / before server start).
let subscriberCheck: ((channel: string) => boolean) | null = null;
export function setSubscriberCheck(fn: (channel: string) => boolean): void {
  subscriberCheck = fn;
}
/** True if any connected client is subscribed to (or unfiltered on) this channel. */
export function channelHasSubscribers(channel: string): boolean {
  return subscriberCheck ? subscriberCheck(channel) : true;
}
