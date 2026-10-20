// dropped-credentials.ts — telling the operator that a save cleared a password.
//
// The server never sends a stored credential to an address it was not entered
// for (main/services/credential-target.ts): a save that moves an integration,
// a wireless connection or a pulled feed to another address or device, and does
// not carry the password again, clears it. The field then comes back empty,
// which on its own reads as the password having been lost, so each editor that
// can do this says why, in the same words.

import { isMask, isSecretStored } from "@main/services/mask";
import type { ConfigField } from "@main/types/integrations";

import { joinWithAnd } from "./join-with-and";

/**
 * The password fields that were stored before a save, were not typed over in
 * it, and are not stored after it: the ones the server cleared because the
 * address moved. `sent` is what the save posted; a masked value in it means
 * unchanged. `after` is the saved config, or undefined when the reply did not
 * include it, in which case nothing can be said. A field `after` no longer
 * carries at all (a provider without it) counts as cleared.
 */
export function droppedCredentialFields(
  schema: readonly ConfigField[],
  before: Record<string, unknown>,
  sent: Record<string, unknown>,
  after: Record<string, unknown> | undefined,
): ConfigField[] {
  if (!after) return [];
  return schema.filter((f) => {
    if (f.type !== "password" || !isSecretStored(before[f.key]) || isSecretStored(after[f.key])) return false;
    const v = sent[f.key];
    return v === undefined || isMask(v);
  });
}

/** The notice for a save that cleared `labels`, said of `what`. */
export function droppedCredentialMessage(what: string, labels: readonly string[]): string {
  const [was, it, is] = labels.length === 1 ? ["was", "it", "is"] : ["were", "they", "are"];
  return (
    `${what}: the saved ${joinWithAnd(labels)} ${was} cleared because ${it} ${was} entered for a different address or device. ` +
    `Enter ${it === "it" ? "it" : "them"} again if ${it} ${is} still needed.`
  );
}
