// publish-target.ts — where a publisher sends, and what may be said about it.
//
// ServiceCue and StagePlots publish to the same public page, with the same address and the same
// token. This is the one place that works out "is there a page, and may it be used", and hides
// the token. StagePlots uses it; servicecue-publisher.ts still carries its own copy of the ladder
// (servicecue-publisher.ts "parsePublishUrl ... checkPublishToken") and moves here once that file
// is free to change.
//
// This file imports only the pure rules (servicecue-publish-rules.ts), and takes what it reads as
// seams, so it pulls in neither a store nor the secrets file.

import { errorMessage } from "./errors.js";
import { checkPublishToken, parsePublishUrl, type PublishOrigin } from "./servicecue-publish-rules.js";

/**
 * The page to publish to, or why not. `reason` says which part is wrong:
 *  - "address": none saved (`unset` is true) or one that cannot be used;
 *  - "token": none saved for that address (`unset` is true) or one the page would refuse;
 *  - "unreadable": the saved settings or the token could not be read at all.
 * `message` names the problem and never carries the token.
 */
export type ResolvedPublishTarget =
  | { ok: true; origin: PublishOrigin; token: string }
  | { ok: false; reason: "address" | "token"; unset: boolean; message: string }
  | { ok: false; reason: "unreadable"; unset: false; message: string; cause: string };

export interface PublishTargetSeams {
  /** The saved page address, "" before one is set. */
  loadUrl(): Promise<string>;
  /** The token saved for `origin`, "" when there is none. */
  loadToken(origin: PublishOrigin): Promise<string>;
}

/**
 * The saved address and token, checked. Never throws: a read that fails comes back as
 * `reason: "unreadable"`, for the caller to say and hand on. The token is trimmed, as it is
 * everywhere it is used. No message here carries the token; hideSecrets() is for what a caller
 * builds around one.
 */
export async function resolvePublishTarget(seams: PublishTargetSeams): Promise<ResolvedPublishTarget> {
  let url: string;
  try {
    url = await seams.loadUrl();
  } catch (err) {
    const cause = errorMessage(err);
    return { ok: false, reason: "unreadable", unset: false, message: `The publishing settings could not be read: ${cause}`, cause };
  }
  const parsed = parsePublishUrl(url);
  if (!parsed.ok) return { ok: false, reason: "address", unset: url.trim() === "", message: parsed.message };
  let token: string;
  try {
    token = (await seams.loadToken(parsed.origin)).trim();
  } catch (err) {
    const cause = errorMessage(err);
    return { ok: false, reason: "unreadable", unset: false, message: `The publishing token could not be read: ${cause}`, cause };
  }
  if (token === "") return { ok: false, reason: "token", unset: true, message: "No publishing token is set." };
  const why = checkPublishToken(token);
  if (why !== null) return { ok: false, reason: "token", unset: false, message: why };
  return { ok: true, origin: parsed.origin, token };
}

/** What stands where a secret was. */
export const HIDDEN = "<secret>";

/** `text` with every secret in it hidden. An empty secret hides nothing (it would match everywhere). */
export function hideSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) if (s) out = out.split(s).join(HIDDEN);
  return out;
}
