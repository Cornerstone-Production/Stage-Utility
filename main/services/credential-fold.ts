// credential-fold.ts — what one value in a credential field asks the server to do.
//
// A credential leaves the server as a mask and comes back as one when the
// operator did not retype it, so a save carries three intentions in the same
// field, plus junk:
//
//   a mask         keep what is stored (any run of bullets: see mask.isMask)
//   blank          clear it. Whitespace is blank (see mask.isBlankSecret). This
//                  case used to be missing from the integration fold, so no
//                  integration secret could be taken back out from its dialog
//   another string set it, untrimmed: a password may begin or end with a space
//   anything else  ignore it and say so. NOT String(value): String(null) is
//                  "null", which was once stored AS a SafeSpace id. Ignored rather
//                  than cleared, because deleting a working credential over a
//                  malformed body is the worse wrong answer
//
// The integration fold (integration-manager.ts foldConfigEntries) reads each
// field through this. The wireless fold (wireless-credentials.ts) is still a
// copy of the same rule, left alone while PR #911 rewrites it; it moves onto
// this once that lands.
//
// Server-only. mask.ts is the renderer's leaf and stays one.

import { isBlankSecret, isMask } from "./mask.js";

/** What a credential field's incoming value asks for. `type` names an ignored
 *  value's type, for a log line: never the value, this is a credential slot. */
export type SecretEdit =
  | { kind: "keep" }
  | { kind: "clear" }
  | { kind: "set"; value: string }
  | { kind: "ignore"; type: string };

export function foldSecret(value: unknown): SecretEdit {
  if (isMask(value)) return { kind: "keep" };
  if (isBlankSecret(value)) return { kind: "clear" };
  if (typeof value === "string") return { kind: "set", value };
  return { kind: "ignore", type: value === null ? "null" : typeof value };
}
