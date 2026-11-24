// qsys-pin.ts — the staff PIN behind a volunteer panel's "Open Stage Utility".
//
// Four digits, set on /qsys/manage and checked here. Stored as an scrypt hash
// with a random salt and the scrypt cost it was made with (node:crypto, on the
// server only: the panels run over plain HTTP, where a browser has no
// crypto.subtle). The PIN is never stored and the hash never leaves the server. A
// hash stored before the cost was stored with it was made at Node's defaults, and
// is read as that.
//
// Five wrong tries in a row from one client (its remote address) lock that
// client out for a minute, the correct PIN included, and a locked client's guess
// is refused before anything is hashed: the lock spares the CPU as well. Checks
// from one client run one at a time, so a burst of parallel guesses cannot all be
// hashed before the first failure is counted. A correct PIN clears the count.
//
// Clients are remembered only while they have something to remember (wrong tries,
// a lock), and at most MAX_CLIENTS at once. When that many are remembered, a new
// client takes the place of one whose lock is over or whose wrong tries are a
// quarter of an hour old; when there is none, the new client is refused, unhashed,
// until there is. A count part way to a lock is never reset to make room for a
// newcomer.
//
// It keeps curious taps out; it is not security. Four digits are ten thousand
// guesses, /qsys/manage (which sets it) is not PIN-gated, and the network is the
// real boundary (docs/integrations/qsys.md).
//
// Config: the operator chose it, so a backup carries the hash and a restore puts
// it back.

import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { DataStore } from "../data-store.js";
import { isRecord } from "../is-record.js";
import { checked, refuse } from "../restore-check.js";
import { scrub } from "../scrub.js";
import type { PinCheck } from "../../types/qsys.js";

export type { PinCheck };

export const PIN_DIGITS = 4;
export const PIN_MAX_TRIES = 5;
export const PIN_LOCK_MS = 60_000;
/** Clients remembered at once. */
export const PIN_MAX_CLIENTS = 1000;
/** How long a client's wrong tries must have rested before, with the table full, they are forgotten. */
export const PIN_FORGET_IDLE_MS = 15 * 60_000;

const SALT_BYTES = 16;
const KEY_BYTES = 32;
const HEX = /^[0-9a-f]+$/;

/** scrypt's cost: N (a power of two), r and p. */
export interface ScryptCost {
  N: number;
  r: number;
  p: number;
}
/** What a new hash is made with. Node's own defaults, which is also what a hash
 *  stored without a cost was made with. */
const COST: ScryptCost = { N: 16_384, r: 8, p: 1 };
/** The most memory a stored cost may ask for (scrypt needs 128 * N * r bytes). */
const MAX_COST_BYTES = 64 * 1024 * 1024;

export interface StoredPin {
  salt: string;
  hash: string;
  /** Absent on a hash stored before the cost was: read as Node's defaults. */
  cost?: ScryptCost;
}
interface PinFile {
  pin: StoredPin | null;
}

/** Is this a PIN a panel may be given: exactly four digits. */
export function isPin(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}$/.test(v);
}

/** A cost this server will run: whole numbers, N a power of two from 2^10, p up to 4, within MAX_COST_BYTES. */
function isCost(v: unknown): v is ScryptCost {
  if (!isRecord(v) || Object.keys(v).some((k) => k !== "N" && k !== "r" && k !== "p")) return false;
  const { N, r, p } = v;
  if (!Number.isSafeInteger(N) || !Number.isSafeInteger(r) || !Number.isSafeInteger(p)) return false;
  const n = N as number;
  return n >= 1024 && (n & (n - 1)) === 0 && (r as number) >= 1 && (p as number) >= 1 && (p as number) <= 4 && 128 * n * (r as number) <= MAX_COST_BYTES;
}

function isStoredPin(v: unknown): v is StoredPin {
  return (
    isRecord(v) &&
    typeof v.salt === "string" &&
    v.salt.length === SALT_BYTES * 2 &&
    HEX.test(v.salt) &&
    typeof v.hash === "string" &&
    v.hash.length === KEY_BYTES * 2 &&
    HEX.test(v.hash) &&
    (v.cost === undefined || isCost(v.cost))
  );
}

