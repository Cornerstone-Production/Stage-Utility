// The duplicate-id check, as a state machine with no socket.
//
// Two servers carrying one serverId both answer the screens bound to it, which
// then switch between them. This module decides when to look for such a twin,
// remembers who answered, and when to forget them. kiosk-responder.ts owns the
// socket and hands over two things: a way to send the check, and the evidence it
// hears (an answer carrying our id, or another server checking for our id). The
// shape is kiosk-presence.ts's: module state, one responder per process.
//
// The schedule, in one place:
//   - a round goes out when the responder starts (boot, the restart after a
//     restore, discovery switched on) and when the id changes (checkNow);
//   - evidence heard while nothing is running starts a round at once;
//   - every round that finishes, counted or failed, schedules the next one only
//     while something is flagged. With nothing flagged, no timer runs.
//
// An address clears after CLEAR_AFTER_MISSES counted rounds in a row with nothing
// from it, so one lost datagram cannot flicker the flag.

import type { DuplicateCheck, DuplicateServer } from "../types/kiosk.js";
import { scrub } from "./scrub.js";

const RECHECK_MS = 60_000;
const REPLY_WINDOW_MS = 3_000;
/** Evidence is kept from this many addresses; the first heard are kept, and
 *  each was logged. */
const MAX_DUPLICATES = 8;
const CLEAR_AFTER_MISSES = 2;

export interface DuplicateCheckOptions {
  /** Send the check once, to every target. Answers null when it went out
   *  anywhere, or why it went out nowhere. Never rejects. */
  send: () => Promise<string | null>;
  /** The id being checked for, for the log line. */
  serverId: () => string;
  /** Told whenever the check's state or the duplicates change. */
  onChange?: (state: DuplicateCheck) => void;
  /** The discovery port, for the log line. */
  port: number;
  recheckMs?: number;
  replyWindowMs?: number;
}

let opts: DuplicateCheckOptions | null = null;
const duplicates = new Map<string, DuplicateServer>();
/** The counted round each address was last heard in (see `counted`). */
const lastHeard = new Map<string, number>();
/** Rounds counted so far. Evidence belongs to round `counted + 1`. */
let counted = 0;
/** Rounds started. A send that resolves after a newer one started is ignored. */
let started = 0;
/** Whether a round is out: sent (or sending) and not yet counted or failed. */
let inFlight = false;
let check: DuplicateCheck["check"] = { state: "off" };
let windowTimer: ReturnType<typeof setTimeout> | null = null;
let recheckTimer: ReturnType<typeof setTimeout> | null = null;
let sendFailing = false;

/** Whether two reports say the same thing, so an unchanged one is not broadcast. */
export function sameDuplicateCheck(a: DuplicateCheck, b: DuplicateCheck): boolean {
  if (a.check.state !== b.check.state || a.check.at !== b.check.at || a.check.reason !== b.check.reason) return false;
  if (a.duplicates.length !== b.duplicates.length) return false;
  return a.duplicates.every((d, i) => {
    const e = b.duplicates[i];
    return d.address === e.address && d.url === e.url && d.name === e.name && d.since === e.since;
  });
}

/** What the check knows now. */
export function duplicateCheckState(): DuplicateCheck {
  return {
    check,
    duplicates: [...duplicates.values()].sort((a, b) => a.address.localeCompare(b.address)),
  };
}

function report(): void {
  opts?.onChange?.(duplicateCheckState());
}

function clearTimers(): void {
  if (windowTimer) clearTimeout(windowTimer);
  if (recheckTimer) clearTimeout(recheckTimer);
  windowTimer = null;
  recheckTimer = null;
}

/** Forget every round and everything heard, and set the check's state. */
function reset(state: DuplicateCheck["check"]): void {
  clearTimers();
  started += 1; // anything still in flight is now stale
  inFlight = false;
  duplicates.clear();
  lastHeard.clear();
  check = state;
}

/** Begin checking. The first round goes out at once. */
export function startDuplicateCheck(next: DuplicateCheckOptions): void {
  reset({ state: "off" });
  opts = next;
  sendFailing = false;
  checkNow();
}

