// The Cloudflare credentials the server keeps the public page up to date with: the account ID and an
// API token for the one Worker.
//
// In the encrypted secrets store, never in servicecue-publish.json: that file rides in every config
// snapshot and automatic backup. The slot holds the page's ORIGIN beside them, as the publishing
// token's does, and they are read back only for that origin: credentials saved for one page are
// not for another a stranger typed in. The routes drop them when the address changes.

import { secretsStore } from "./secrets.js";
import { ACCOUNT_ID_PATTERN } from "./servicecue-cloudflare.js";
import type { PublishOrigin } from "./servicecue-publish-rules.js";

export const DEPLOY_SECRET_SLOT = "servicecue-deploy";

export interface DeployCredentials {
  accountId: string;
  token: string;
}

/** Why `text` cannot be a Cloudflare account ID, or null: 32 hexadecimal digits. */
export function checkAccountId(text: string): string | null {
  return ACCOUNT_ID_PATTERN.test(text.toLowerCase()) ? null : "The Cloudflare account ID is 32 letters and digits (Workers & Pages, on the right of the page).";
}

/** Why `text` cannot be a Cloudflare API token, or null. They are about 40 characters of letters, digits, `-` and `_`. */
export function checkDeployToken(text: string): string | null {
  if (text.length < 20 || text.length > 256) return "A Cloudflare API token is 20 to 256 characters.";
  return /^[A-Za-z0-9_-]+$/.test(text) ? null : "A Cloudflare API token has only letters, digits, - and _: copy it again.";
}

/** The credentials saved for `origin`, or null when none are, or when they are for another address. */
export async function readDeployCredentials(origin: string): Promise<DeployCredentials | null> {
  const slot = await secretsStore.getSecrets(DEPLOY_SECRET_SLOT);
  if (slot.origin !== origin || !slot.accountId || !slot.token) return null;
  return { accountId: slot.accountId, token: slot.token };
}

/** Save for `origin`, replacing whatever was saved: one write, so the address and the token cannot part. */
export function saveDeployCredentials(origin: PublishOrigin, creds: DeployCredentials): Promise<void> {
  return secretsStore.setSecrets(DEPLOY_SECRET_SLOT, { origin, accountId: creds.accountId, token: creds.token });
}

export function forgetDeployCredentials(): Promise<void> {
  return secretsStore.clearSecrets(DEPLOY_SECRET_SLOT);
}
