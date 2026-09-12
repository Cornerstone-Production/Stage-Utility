// sse-reader.ts — one text/event-stream parser, for every consumer of one.
//
// Two hand-written copies of this existed: prodcom-service.ts and
// providers/wireless/sennheiser-spectera.ts. They had already drifted — only one
// capped its accumulation buffer, only one read `event:` names, and they
// disagreed about `\r\n` line endings — which is the "the SSE buffer cap was in
// one of two identical parsers" case CLAUDE.md names as this repo's most
// expensive recurring mistake. A third consumer is coming, so the shape comes
// out here rather than being fixed a third time.
//
// Two layers, deliberately:
//   parseSseBlock()   pure: one already-framed block → { event, data }
//   createSseReader() framing: chunks in, complete events out, buffer capped
//
// Neither touches a socket, so both are unit-testable by feeding strings (see
// sse-reader.test.ts). keepSocketAlive() is the only socket-aware export and is
// deliberately three lines.

import type { ClientRequest } from "node:http";

/** One dispatched event block. */
export type SseEvent = {
  /** The block's `event:` name, or null when it carried none. */
  event: string | null;
  /** Every `data:` line joined with "\n", per the spec. "" when there were none. */
  data: string;
};

/**
 * Default cap on the accumulation buffer.
 *
 * A stream that never sends the blank-line terminator would otherwise grow the
 * buffer without bound in a process that stays up for weeks, and re-scan an
 * ever-longer string on every chunk. Overridable because payload sizes differ by
 * an order of magnitude between consumers — a caption line against a whole
 * presentation.
 */
export const SSE_MAX_BUFFER = 256_000;

/**
 * Two consecutive line terminators end an event.
 *
 * Enumerated rather than written `(?:\r\n|\r|\n){2}`, because that form matches a
 * single CRLF as two terminators and would split every line into its own event.
 * Longest first, so `\r\n\r\n` is preferred over `\r\r` at the same index. This
 * covers a stream that is consistently LF, consistently CRLF or consistently CR;
 * framing that mixes terminators within one separator is not supported and no
 * real implementation emits it.
 */
const SEPARATOR = /\r\n\r\n|\n\n|\r\r/;

/** Line endings within a block. The two old parsers disagreed about this one. */
const LINE_BREAK = /\r\n|\n|\r/;

/** Longest separator, minus one: how much tail a resync must keep so a separator
 *  straddling the drop point is still matchable on the next chunk. */
const SEPARATOR_TAIL = 3;

/**
 * Parse one already-framed block (no trailing blank line) into an event.
 *
 * Returns null when the block dispatches nothing — empty, comments only, or
 * carrying only fields this app ignores (`id:`, `retry:`). A block with an
 * `event:` and no `data:` is NOT nothing: it reports its name with empty data.
 */
export function parseSseBlock(raw: string): SseEvent | null {
  let event: string | null = null;
  const data: string[] = [];

  for (const line of raw.split(LINE_BREAK)) {
    if (!line) continue;
    // A comment — which is also the keepalive many servers send. Belt-and-braces
    // rather than load-bearing: a leading colon yields an empty field name, which
    // the dispatch below ignores anyway. It is step one of the spec, and it is
    // what a future handler with a default branch would need.
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const rest = colon === -1 ? "" : line.slice(colon + 1);
    // Exactly one space, per the spec: "data:  x" carries a leading space that is
    // part of the value, and a payload whose own first character is a space must
    // survive.
    const value = rest.startsWith(" ") ? rest.slice(1) : rest;
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }

  if (event === null && data.length === 0) return null;
  return { event, data: data.join("\n") };
}

export type SseReaderOptions = {
  /** Buffer cap, defaulting to SSE_MAX_BUFFER. */
  maxBuffer?: number;
  /**
   * Called when the cap is hit and the reader starts discarding, once per
   * overrun rather than once per chunk. The reader does not log: prodcom and
   * Spectera each tag their own lines, and an operator reading /log needs to
   * know WHICH stream lost data.
   */
  onOverflow?: () => void;
};

export type SseReader = {
  /** Feed one decoded chunk. Returns the events it completed, in order. */
  push(chunk: string): SseEvent[];
};

/**
 * A stateful reader over one stream. Make a new one per connection — a partial
 * event does not survive a reconnect, and carrying one over would splice the tail
 * of the old stream onto the head of the new one.
 *
 * Complete events are drained BEFORE the cap is applied, so the cap bounds an
 * unterminated run rather than the size of an event that did terminate. On
 * overflow the reader resyncs: it drops the run and resumes at the next
 * separator, rather than truncating mid-event and handing the caller a fragment
 * that parses as a real event. prodcom used to truncate to the last line break
 * and its own comment named that risk — "a truncated fragment could reach the
 * wall as a caption".
 */
export function createSseReader(options: SseReaderOptions = {}): SseReader {
  const maxBuffer = options.maxBuffer ?? SSE_MAX_BUFFER;
  const onOverflow = options.onOverflow;
  let buf = "";
  /** True from an overflow until the separator that ends the discarded run. */
  let resyncing = false;

  return {
    push(chunk: string): SseEvent[] {
      buf += chunk;
      const out: SseEvent[] = [];

      for (;;) {
        const match = SEPARATOR.exec(buf);
        if (!match) break;
        const block = buf.slice(0, match.index);
        buf = buf.slice(match.index + match[0].length);
        if (resyncing) {
          // This separator terminates the run we dropped, so `block` is its tail,
          // not an event. Everything after it is whole again.
          resyncing = false;
          continue;
        }
        const event = parseSseBlock(block);
        if (event) out.push(event);
      }

      // Whatever is left has no separator in it, so it is one unterminated run.
      if (buf.length > maxBuffer) {
        if (!resyncing) onOverflow?.();
        resyncing = true;
        buf = buf.slice(-SEPARATOR_TAIL);
      }
      return out;
    },
  };
}

/**
 * Ask TCP to probe the peer every `intervalMs` once the stream goes quiet.
 *
 * A BACKSTOP, not the primary check, and the difference matters. `setKeepAlive`
 * sets only the idle time before the FIRST probe; the probe interval and the
 * count that follow are OS defaults — on Linux nine probes at 75s, so roughly
 * eleven minutes before the peer is declared dead. Nothing that takes eleven
 * minutes re-dials inside a service.
 *
 * What this buys is that the socket eventually dies rather than leaking. A
 * half-open socket (the box unplugged, its switch port dropped) emits neither
 * 'end' nor 'error', so without it nothing is ever scheduled and the panel reads
 * "connected" for the rest of the service. Every caller still needs its own
 * application-level idle watchdog for the timely half — see the one on the
 * ProPresenter stream, which fires in fifteen seconds.
 */
export function keepSocketAlive(req: ClientRequest, intervalMs: number): void {
  req.on("socket", (socket) => socket.setKeepAlive(true, intervalMs));
}
