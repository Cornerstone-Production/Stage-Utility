// mask.ts — "a value is set, and it is not being shown to you", said once.
//
// A credential leaves the server as a run of bullets and comes back as one when
// the operator did not retype it. Both halves of that round trip have to agree
// on what counts as a mask, and they were four separate decisions: this test in
// wireless-credentials.ts, a verbatim copy in integrations-panel.tsx, another
// verbatim copy in wireless-connections-panel.tsx, and a differently-shaped
// `!== ""` in sensource-scope-picker.tsx. They all agreed, which is the only
// reason nothing was broken — three places is this repo's threshold for removing
// the duplication rather than maintaining it.
//
// A LEAF MODULE, deliberately. The renderer needs this and cannot import
// wireless-credentials.ts, which pulls in the provider registry and with it the
// whole server-side provider graph. Nothing is imported here, so
// `@main/services/mask` costs the renderer bundle two constants and a regex —
// the same arrangement errors.ts, clamp.ts and spl-leq.ts already have.

/** What the SERVER writes into a config or state for a stored secret. */
export const MASK = "••••";

/**
 * What a password INPUT is seeded with when a secret is stored.
 *
 * Longer than {@link MASK} and always has been: a four-bullet password field
 * reads as a four-character password. It lives beside MASK rather than in the
 * panel that renders it because {@link isMask} has to keep matching both, and
 * the reason it matches any run of bullets rather than one exact constant is
 * precisely that these two differ.
 */
export const FORM_MASK = "••••••••";

/**
 * Is this value a mask rather than a real credential?
 *
 * Any run of bullets, not just {@link MASK} or {@link FORM_MASK}. If only an
 * exact constant counted, a form echoing the other one back would store a row of
 * bullets AS the credential — and the real one would be gone with no way to tell
 * from the UI, which shows bullets either way.
 */
export function isMask(value: unknown): boolean {
  return typeof value === "string" && /^•+$/.test(value);
}

/**
 * Does the state say a secret is stored for this field?
 *
 * The server writes {@link MASK} when one is and `""` when none is, so this is
 * the same question {@link isMask} answers — named for what the caller is
 * actually asking, because "is the field masked" and "is there a credential
 * behind it" read as different questions and were written as different code.
 */
export function isSecretStored(value: unknown): boolean {
  return isMask(value);
}
