// The publishing token's field, as the deploy card and the public-link card both
// treat it: the server hands back a mask for a stored token, and only text the
// operator actually typed is ever sent.

import type { FocusEvent } from "react";

import { isMask } from "@main/services/mask";

/** What the operator typed into the token field, trimmed; null for no draft, a blank one, or the mask read back. */
export function typedTokenOf(draft: string | null): string | null {
  return draft !== null && draft.trim() !== "" && !isMask(draft) ? draft.trim() : null;
}

/** The mask is not a value to edit: typing into it would append to bullets, so focusing it selects all of it. */
export function selectMask(e: FocusEvent<HTMLInputElement>, shown: string): void {
  if (isMask(shown)) e.currentTarget.select();
}
