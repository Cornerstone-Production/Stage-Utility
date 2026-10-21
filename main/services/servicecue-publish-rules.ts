// servicecue-publish-rules.ts — what an operator may type into the Public link card.
//
// The page address and the publishing token, and nothing else. A LEAF MODULE: the card
// reads the same rules the routes and the publisher enforce, so what it lets through is
// what the server accepts, and the renderer pays for two functions and a type.

import { PUBLISH_MIN_TOKEN_LENGTH } from "../types/servicecue-publish.js";

declare const PUBLISH_ORIGIN: unique symbol;
/** The operator's page as `scheme://host[:port]`, and nothing after it. Made only by
 *  `parsePublishUrl`; the credentialed fetch takes nothing else (code-scanning.md). */
export type PublishOrigin = string & { readonly [PUBLISH_ORIGIN]: true };

export type ParsedPublishUrl = { ok: true; origin: PublishOrigin } | { ok: false; message: string };

/** Hosts a plain http:// address may name, when local addresses are allowed: a page run on this machine, and nothing else. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1"]);

/** The development switch that lets the page be one run on this machine (`wrangler dev`). Off in production. */
export const PUBLISH_ALLOW_LOCAL_ENV = "STAGE_UTILITY_PUBLISH_ALLOW_LOCAL";

/** Is the development switch set? False wherever there is no process environment, the browser included. */
function localAllowed(): boolean {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[PUBLISH_ALLOW_LOCAL_ENV] === "1";
}

/**
 * The origin an address names, or why it cannot be used.
 *
 * https only. Plain http is accepted for localhost and 127.0.0.1 alone, and only when
 * STAGE_UTILITY_PUBLISH_ALLOW_LOCAL=1 is set on the server (development): in production
 * the address cannot name this machine or its ports. `allowLocal` overrides the
 * environment, for a caller that only compares addresses (the card) or a test. Only the
 * ORIGIN is kept: the link volunteers are given, with `/servicecue` on the end, is still
 * the page. A scheme-less address is taken as https.
 */
export function parsePublishUrl(raw: unknown, allowLocal: boolean = localAllowed()): ParsedPublishUrl {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return { ok: false, message: "Enter the page address." };
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return { ok: false, message: "That doesn't look like a web address." };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, message: "The page address has to start with https://." };
  }
  if (url.protocol === "http:" && !(allowLocal && LOOPBACK_HOSTS.has(url.hostname))) {
    return { ok: false, message: "The page address has to start with https://." };
  }
  if (url.username || url.password) {
    return { ok: false, message: "Leave the user name and password out of the page address." };
  }
  if (!url.hostname) return { ok: false, message: "That doesn't look like a web address." };
  return { ok: true, origin: url.origin as PublishOrigin };
}

/**
 * Why a token cannot be used, or null when it can.
 *
 * Printable ASCII with no space, because it travels in an `Authorization: Bearer` header:
 * any other character fails the request before it is sent, and a space can never match the
 * page's `Bearer <token>`. Said here in plain words rather than as the failed request.
 */
export function checkPublishToken(token: string): string | null {
  if (!/^[\x21-\x7e]+$/.test(token)) {
    return "The publishing token can only use letters, digits and punctuation, with no spaces.";
  }
  if (token.length < PUBLISH_MIN_TOKEN_LENGTH) {
    return `The publishing token has to be at least ${PUBLISH_MIN_TOKEN_LENGTH} characters: the page treats a shorter one as not set.`;
  }
  return null;
}
