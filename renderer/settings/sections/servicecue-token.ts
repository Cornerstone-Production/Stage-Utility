// The publishing token's field, as the deploy card and the public-link card both
// treat it: the server hands back a mask for a stored token, and only text the
// operator actually typed is ever sent.

import type { FocusEvent } from "react";

import { isMask } from "@main/services/mask";
import { checkPublishToken } from "@main/services/servicecue-publish-rules";
import { PUBLISH_MIN_TOKEN_LENGTH } from "@main/types/servicecue-publish";

/**
 * Why a typed token cannot turn publishing on, said as the field is typed in; null when
 * the server would take it. The rule is the server's own, checkPublishToken, so the card
 * cannot allow what the server refuses: a character it will not send gets its sentence,
 * and a short token is counted ("12 so far") rather than refused after the switch.
 */
export function tokenReason(token: string): string | null {
  // Padded to the minimum length, only a character the server will not send can still
  // fail, so its sentence is the server's own and the rule is not written out a second time.
  const characters = checkPublishToken(token.padEnd(PUBLISH_MIN_TOKEN_LENGTH, "x"));
  if (characters !== null) return characters;
  return token.length < PUBLISH_MIN_TOKEN_LENGTH ? `The token needs at least ${PUBLISH_MIN_TOKEN_LENGTH} characters (${token.length} so far).` : null;
}

/** What the operator typed into the token field, trimmed; null for no draft, a blank one, or the mask read back. */
export function typedTokenOf(draft: string | null): string | null {
  return draft !== null && draft.trim() !== "" && !isMask(draft) ? draft.trim() : null;
}

/** The mask is not a value to edit: typing into it would append to bullets, so focusing it selects all of it. */
export function selectMask(e: FocusEvent<HTMLInputElement>, shown: string): void {
  if (isMask(shown)) e.currentTarget.select();
}
