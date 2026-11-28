// secret-compare.ts — is the secret a caller presented the one that is stored?
//
// One comparison for every secret a caller presents to the server. The log
// token and a cue confirmation were once compared with plain `===`. The
// ServiceCue Worker has its own (publish/servicecue/src/auth.ts): it runs
// without Node's crypto, so it cannot share this one.
//
// `crypto.timingSafeEqual` through the default import, never a named import:
// the tests that prove a gate uses it spy on that object, and a named import is
// a binding the spy cannot see.

import crypto from "node:crypto";

/**
 * Two secrets, compared in constant time.
 *
 * `===` stops at the first differing byte, so how long a wrong guess took says
 * how much of it was right. timingSafeEqual needs equal lengths and throws
 * otherwise, so each side is hashed first: the digests are always 32 bytes, and
 * the length of a stored secret is not something a caller can probe either.
 */
export function secretsMatch(presented: string, stored: string): boolean {
  const digest = (s: string) => crypto.createHash("sha256").update(s, "utf8").digest();
  return crypto.timingSafeEqual(digest(presented), digest(stored));
}
