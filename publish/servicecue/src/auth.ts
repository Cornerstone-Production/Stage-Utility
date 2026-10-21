// auth.ts — who may publish.
//
// One shared secret, `PUBLISH_TOKEN`, sent as `Authorization: Bearer <token>`.
// Nothing here reads a Workers API: crypto.subtle is on both the Workers runtime
// and Node, so the root test suite runs the same code the edge does.

import { PUBLISH_MIN_TOKEN_LENGTH } from "../../../main/types/servicecue-publish.js";

/** The token a request carries, or null when it carries none. The scheme is case-insensitive (RFC 7235). */
export function bearerToken(header: string | null): string | null {
  const m = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header ?? "");
  return m ? m[1]! : null;
}

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

/**
 * Do these two tokens match, in time that does not depend on how much of them does.
 *
 * Compares their SHA-256 digests rather than the tokens: a digest is always 32
 * bytes, so the loop below is the same length whatever was sent and has no early
 * exit, and neither token's length is learned from how long the answer took.
 */
export async function tokensMatch(provided: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(provided), sha256(expected)]);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i]! ^ b[i]!;
  return difference === 0;
}

export type Authorization = { ok: true } | { ok: false; status: 401 | 503; error: string };

/**
 * May this request publish?
 *
 * A Worker with no secret, or one too short to mean anything, refuses everyone with
 * a 503 that says so: "not set up" is a different morning's problem from "wrong
 * token", and a deploy that forgot the secret should say that rather than 401.
 */
export async function authorize(header: string | null, secret: unknown): Promise<Authorization> {
  // A secret is a string. A binding that is not one (a JSON value in `vars`, say) has
  // no length to check, and would otherwise be compared as whatever it stringifies to.
  if (typeof secret !== "string" || secret.length < PUBLISH_MIN_TOKEN_LENGTH) {
    return {
      ok: false,
      status: 503,
      error: `Publishing is not set up: the PUBLISH_TOKEN secret is missing or shorter than ${PUBLISH_MIN_TOKEN_LENGTH} characters`,
    };
  }
  const provided = bearerToken(header);
  if (provided === null) return { ok: false, status: 401, error: "A bearer token is required" };
  return (await tokensMatch(provided, secret)) ? { ok: true } : { ok: false, status: 401, error: "The token is not the right one" };
}
