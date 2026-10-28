// capacity.ts — who may hold a socket open.
//
// One address is held to a share of the slots, and a socket that has stopped pinging is
// the first to go when they run out. A pure function of the sockets held, so the root
// suite can put every case to it; the object (hub.ts) reads the sockets and acts on the
// answer.

import { PUBLISH_MAX_VIEWERS } from "../../../main/types/servicecue-publish.js";

export interface Limits {
  /** Sockets held at once, all addresses together. */
  max: number;
  /**
   * The most one address may hold. A church's network puts every phone and tablet in
   * the building behind one address, so this is generous: a volunteer team on one Wi-Fi
   * is well under it, and one script is not.
   */
  perAddress: number;
  /**
   * How long a socket may go unheard before it is idle. The page pings every 30
   * seconds, so a socket silent for three pings is one whose page has gone.
   */
  idleAfterMs: number;
}

export const DEFAULT_LIMITS: Limits = { max: PUBLISH_MAX_VIEWERS, perAddress: 25, idleAfterMs: 90_000 };

/** The names a deploy may set, as `vars` in wrangler.jsonc, to change one of the limits. */
export interface LimitVars {
  MAX_VIEWERS?: unknown;
  MAX_VIEWERS_PER_ADDRESS?: unknown;
  VIEWER_IDLE_MS?: unknown;
}

/** A variable is a whole number of at least 1, as text or a number; anything else is not set. */
function count(value: unknown, fallback: number): number {
  const n = typeof value === "string" && /^\d{1,9}$/.test(value) ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) && n >= 1 ? n : fallback;
}

/** The limits a deploy runs with: the defaults, except where it sets a variable. */
export function limitsFrom(vars: LimitVars): Limits {
  return {
    max: count(vars.MAX_VIEWERS, DEFAULT_LIMITS.max),
    perAddress: count(vars.MAX_VIEWERS_PER_ADDRESS, DEFAULT_LIMITS.perAddress),
    idleAfterMs: count(vars.VIEWER_IDLE_MS, DEFAULT_LIMITS.idleAfterMs),
  };
}

/** A socket the object holds: the address it came from, and when it was last heard (a ping, or its arrival). */
export interface Held {
  address: string | null;
  lastHeardAt: number;
}

export type Admission =
  /** Let it in, after closing the sockets at these positions of `held`: idle ones, only ever to make room. */
  | { admit: true; evict: number[] }
  | { admit: false; why: "address" | "full" };

/**
 * May another socket from `address` be held, given these? Idle sockets are only closed
 * to make room, never otherwise: first the address's own if it is at its share, then
 * anyone's if the page is full. If that is not enough, the answer is no, and nothing is
 * closed on behalf of a socket that was not let in.
 */
export function admit(held: readonly Held[], address: string | null, now: number, limits: Limits = DEFAULT_LIMITS): Admission {
  const idle = (h: Held) => now - h.lastHeardAt > limits.idleAfterMs;
  const positions = held.map((_, i) => i);
  const evict = new Set<number>();
  const remaining = (of: readonly number[]) => of.filter((i) => !evict.has(i)).length;

  const mine = positions.filter((i) => held[i]!.address === address);
  if (remaining(mine) >= limits.perAddress) {
    for (const i of mine) if (idle(held[i]!)) evict.add(i);
    if (remaining(mine) >= limits.perAddress) return { admit: false, why: "address" };
  }
  if (remaining(positions) >= limits.max) {
    for (const i of positions) if (idle(held[i]!)) evict.add(i);
    if (remaining(positions) >= limits.max) return { admit: false, why: "full" };
  }
  return { admit: true, evict: [...evict] };
}
