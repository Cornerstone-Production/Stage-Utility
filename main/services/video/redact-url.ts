// redact-url.ts — the one place a relay URL's credentials are stripped out of
// text before it reaches a log line, an Error message, or a supervisor's own
// exit reason.
//
// Shared by mediamtx-relay.ts (an API error's own message) and relay-log.ts
// (the relay's stdout/stderr, which the supervisor turns into its exit
// reason). A real v1.21.1 binary given a malformed pull source echoed the
// whole credentialed URL back, garbled by its own Go formatting, in both.

/** A query value that is a credential: SRT's passphrase, RTMP's pass, and the
 *  common pwd. Anchored on `?` or `&`, so a word merely ending in "pass"
 *  (bypass=, compass=) is left alone. */
const SECRET_QUERY = /([?&](?:passphrase|pass|pwd)=)[^&\s'"]+/gi;
/** The password segment of an SRT streamid, `publish:<path>:<user>:<pass>`
 *  or `read:...`, with its colons literal or percent-encoded. */
const SECRET_STREAMID = /(streamid=(?:publish|read)(?::|%3A)[^:&\s'"%]*(?::|%3A)[^:&\s'"%]*(?::|%3A))[^&\s'"]+/gi;

/** Strips every credential a relay URL can carry out of `text`: a
 *  `://user:pass@` userinfo segment is removed outright, and a passphrase,
 *  pass or pwd query value, or a streamid's password, becomes `<redacted>`.
 *  Applied to every relay error and log line, not only ones this app expects
 *  to carry a URL. */
export function withoutCredentials(text: string): string {
  return text
    .replace(/:\/\/[^\s/@]+@/g, "://")
    .replace(SECRET_QUERY, "$1<redacted>")
    .replace(SECRET_STREAMID, "$1<redacted>");
}
