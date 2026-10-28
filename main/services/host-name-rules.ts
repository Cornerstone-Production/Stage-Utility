// host-name-rules.ts — which names this server answers to without being told.
//
// DNS rebinding is a page on a website making its OWN hostname resolve to this
// server's address: to the browser it is then on the app's origin, so it can read
// and write as the app's pages do. Every request it sends names that hostname in
// its `Host` header. So the server answers a request only when `Host` is a name it
// knows is its own, and these are the forms that need no list, because no website
// can get a browser to reach this server under them:
//
//  - no `Host` at all: every browser sends one;
//  - an IP address: a page reaches an IP only if that IP served it;
//  - `localhost`, and names under `.localhost`: browsers resolve those themselves;
//  - a name with no dot (`stage-display`): resolved on the local network only;
//  - names under `.local`, `.internal` or `.home.arpa`: reserved for local use and
//    never in public DNS. `.lan` is not reserved, so it is not here.
//
// Pure, with no Node imports, so the settings card validates exactly as the
// server does.

import { hostnameOf } from "./http-origin.js";

/** The event the server sends when a name arrives or the list changes. */
export const HOST_NAMES_CHANNEL = "security:host-names";

/** The suffixes no public DNS answers for. */
const LOCAL_SUFFIXES = [".local", ".internal", ".home.arpa", ".localhost"];

/** A host name: letters, digits, hyphens and underscores in dot-separated
 *  labels. Underscores are not DNS hostnames, but browsers send them and local
 *  resolvers answer for them, so a panel can be reached by one. */
const DNS_NAME = /^(?=.{1,253}$)([a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)(\.[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)*$/;

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** Whether a (normalised) hostname is one this server answers to with no list. */
export function alwaysAnswered(name: string): boolean {
  if (IPV4.test(name) || name.startsWith("[")) return true;
  if (name === "localhost" || !name.includes(".")) return true;
  return LOCAL_SUFFIXES.some((s) => name.endsWith(s));
}

export type ListableName = { ok: true; name: string } | { ok: false; error: string };

/**
 * What an operator typed, as a name to put on the list. A pasted address keeps
 * only its host; a name that needs no entry, or is not a name, is refused with
 * the sentence the card shows.
 */
export function listableName(raw: string): ListableName {
  const typed = raw.trim();
  if (!typed) return { ok: false, error: "Enter a name." };
  // A pasted address keeps its host: the parser drops scheme, port and path.
  const value = hostnameOf(typed);
  if (!value) return { ok: false, error: "Use letters, digits, dots and hyphens only." };
  if (IPV4.test(value) || value.startsWith("[")) return { ok: false, error: "IP addresses are always answered; there is nothing to add." };
  if (alwaysAnswered(value)) return { ok: false, error: "Names like this are always answered; there is nothing to add." };
  if (!DNS_NAME.test(value)) return { ok: false, error: "Use letters, digits, dots and hyphens only." };
  return { ok: true, name: value };
}
