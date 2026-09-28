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

/** The config MediaMTX needs for one feed's path. */
export function pathConf(feed: RelayFeed): PathConf {
  if (feed.kind === "pull") {
    return {
      source: feed.source,
      sourceOnDemand: true,
      sourceOnDemandStartTimeout: "10s",
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
