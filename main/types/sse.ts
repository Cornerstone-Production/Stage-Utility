// The /api/events heartbeat, shared by the server that sends it and the pages that
// read it.
//
// The server writes one to every open stream every SSE_HEARTBEAT_MS. Writing it is
// what reaps a half-open or stalled client on the server's side. It is a NAMED
// event rather than an SSE comment so a page can see it too: EventSource surfaces
// no comments, and a server that has stopped sending (frozen, or a connection that
// went quiet without closing) otherwise looks, to a page, exactly like a quiet
// afternoon. A page that has heard nothing at all, heartbeat included, for
// SSE_SILENCE_MS takes its stream as not delivering (renderer/lib/api.ts and the
// shared worker). Every other reader of /api/events subscribes to the channels it
// wants by name and ignores this one: the Companion module, the Home Assistant
// integration, and the pages' own channel listeners.

/** How often the server writes a heartbeat to each open stream. */
export const SSE_HEARTBEAT_MS = 20_000;

/** The heartbeat's event name. Not a channel: no client subscribes to it, and every client is sent it. */
export const SSE_HEARTBEAT_EVENT = "sse:heartbeat";

/** The heartbeat as written to the stream. A named event with no data is never dispatched, so it carries `{}`. */
export const SSE_HEARTBEAT_FRAME = `event: ${SSE_HEARTBEAT_EVENT}\ndata: {}\n\n`;

/** How long a page may hear nothing on its stream before it takes it as down: two and a half heartbeats. */
export const SSE_SILENCE_MS = Math.round(SSE_HEARTBEAT_MS * 2.5);
