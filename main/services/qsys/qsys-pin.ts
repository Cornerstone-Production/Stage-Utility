// qsys-pin.ts — the staff PIN behind a volunteer panel's "Open Stage Utility".
//
// Four digits, set on /qsys/manage and checked here. Stored as an scrypt hash
// with a random salt (node:crypto, on the server only: the panels run over plain
// HTTP, where a browser has no crypto.subtle). The PIN is never stored and the
// hash never leaves the server.
//
// Five wrong tries in a row from one client (its remote address) lock that
// client out for a minute, the correct PIN included. Checks from one client run
// one at a time, so a burst of parallel guesses cannot all be hashed before the
// first failure is counted. A correct PIN clears the count.
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

export const PIN_DIGITS = 4;
export const PIN_MAX_TRIES = 5;
export const PIN_LOCK_MS = 60_000;
/** Clients remembered at once; past this, the oldest one not locked is forgotten. */
const MAX_CLIENTS = 1000;

const SALT_BYTES = 16;
const KEY_BYTES = 32;
const HEX = /^[0-9a-f]+$/;

export interface StoredPin {
  salt: string;
  hash: string;
}
interface PinFile {
  pin: StoredPin | null;
}

export type PinCheck = { ok: true } | { ok: false; lockedForMs: number; notSet?: true };

/** Is this a PIN a panel may be given: exactly four digits. */
export function isPin(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}$/.test(v);
}

function isStoredPin(v: unknown): v is StoredPin {
  return (
    isRecord(v) &&
    typeof v.salt === "string" &&
    v.salt.length === SALT_BYTES * 2 &&
    HEX.test(v.salt) &&
    typeof v.hash === "string" &&
    v.hash.length === KEY_BYTES * 2 &&
    HEX.test(v.hash)
  );
}

const restoreCheck = checked((raw) => {
  if (!isRecord(raw)) refuse("the staff PIN file must be an object");
  if (raw.pin !== null && !isStoredPin(raw.pin)) refuse("the staff PIN file must hold null or a salt and hash");
  return { pin: raw.pin === null ? null : { salt: raw.pin.salt, hash: raw.pin.hash } };
});

/** A file this build cannot read as a PIN is read as no PIN: the panel's way out stays shut. */
function normalize(parsed: PinFile): PinFile {
  return { pin: isRecord(parsed) && isStoredPin(parsed.pin) ? parsed.pin : null };
}

const store = new DataStore<PinFile>("qsys-pin.json", { pin: null }, "config", { restoreCheck, normalize });

function derive(pin: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(pin, salt, KEY_BYTES, (err, key) => (err ? reject(err) : resolve(key))));
}

let now = (): number => Date.now();

/** Test seam: the clock the lock reads. */
export function __setPinClockForTests(clock: (() => number) | null): void {
  now = clock ?? (() => Date.now());
}

interface ClientTries {
  fails: number;
  lockedUntil: number;
  /** The check running for this client, which the next one waits for. */
  queue: Promise<unknown>;
}
const clients = new Map<string, ClientTries>();

function triesFor(client: string): ClientTries {
  let t = clients.get(client);
  if (!t) {
    if (clients.size >= MAX_CLIENTS) {
      for (const [k, v] of clients) {
        if (v.lockedUntil <= now()) {
          clients.delete(k);
          break;
        }
      }
    }
    t = { fails: 0, lockedUntil: 0, queue: Promise.resolve() };
    clients.set(client, t);
  }
  return t;
}

/** Test seam: forget every client's tries. */
export function __resetPinTriesForTests(): void {
  clients.clear();
}

/** Whether a PIN is set. Never the hash. */
export async function pinState(): Promise<{ set: boolean }> {
  return { set: (await store.load()).pin !== null };
}

/** Set the PIN (four digits), or clear it with null. `client` is who did, for /log. */
export async function setPin(pin: string | null, client = "the server"): Promise<void> {
  if (pin !== null && !isPin(pin)) throw new Error(`the staff PIN must be ${PIN_DIGITS} digits`);
  if (pin === null) {
    await store.save({ pin: null });
    console.log(`[qsys] staff PIN removed by ${scrub(client)}; volunteer panels cannot open Stage Utility until one is set`);
    return;
  }
  const salt = randomBytes(SALT_BYTES);
  const hash = await derive(pin, salt);
  await store.save({ pin: { salt: salt.toString("hex"), hash: hash.toString("hex") } });
  console.log(`[qsys] staff PIN set by ${scrub(client)}`);
}

/**
 * Check a PIN from `client`. A locked client is refused before anything is
 * hashed, the correct PIN included. With no PIN set nothing opens, and that is
 * not counted as a wrong try.
 */
export function checkPin(pin: string, client: string): Promise<PinCheck> {
  const t = triesFor(client);
  const run = t.queue.then(() => checkOne(pin, client, t));
  t.queue = run.catch(() => {});
  return run;
}

async function checkOne(pin: string, client: string, t: ClientTries): Promise<PinCheck> {
  const left = t.lockedUntil - now();
  if (left > 0) return { ok: false, lockedForMs: left };
  if (t.lockedUntil !== 0) {
    // The minute is up: a fresh run of tries.
    t.lockedUntil = 0;
    t.fails = 0;
  }
  const stored = (await store.load()).pin;
  if (!stored) return { ok: false, lockedForMs: 0, notSet: true };
  const expected = Buffer.from(stored.hash, "hex");
  const got = isPin(pin) ? await derive(pin, Buffer.from(stored.salt, "hex")) : null;
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
