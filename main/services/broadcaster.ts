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

/**
 * In-process consumers, keyed by channel.
 *
 * `channelHasSubscribers` can only see BROWSERS. The automation engine is not
 * one — it listens on this bus inside the process — so gating a broadcast, or a
 * poll cadence, on the subscriber check alone silently disabled every rule that
 * read the channel. An SPL threshold rule fired only while somebody happened to
 * have a meter open, which on an unattended appliance is never, and the operator
 * saw an enabled rule that had simply never run with no error anywhere.
 *
 * Keyed by channel rather than held per service because the producers are not
 * one kind of object: StatusIntegration, stage-controller and prodcom-service
 * all gate on the same question, and three copies of the list is three chances
 * to fix two of them.
 */
const demandSources = new Map<string, (() => boolean)[]>();

/**
 * Register a consumer that needs `channel` produced even with no browser
 * attached. A callback rather than an import because the consumer is the side
 * that imports the producer.
 */
export function addChannelDemandSource(channel: string, wantsBroadcast: () => boolean): void {
  const existing = demandSources.get(channel);
  if (existing) existing.push(wantsBroadcast);
  else demandSources.set(channel, [wantsBroadcast]);
}

/** How many in-process consumers have registered for a channel. For tests: an
 *  unregistered consumer is invisible in behaviour until the day it matters. */
export function channelDemandSourceCount(channel: string): number {
  return demandSources.get(channel)?.length ?? 0;
}

/** Is anything — a browser or an in-process consumer — actually using this? */
export function channelInDemand(channel: string): boolean {
  if (channelHasSubscribers(channel)) return true;
  return (demandSources.get(channel) ?? []).some((wants) => wants());
}
