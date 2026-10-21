// Persists the ServiceCue web-publishing settings: whether it is on, and the
// address of the page it publishes to.
//
// The publishing TOKEN is not here. This file is a "config" store, so it rides in
// every config snapshot and every automatic backup — bundles the app presents as
// safe to keep on a drive — and a credential in it would leave the machine with
// them. The token is in the encrypted secrets store, WITH the origin it was saved
// for, and is read back only for that origin: a token paired with another address
// by a failed write or a second request reads as no token at all.

import { DataStore } from "./data-store.js";
import { secretsStore } from "./secrets.js";
import type { PublishOrigin } from "./servicecue-publish-rules.js";

export interface ServiceCuePublishSettings {
  /** Whether the server pushes ServiceCue's data out. */
  enabled: boolean;
  /** The page's origin ("https://host"), or "" before one is set. */
  url: string;
}

export const DEFAULT_PUBLISH_SETTINGS: ServiceCuePublishSettings = { enabled: false, url: "" };

export const servicecuePublishStore = new DataStore<ServiceCuePublishSettings>(
  "servicecue-publish.json",
  DEFAULT_PUBLISH_SETTINGS,
  "config",
);

/** The slot in secrets.bin that holds the token, under `token`, and the origin it is for, under `origin`. */
export const PUBLISH_SECRET_SLOT = "servicecue-publish";

/** The token saved for `origin`, or "" when none is, or when the one saved is for another address. */
export async function readPublishToken(origin: string): Promise<string> {
  const slot = await secretsStore.getSecrets(PUBLISH_SECRET_SLOT);
  return slot.origin === origin ? (slot.token ?? "") : "";
}

/** Save `token` for `origin`, replacing whatever was saved: one write, so the two cannot part. */
export function savePublishToken(origin: PublishOrigin, token: string): Promise<void> {
  return secretsStore.setSecrets(PUBLISH_SECRET_SLOT, { origin, token });
}

export function forgetPublishToken(): Promise<void> {
  return secretsStore.clearSecrets(PUBLISH_SECRET_SLOT);
}