/** Stop, forgetting everything heard: a stopped responder hears nobody, so it can
 *  claim nothing. `state` says why (off, or the socket failed). */
export function stopDuplicateCheck(state: DuplicateCheck["check"] = { state: "off" }): void {
  if (!opts) return;
  reset(state);
  report();
  opts = null;
}

/**
 * Forget what was heard and check again now. For a changed id: the server that
 * shares the old id keeps it, so nothing heard about it says anything any more.
 */
export function recheckFromScratch(): void {
  if (!opts) return;
  clearTimers();
  duplicates.clear();
  lastHeard.clear();
  report();
  checkNow();
}

/** One round: send, then count what is heard for replyWindowMs. */
function checkNow(): void {
  const o = opts;
  if (!o) return;
  if (windowTimer) clearTimeout(windowTimer);
  windowTimer = null;
  const round = ++started;
  inFlight = true;
  void o.send().then((failure) => {
    // Stopped, or overtaken by a newer round, while this was sending.
    if (round !== started || opts !== o) return;
    if (failure !== null) {
      if (!sendFailing) console.warn(`[kiosk-responder] could not send the duplicate-id check on udp/${o.port}: ${scrub(failure, 400)}`);
      sendFailing = true;
      check = { state: "failed", at: Date.now(), reason: failure };
      finishRound();
      return;
    }
    sendFailing = false;
    // Out, and its answers still arriving: "nobody answered" is not true yet.
    check = { state: "checking", at: Date.now() };
    report();
    // A newer round, a stop and a restart all clear this timer (checkNow, reset).
    windowTimer = setTimeout(() => {
      windowTimer = null;
      countRound();
    }, o.replyWindowMs ?? REPLY_WINDOW_MS);
    windowTimer.unref?.();
  });
}

/** The window closed: clear whoever has been silent for CLEAR_AFTER_MISSES rounds. */
function countRound(): void {
  counted += 1;
  for (const address of [...duplicates.keys()]) {
    if (counted - (lastHeard.get(address) ?? counted) >= CLEAR_AFTER_MISSES) {
      duplicates.delete(address);
      lastHeard.delete(address);
      console.log(`[kiosk-responder] ${scrub(address)} no longer answers as this server`);
    }
  }
  // The answers are counted: "ok", dated when the check went out.
  check = { state: "ok", at: check.at };
  finishRound();
}

/**
 * The end of every round, counted or failed: the one place the next is scheduled.
 * Only while something is flagged; a failed send while flagged still retries,
 * because a round that goes out is the only way a flag clears.
 */
function finishRound(): void {
  inFlight = false;
  report();
  if (recheckTimer || duplicates.size === 0 || !opts) return;
  recheckTimer = setTimeout(() => {
    recheckTimer = null;
    checkNow();
  }, opts.recheckMs ?? RECHECK_MS);
  recheckTimer.unref?.();
}

/**
 * Another server is answering with this server's id. Logged once per address,
 * when first heard; after that it only stays fresh. Heard while no round is out
 * and none is scheduled (another server's check, arriving out of the blue), it
 * starts one, so the flag has a round to clear by.
 */
export function heardDuplicate(address: string, how: string, from?: { url: string; name: string }): void {
  const o = opts;
  if (!o) return;
  const known = duplicates.get(address);
  if (!known && duplicates.size >= MAX_DUPLICATES) return;
  lastHeard.set(address, counted + 1);
  if (known) {
    if (from && !known.url) duplicates.set(address, { ...known, url: from.url, name: from.name });
  } else {
    duplicates.set(address, { address, ...(from && { url: from.url, name: from.name }), since: Date.now() });
    console.warn(
      `[kiosk-responder] another server at ${scrub(address)}${from ? ` (${scrub(from.url)})` : ""} answers as this server, id ${scrub(o.serverId())} (${how}); ` +
        "screens set up here may switch between the two. Give one of them a new server id: Settings > Advanced > Network",
    );
  }
  report();
  if (!inFlight && !recheckTimer) checkNow();
}
