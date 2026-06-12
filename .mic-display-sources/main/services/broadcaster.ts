// broadcaster.ts — Transport-agnostic broadcast hub.
//
// Services call broadcast(channel, payload) to push state to all connected
// clients.  In Glaze mode, index.ts wires ipcMain.broadcast as a listener.
// In standalone mode, remote-server.ts wires its SSE push.  Multiple listeners
// are supported so both can be active simultaneously.

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
