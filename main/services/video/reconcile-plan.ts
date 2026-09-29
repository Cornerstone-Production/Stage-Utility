// main/services/video/reconcile-plan.ts — working out what the relay's
// paths and publish users should become, without ever touching the network.
//
// Pure, so "add this one, replace that one, remove a third, leave a fourth
// alone" is tested against plain objects. mediamtx-relay.ts is the only
// thing that turns a plan into HTTP calls.

import { READER_USER, type RelayUser } from "./mediamtx-config.js";
import type { RelayFeed } from "./relay.js";

/** The subset of a MediaMTX path's config this app ever sets. `GET
 *  /v3/config/paths/list` reports dozens of other keys (recording,
 *  playback, every other protocol's own timeouts) — none of them are here,
 *  and a match check below never looks at them. */
export interface PathConf {
  source: string;
  sourceOnDemand?: boolean;
  sourceOnDemandStartTimeout?: string;
  sourceOnDemandCloseAfter?: string;
  overridePublisher?: boolean;
}

/** MediaMTX's own built-in catch-all path. It is never in `desired` — no
 *  feed is ever named "all_others" (feed-id.ts's pattern does not produce
 *  it) — so without this it would always read as "the relay has a path we
 *  don't want" and get deleted, refusing every connection to a path nobody
 *  configured instead of the relay's own "path not found." */
const ALL_OTHERS = "all_others";

/** A literal `%` survives the WHATWG `URL` username/password setters
 *  unescaped — confirmed against Node's own `URL` (`new URL("rtsp://h/s")`
 *  with `.password = "s3c%zret"` serializes as `s3c%zret`, verbatim): `%`
 *  is not in the userinfo percent-encode set, since the setters treat a URL
 *  as already-encoded input, not a raw credential to encode. Pre-escaping
 *  it here is what makes the setters' own encoding of `@`, `:`, `/` and the
 *  rest correct as a ROUND TRIP: `50%off!` must reach the device as
 *  `50%off!`, not `50` truncated at a `%` a real client tries to decode as
 *  an escape. `searchParams.set` (the SRT branch below) does not need this
 *  — form-urlencoded serialization already encodes `%` as `%25` on its
 *  own, confirmed the same way. */
function encodePercent(s: string): string {
  return s.replace(/%/g, "%25");
}

/** A pull feed's address with its credentials folded in — what a `RelayFeed`
 *  of kind "pull" carries as `source`. Never logs: the return value carries
 *  a password, and nothing that touches it here is a log call.
 *
 *  rtsp/rtsps/http/https put the credentials in the URL's own userinfo,
 *  percent-encoded by the `URL` setters (`p@ss` becomes `p%40ss`) after a
 *  literal `%` is pre-escaped (see encodePercent); srt has no userinfo
 *  convention of its own, so its password goes in the query as
 *  `passphrase=<pw>` and its username is ignored — MediaMTX authenticates
 *  an SRT pull by passphrase alone. An empty username with no password
 *  leaves `url` untouched.
 */
export function pullSource(url: string, username: string, password: string | undefined): string {
  const parsed = new URL(url);

  if (parsed.protocol === "srt:") {
    if (!password) return url;
    parsed.searchParams.set("passphrase", password);
    return parsed.toString();
  }

  if (username === "" && !password) return url;

  // The URL setters below silently no-op when the URL "cannot have a
  // username/password" — true only when its host is empty (per the WHATWG
  // URL spec; not actually scheme-specific for any of the four schemes
  // this ever sees). Every rtsp/rtsps/http/https URL a feed can carry has
  // already been through `new URL()` in feed-input.ts, which requires a
  // host to parse at all — so this is a defensive fallback, not a reachable
  // one, and the scheme is left with no credentials rather than silently
  // dropping a password nobody can see was dropped.
  if (parsed.host === "") return url;

  parsed.username = encodePercent(username);
  if (password !== undefined) parsed.password = encodePercent(password);
  return parsed.toString();
}

/** How long the relay dials an on-demand pull source before giving up on
 *  that request. */
export const PULL_START_TIMEOUT_MS = 10_000;

/** The config MediaMTX needs for one feed's path. */
export function pathConf(feed: RelayFeed): PathConf {
  if (feed.kind === "pull") {
    return {
      source: feed.source,
      sourceOnDemand: true,
      sourceOnDemandStartTimeout: `${PULL_START_TIMEOUT_MS / 1000}s`,
      sourceOnDemandCloseAfter: "10s",
    };
  }
  return { source: "publisher", overridePublisher: false };
}

/** The relay's whole publish-user list: the fixed reader user, then one
 *  `video` user per push feed, sorted by path so the list (and the
 *  before/after comparison `MediaMtxRelay.reconcile` makes against it) is
 *  stable regardless of feed order. */
export function publishUsers(feeds: RelayFeed[]): RelayUser[] {
  const pushUsers = feeds
    .filter((feed): feed is Extract<RelayFeed, { kind: "push" }> => feed.kind === "push")
    .map((feed) => ({
      user: "video",
      pass: feed.password,
      ips: [] as string[],
      permissions: [{ action: "publish" as const, path: feed.id }],
    }))
    .sort((a, b) => a.permissions[0].path.localeCompare(b.permissions[0].path));
  return [READER_USER, ...pushUsers];
}

/** True when `current` already carries every key `wanted` sets, at the same
 *  value. Every value `pathConf` produces is a string or boolean, so `===`
 *  is the whole comparison — there is nothing here to recurse into. */
function matchesWanted(current: Record<string, unknown>, wanted: PathConf): boolean {
  return (Object.keys(wanted) as (keyof PathConf)[]).every((key) => current[key] === wanted[key]);
}

/** What to add, replace and remove so the relay's paths match `desired`
 *  exactly. A path already there is replaced only when it differs from
 *  what `pathConf` wants; one whose conf matches, key for key, is left
 *  alone even though the relay reports far more keys than that. */
export function planReconcile(
  desired: RelayFeed[],
  current: { name: string; conf: Record<string, unknown> }[],
): { add: [string, PathConf][]; replace: [string, PathConf][]; remove: string[] } {
  const currentByName = new Map(current.map((path) => [path.name, path.conf]));
  const desiredIds = new Set(desired.map((feed) => feed.id));

  const add: [string, PathConf][] = [];
  const replace: [string, PathConf][] = [];
  for (const feed of desired) {
    const wanted = pathConf(feed);
    const existing = currentByName.get(feed.id);
    if (existing === undefined) {
      add.push([feed.id, wanted]);
    } else if (!matchesWanted(existing, wanted)) {
      replace.push([feed.id, wanted]);
    }
  }

  const remove = current.map((path) => path.name).filter((name) => name !== ALL_OTHERS && !desiredIds.has(name));

  return { add, replace, remove };
}
