// pinned-origin.ts — the one way a credentialed request URL is put back on its
// vendor's origin.
//
// Every integration that attaches a stored credential to a request owns ONE fetch
// helper per origin, and that helper passes its URL through `pinToOrigin` before
// the request is made. The helper takes a branded URL type (a string a caller
// cannot write by hand), and the pin is the second half of the promise: even a URL
// that got past the brand by a cast goes out on the integration's own origin,
// never another. pco-service.ts `pinnedToPco` is the same idea for Planning
// Center; docs/reference/code-scanning.md lists every helper and its origin.
//
// Built by ASSIGNMENT onto the origin's URL, never `new URL(path, origin)`. The
// two-argument constructor re-parses its first argument, and a pathname beginning
// `//` is read as a protocol-relative authority, so `https://vendor.example//evil.example/x`
// (whose origin really is the vendor's) would rebuild as https://evil.example/x
// with the credential attached. The setters write one component each and cannot
// touch the origin.

import { scrub } from "./scrub.js";

/**
 * `candidate`'s path and query on `origin`, which is `https://host[:port]` with
 * nothing after it (the caller made it: a constant, or a validated operator
 * setting). Throws when `candidate` does not parse, because a URL that cannot be
 * read is a URL somebody built wrong, and a request that quietly went elsewhere
 * with a credential on it is not a failure to swallow.
 *
 * When the rebuild MOVES the request (a different origin, or credentials written
 * into the URL) the code that built the URL has a bug. That is logged on `tag`'s
 * line, by origin only: the path may carry a credential (a SafeSpace space id), so
 * it never goes in the line. The pinned URL is still the one sent.
 */
export function pinToOrigin(origin: string, candidate: string, tag: string): string {
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`[${tag}] a request URL could not be parsed, so it was not sent`);
  }
  const rebuilt = new URL(origin);
  rebuilt.pathname = parsed.pathname;
  rebuilt.search = parsed.search;
  if (parsed.origin !== rebuilt.origin || parsed.username !== "" || parsed.password !== "") {
    console.error(
      `[${tag}] BUG: a request URL for ${scrub(parsed.origin, 80)} was sent to ${rebuilt.origin} instead. ` +
        "Whatever built that URL is wrong; the credential stayed on the configured origin.",
    );
  }
  return rebuilt.toString();
}
