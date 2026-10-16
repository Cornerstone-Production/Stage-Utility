// kiosk-installer-origin.ts — tell the macOS installer where it was fetched from.
//
// The installer downloads the Mac output helper from the server it came from, and
// a script piped into `sh` has no other way to know which server that was. The
// server stamps its own address over one marker line before it sends the file.
//
// The address comes from the request's Host header, which the client chose, and
// the result is a line in a script that runs as root. So it is checked against a
// strict shape first, and an address that does not fit is not stamped at all: the
// installer then says it has no server to download from, which is the safe way to
// fail.

/** The line in install-macos.sh this replaces. */
export const ORIGIN_MARKER = 'FETCHED_FROM=""';

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
 *  pass-through would ship an installer that cannot download. */
export function stampOrigin(script: string, origin: string | null): string {
  if (!script.split("\n").includes(ORIGIN_MARKER)) {
    throw new Error(`install-macos.sh has no ${ORIGIN_MARKER} line to stamp`);
  }
  if (origin === null) return script;
  return script.replace(`\n${ORIGIN_MARKER}\n`, `\nFETCHED_FROM="${origin}"\n`);
}
