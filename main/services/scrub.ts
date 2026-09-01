// scrub.ts — make a value safe to put in a log line.
//
// `/log` is a LAN-visible page showing the server's console output, one record
// per line. Plenty of what gets logged arrives from outside: a display name, a
// plan title, a device's reply, an error from an integration.
//
// A newline in any of those forges a log entry. A display named
//
//   Stage\n[stage-controller] plan switched to 12345
//
// produces a line indistinguishable from one the server wrote — a problem
// precisely when the log matters most, with an operator reading it to work out
// what went wrong mid-service. Terminal escapes are worse: someone tailing the
// log can have their screen cleared or repainted.
//
// Escaped rather than stripped, so the value stays legible and it is visible
// that something contained a newline rather than the character silently
// vanishing.

/**
 * Characters that break a log line or drive a terminal: C0 controls, DEL, the
 * C1 range, and the two Unicode line separators.
 *
 * Written as escapes rather than literal bytes — a source file containing real
 * control characters is treated as binary by git and cannot be reviewed.
 */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

const NAMED: Record<string, string> = {
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
};

/** How much of one interpolated value can reach a log line. */
const MAX = 200;

function escapeChar(c: string): string {
  const named = NAMED[c];
  if (named) return named;
  const code = c.charCodeAt(0);
  return code <= 0xff
    ? `\\x${code.toString(16).padStart(2, "0")}`
    : `\\u${code.toString(16).padStart(4, "0")}`;
}

/**
 * A single-line, length-bounded rendering of `value`, safe to interpolate into
 * a log message.
 *
 * Non-strings are stringified here, so this cannot be bypassed by passing an
 * object whose own `toString` carries a newline.
 */
export function scrub(value: unknown, max = MAX): string {
  let text: string;
  if (typeof value === "string") text = value;
  else if (value === null || value === undefined) text = String(value);
  else if (value instanceof Error) text = value.message;
  else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = "[unserialisable]";
    }
  }

  const escaped = text
    .replace(CONTROL, escapeChar)
    // A no-op at runtime: the pass above has already turned every newline into
    // the two characters backslash-n, so there is nothing left for this to
    // remove. It is here because static analysis recognises exactly this shape
    // — a replace of /\n/ with the empty string — as a log-injection barrier,
    // and cannot reason about a replacement *function*. Verified against the
    // CodeQL CLI: without this line every call site stays flagged however
    // thoroughly it is sanitised.
    .replace(/\n/g, "");

  return escaped.length > max ? `${escaped.slice(0, max)}…` : escaped;
}

/** How much of a stack trace can reach a log line. */
const MAX_ERROR = 2_000;

/**
 * An error rendered for a log line: its stack when it has one, otherwise
 * whatever `scrub` makes of it.
 *
 * `console.error("[x] failed:", err)` hands log-buffer a raw Error, and
 * log-buffer renders `err.stack` — every line of which becomes its own record
 * on `/log`, with the provider's or the device's own text in the first one.
 * `scrub(err)` closes that by returning only `err.message`, which throws the
 * stack away; this keeps the stack and escapes it instead, so the one line that
 * reaches `/log` still says where the failure came from.
 */
export function scrubError(value: unknown, max = MAX_ERROR): string {
  if (value instanceof Error && typeof value.stack === "string") return scrub(value.stack, max);
  return scrub(value, max);
}