/** The stored PIN as this file keeps it: its salt, its hash, and its cost when it has one. */
function storedPin(v: StoredPin): StoredPin {
  return { salt: v.salt, hash: v.hash, ...(v.cost ? { cost: { N: v.cost.N, r: v.cost.r, p: v.cost.p } } : {}) };
}

const restoreCheck = checked((raw) => {
  if (!isRecord(raw)) refuse("the staff PIN file must be an object");
  if (raw.pin !== null && !isStoredPin(raw.pin)) refuse("the staff PIN file must hold null, or a salt and hash (and the scrypt cost they were made with)");
  return { pin: raw.pin === null ? null : storedPin(raw.pin) };
});

/** A file this build cannot read as a PIN is read as no PIN: the panel's way out stays
 *  shut. The file is kept as it is until a PIN is saved; the log says so. */
function normalize(parsed: PinFile): PinFile {
  if (isRecord(parsed) && isStoredPin(parsed.pin)) return { pin: storedPin(parsed.pin) };
  if (isRecord(parsed) && parsed.pin !== null && parsed.pin !== undefined) {
    console.warn("[qsys] qsys-pin.json holds a staff PIN this build cannot read; volunteer panels cannot open Stage Utility until a PIN is set on /qsys/manage");
  }
  return { pin: null };
}

const store = new DataStore<PinFile>("qsys-pin.json", { pin: null }, "config", { restoreCheck, normalize });

/** Test seam: read the file again, as the restart after a restore does. */
export async function __reloadPinForTests(): Promise<void> {
  await store.reload();
}

let derivations = 0;

