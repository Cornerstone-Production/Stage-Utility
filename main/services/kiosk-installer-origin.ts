// kiosk-installer-origin.ts — tell an installer where it was fetched from.
//
// The macOS installer downloads the Mac output helper from the server it came
// from, and the Windows installer its launcher; both then remember that server as
// the one to ask for updates. A script piped into `sh` or `iex` has no other way to
// know which server that was. The server stamps its own address over one marker
// line before it sends the file.
//
// The address comes from the request's Host header, which the client chose, and
// the result is a line in a script that runs as root. So it is checked against a
// strict shape first, and an address that does not fit is not stamped at all: the
// installer then says it has no server to download from, which is the safe way to
// fail.

/** The line in install-macos.sh this replaces. */
export const ORIGIN_MARKER = 'FETCHED_FROM=""';
/** The line in install-windows.ps1 this replaces. */
export const WINDOWS_ORIGIN_MARKER = "$FetchedFrom = ''";

/** Each stamped installer's marker line and what it becomes. A Map: the name is
 *  from a request path (allowlisted before it gets here). */
const MARKERS = new Map<string, { marker: string; line: (origin: string) => string }>([
  ["install-macos.sh", { marker: ORIGIN_MARKER, line: (o) => `FETCHED_FROM="${o}"` }],
  ["install-windows.ps1", { marker: WINDOWS_ORIGIN_MARKER, line: (o) => `$FetchedFrom = '${o}'` }],
]);

/** Whether this installer is one the server stamps. */
export function isStamped(name: string): boolean {
  return MARKERS.has(name);
}

/** A hostname, an IPv4 address or a bracketed IPv6 address, then an optional port.
 *  Nothing a shell reads as syntax can match. */
const HOST_RE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*|\[[0-9A-Fa-f:.]{2,45}\])(?::\d{1,5})?$/;

/** `http://host:port` for a Host header, or null when the header is not one. */
export function originFromHost(host: string | undefined, secure: boolean): string | null {
  if (!host || host.length > 255 || !HOST_RE.test(host)) return null;
  return `${secure ? "https" : "http"}://${host}`;
}

/** The installer with its origin filled in. Throws when the marker is missing:
 *  that is a change to the script this module has not been taught, and a silent
 *  pass-through would ship an installer that cannot download. Both installers'
 *  quotes hold the address safely: HOST_RE admits no quote of either kind. */
export function stampOrigin(script: string, origin: string | null, name = "install-macos.sh"): string {
  const m = MARKERS.get(name);
  if (!m) throw new Error(`${name} is not an installer the server stamps`);
  // A Windows script saved with CRLF line ends still has its marker as a line.
  const lines = script.split("\n").map((l) => l.replace(/\r$/, ""));
  if (!lines.includes(m.marker)) {
    throw new Error(`${name} has no ${m.marker} line to stamp`);
  }
  if (origin === null) return script;
  return script.replace(new RegExp(`(^|\n)${escapeRe(m.marker)}(\r?\n)`), (_all, before: string, after: string) => `${before}${m.line(origin)}${after}`);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
