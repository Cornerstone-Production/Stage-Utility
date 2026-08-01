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
    // Redundant after the pass above, and deliberately kept. Static analysis
    // recognises a literal newline-stripping replace as a log-injection
    // sanitiser; it cannot see through `CONTROL`, which is a named character
    // class defined elsewhere. Without this line every call site stays flagged
    // however thoroughly it is sanitised, and 43 known-mitigated findings sit
    // on the dashboard training people to ignore it.
    .replace(/[\r\n]/g, "");

  return escaped.length > max ? `${escaped.slice(0, max)}…` : escaped;
}