function derive(pin: string, salt: Buffer, cost: ScryptCost): Promise<Buffer> {
  derivations++;
  return new Promise((resolve, reject) =>
    scrypt(pin, salt, KEY_BYTES, { ...cost, maxmem: 2 * 128 * cost.N * cost.r }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

/** Test seam: how many scrypt derivations this process has run. */
export function __pinDerivationsForTests(): number {
  return derivations;
}

let now = (): number => Date.now();

/** Test seam: the clock the lock reads. */
export function __setPinClockForTests(clock: (() => number) | null): void {
  now = clock ?? (() => Date.now());
}

interface ClientTries {
  fails: number;
  lockedUntil: number;
  /** When this client last tried. */
  lastTry: number;
  /** Checks queued or running for this client; it is forgotten only at none. */
  pending: number;
  /** The check running for this client, which the next one waits for. */
  queue: Promise<unknown>;
}

/**
 * Who has tried, as many as `cap` at once. A client is remembered while it has
 * wrong tries, a lock or a check in flight, and forgotten when it has none.
 */
export class PinTries {
  private readonly clients = new Map<string, ClientTries>();

  constructor(
    private readonly cap: number,
    private readonly clock: () => number,
  ) {}

  /** The client's tries, made if new; null when the table is full of clients it must not forget. */
  of(client: string): ClientTries | null {
    const known = this.clients.get(client);
    if (known) return known;
    if (this.clients.size >= this.cap && !this.makeRoom()) return null;
    const t: ClientTries = { fails: 0, lockedUntil: 0, lastTry: this.clock(), pending: 0, queue: Promise.resolve() };
    this.clients.set(client, t);
    return t;
  }

  /** Forget `client` if there is nothing left to remember about it. */
  settle(client: string): void {
    const t = this.clients.get(client);
    if (t && t.pending === 0 && t.fails === 0 && t.lockedUntil === 0) this.clients.delete(client);
  }

  get size(): number {
    return this.clients.size;
  }

  clear(): void {
    this.clients.clear();
  }

  /** Forget one client whose lock is over, else one whose wrong tries have rested
   *  PIN_FORGET_IDLE_MS; never one with a check in flight. False when there is none. */
  private makeRoom(): boolean {
    const at = this.clock();
    let idle: string | null = null;
    for (const [k, v] of this.clients) {
      if (v.pending > 0) continue;
      if (v.lockedUntil !== 0 && v.lockedUntil <= at) {
        this.clients.delete(k);
        return true;
      }
      if (idle === null && v.lockedUntil === 0 && at - v.lastTry >= PIN_FORGET_IDLE_MS) idle = k;
    }
    if (idle === null) return false;
    this.clients.delete(idle);
    return true;
  }
}

const tries = new PinTries(PIN_MAX_CLIENTS, () => now());
/** When a full table last refused a client, so a flood is one line a minute. */
let fullSaidAt = -Infinity;

/** Test seam: forget every client's tries. */
export function __resetPinTriesForTests(): void {
  tries.clear();
  fullSaidAt = -Infinity;
}

/** Whether a PIN is set. Never the hash. */
export async function pinState(): Promise<{ set: boolean }> {
  return { set: (await store.load()).pin !== null };
}

/** Set the PIN (four digits), or clear it with null. `client` is who did, for /log. Throws when it cannot be saved. */
export async function setPin(pin: string | null, client = "the server"): Promise<void> {
  if (pin !== null && !isPin(pin)) throw new Error(`the staff PIN must be ${PIN_DIGITS} digits`);
  if (pin === null) {
    await store.save({ pin: null });
    console.log(`[qsys] staff PIN removed by ${scrub(client)}; volunteer panels cannot open Stage Utility until one is set`);
    return;
  }
  const salt = randomBytes(SALT_BYTES);
  const hash = await derive(pin, salt, COST);
  await store.save({ pin: { salt: salt.toString("hex"), hash: hash.toString("hex"), cost: { ...COST } } });
  console.log(`[qsys] staff PIN set by ${scrub(client)}`);
}

/**
 * Check a PIN from `client`. A locked client is refused before anything is
 * hashed, the correct PIN included. With no PIN set nothing opens, and that is
 * not counted as a wrong try.
 */
export function checkPin(pin: string, client: string): Promise<PinCheck> {
  const t = tries.of(client);
  if (!t) {
    if (now() - fullSaidAt >= PIN_LOCK_MS) {
      fullSaidAt = now();
      console.warn(`[qsys] PIN check from ${scrub(client)} refused: ${scrub(PIN_MAX_CLIENTS)} other clients are part way to a lock or locked; it can try again in 60 s`);
    }
    return Promise.resolve({ ok: false, lockedForMs: PIN_LOCK_MS });
  }
  t.pending++;
  const run = t.queue.then(() => checkOne(pin, client, t));
  t.queue = run.catch(() => {});
  return run.finally(() => {
    t.pending--;
    tries.settle(client);
  });
}

async function checkOne(pin: string, client: string, t: ClientTries): Promise<PinCheck> {
  const left = t.lockedUntil - now();
  if (left > 0) return { ok: false, lockedForMs: left };
  if (t.lockedUntil !== 0) {
    // The minute is up: a fresh run of tries.
    t.lockedUntil = 0;
    t.fails = 0;
  }
  t.lastTry = now();
  const stored = (await store.load()).pin;
  if (!stored) return { ok: false, lockedForMs: 0, notSet: true };
  const expected = Buffer.from(stored.hash, "hex");
  const got = isPin(pin) ? await derive(pin, Buffer.from(stored.salt, "hex"), stored.cost ?? COST) : null;
  if (got && timingSafeEqual(got, expected)) {
    t.fails = 0;
    return { ok: true };
  }
  t.fails++;
  if (t.fails < PIN_MAX_TRIES) return { ok: false, lockedForMs: 0 };
  t.lockedUntil = now() + PIN_LOCK_MS;
  // The numbers are written out: the log scan holds every interpolation to scrub().
  console.warn(`[qsys] PIN locked for ${scrub(client)} after 5 wrong tries; it can try again in 60 s`);
  return { ok: false, lockedForMs: PIN_LOCK_MS };
}
