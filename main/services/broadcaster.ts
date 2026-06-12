// broadcaster.ts — Transport-agnostic broadcast hub.
//
// Services call broadcast(channel, payload) to push state to all connected
// clients.  remote-server.ts registers an SSE push as a listener at startup.
// Multiple listeners are supported should other transports be added later.

type BroadcastListener = (channel: string, payload: unknown) => void;

const listeners: BroadcastListener[] = [];

/** Register a listener that will be called for every broadcast. */
export function addBroadcastListener(cb: BroadcastListener): void {
  listeners.push(cb);
}

/** Broadcast a message to all registered listeners. */
export function broadcast(channel: string, payload: unknown): void {
  for (const cb of listeners) {
    try {
      cb(channel, payload);
    } catch (err) {
      console.error(`[broadcaster] listener error on channel "${channel}":`, err);
    }
  }
}
