// redact-url.ts — the one place a `user:pass@` URL userinfo segment is
// stripped out of text before it reaches a log line, an Error message, or a
// supervisor's own exit reason.
//
// Shared by mediamtx-relay.ts (an API error's own message) and relay-log.ts
// (the relay's stdout/stderr, which the supervisor turns into its exit
// reason) — one copy, not two drifting ones. Confirmed necessary, not
// theoretical: a real v1.21.1 binary given a pull source URL with an
// unescaped `%` in its credential (reconcile-plan.ts's own fix is the
// primary defence for that) echoed the WHOLE credentialed URL back, garbled
// by its own Go fmt formatting, in both places this now guards.

/** Strips every `://user:pass@` userinfo segment out of `text`. Applied
 *  unconditionally to every relay error/log line, not only ones this app
 *  expects to carry a URL — a future error text is not this file's to
 *  predict. */
export function withoutCredentials(text: string): string {
  return text.replace(/:\/\/[^\s/@]+@/g, "://");
}
