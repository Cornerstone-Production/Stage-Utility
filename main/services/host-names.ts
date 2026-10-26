// host-names.ts — refusing requests by a name this server does not answer to.
//
// The defence against DNS rebinding: see host-name-rules.ts for the attack and
// for the names answered with no list. Every other name has to be on the list:
// this machine's own name, the Public address, or one the operator added.
//
// Two stages, so turning this on cannot black out a Sunday. Until the operator
// turns refusal on, every name is answered and each new one is recorded and
// logged, and the Advanced page offers it to accept or dismiss: prod is reached
// by names nobody wrote down, a panel or a display set up months ago, and this is
// how they surface before anything is refused.
//
// The first time refusal turns on it accepts the names that are plainly in use:
// seen in the last 30 days, over at least a day, and not dismissed. A page can
// make a browser send any name it likes, once, so a name seen in one burst is
// left waiting for the operator, and so are names refused later: turning refusal
// off and on again accepts nothing. Dismissing a name is the operator saying it
// is not theirs; a dismissed name is never accepted on its own.
//
// The list changes only by a request that is itself answered without it: a page
// reaching the server by an unlisted name, while refusal is off, cannot put that
// name on the list for later. What a refused request gets is a 403 naming the
// fix. An IP address always works, so nobody can lock themselves out of Settings.

import * as os from "node:os";

import { broadcast } from "./broadcaster.js";
import { DataStore } from "./data-store.js";
import { asArray, asObject, checked, optional, refuse } from "./restore-check.js";
import { HOST_NAMES_CHANNEL, alwaysAnswered, listableName } from "./host-name-rules.js";
import { hostnameOf } from "./http-origin.js";
import { scrub } from "./scrub.js";

/** Where an accepted name came from, for the card. */
export type AcceptedSource = "added" | "accepted" | "seen";

interface AcceptedName {
  name: string;
  source: AcceptedSource;
  at: string;
}

interface HostNamesConfig {
  /** Refuse names not on the list. Absent is off. */
  enforce?: boolean;
  /** When refusal first turned on and accepted the names in use; it does so once. */
  seededAt?: string;
  accepted: AcceptedName[];
  dismissed: string[];
}

export interface SeenName {
  name: string;
  firstSeen: string;
  lastSeen: string;
  count: number;
  /** The address the last request by this name came from. */
  lastFrom: string;
  /** What sent it, as far as its User-Agent says: "Chrome", "Home Assistant". */
  client: string;
}

export interface HostNamesView {
  enforce: boolean;
  /** Whether refusal has already turned on once and accepted the names in use. */
  seeded: boolean;
  /** This machine's own name and the Public address's host, when they need listing. */
  automatic: { name: string; source: "machine" | "public-address" }[];
  accepted: AcceptedName[];
  /** Names seen and not on the list, accepted or dismissed: the ones waiting for a decision. */
  waiting: SeenName[];
  dismissed: SeenName[];
}

export type HostNamesResult = { ok: true } | { ok: false; error: string };

/** The most names remembered as seen. Past it the least established goes. */
export const MAX_SEEN = 50;
/** The most names on the list, and the most dismissed. */
export const MAX_LISTED = 200;
/** Turning refusal on accepts names seen within this long... */
export const SEED_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/** ...and seen over at least this long, which one page visit is not. */
export const ESTABLISHED_MS = 24 * 60 * 60 * 1000;
/** A refused name is logged once, then at most this often, with a count. */
const REFUSED_LOG_INTERVAL_MS = 60 * 60 * 1000;
/** Lines about individual names (new, refused, forgotten) each minute; past it they are counted. */
const NAME_LINES_PER_TICK = 5;
/** The housekeeping tick: counts to disk, held-back log lines out. */
const TICK_MS = 60_000;
/** A new name reaches disk and the card this long after it arrives, with any others. */
const CHANGE_DELAY_MS = 1_000;
/** What a Host header that is not a name is logged and counted under. */
const UNPARSEABLE = "(a Host header that is not a name)";

/** A short name for what sent a request. Display only, never a decision: a
 *  page can set its own User-Agent in some browsers. */
export function clientOf(userAgent: string | undefined): string {
  const ua = userAgent ?? "";
  if (/HomeAssistant/i.test(ua)) return "Home Assistant";
  if (/Companion/i.test(ua)) return "Companion";
  if (/Edg\//.test(ua)) return "Edge";
  if (/Chrome\//.test(ua)) return "Chrome";
  if (/Firefox\//.test(ua)) return "Firefox";
  if (/Safari\//.test(ua)) return "Safari";
  if (/^curl\//.test(ua)) return "curl";
  const first = ua.split(/[\s/]/)[0]?.slice(0, 40);
  return first || "unknown";
}

/** How long a name has been in use: first to last request. */
const spanOf = (s: SeenName) => Date.parse(s.lastSeen) - Date.parse(s.firstSeen);

export interface HostCheck {
  /** Whether to answer. */
  answer: boolean;
  /** The name it was refused under, for the 403. */
  name?: string;
}

interface RequestFacts {
  method?: string;
  path: string;
  from?: string;
  userAgent?: string;
}

export interface HostNamesOptions {
  now?: () => number;
  /** This machine's own name. */
  machineName?: () => string;
  /** How long a new name waits to be written and announced; tests pass 0. */
  changeDelayMs?: number;
}

export class HostNames {
  private config: HostNamesConfig = { accepted: [], dismissed: [] };
  private readonly seen = new Map<string, SeenName>();
  private readonly refusedLog = new Map<string, { at: number; since: number }>();
  private seenDirty = false;
  private nameLines = 0;
  private nameLinesHeld = 0;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private changeTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly refusalOnListeners = new Set<() => void>();
  private readonly now: () => number;
  private readonly machineName: () => string;
  private readonly changeDelayMs: number;
  private publicUrl: () => string | null = () => null;

  constructor(
    private readonly configStore: DataStore<HostNamesConfig>,
    private readonly seenStore: DataStore<{ names: SeenName[] }>,
    opts: HostNamesOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.machineName = opts.machineName ?? (() => os.hostname());
    this.changeDelayMs = opts.changeDelayMs ?? CHANGE_DELAY_MS;
  }

  async init(): Promise<void> {
    const cfg = await this.configStore.load();
    const unreadable = this.configStore.unreadable();
    this.config = {
      enforce: cfg.enforce === true ? true : undefined,
      seededAt: typeof cfg.seededAt === "string" ? cfg.seededAt : undefined,
      accepted: Array.isArray(cfg.accepted) ? cfg.accepted.filter((a) => typeof a?.name === "string") : [],
      dismissed: Array.isArray(cfg.dismissed) ? cfg.dismissed.filter((d) => typeof d === "string") : [],
    };
    const seen = await this.seenStore.load();
    this.seen.clear();
    for (const s of Array.isArray(seen.names) ? seen.names : []) if (typeof s?.name === "string") this.seen.set(s.name, s);
    if (unreadable) {
      console.warn(
        `[security] host names: host-names.json could not be read (${scrub(unreadable.code)}), so refusal is off and the list is empty until it reads`,
      );
    }
    console.log(
      `[security] host names: ${scrub(this.enforcing ? "refusing names not on the list" : "warn only, every name is answered")}; ` +
        `${scrub(this.config.accepted.length)} listed, ${scrub(this.waitingNames().length)} waiting for a decision`,
    );
    if (!this.tickTimer) {
      this.tickTimer = setInterval(() => void this.tick(), TICK_MS);
      this.tickTimer.unref?.();
    }
  }

  /** Where the Public address setting is read from. Set by the server at start,
   *  so this module does not import the stage controller. */
  setPublicUrlSource(source: () => string | null): void {
    this.publicUrl = source;
  }

  /** The Public address changed: the card's automatic names did too. */
  publicUrlChanged(): void {
    this.changed();
  }

  /** Called whenever refusal turns on, so the server can close streams opened by a name now refused. */
  onRefusalOn(listener: () => void): () => void {
    this.refusalOnListeners.add(listener);
    return () => this.refusalOnListeners.delete(listener);
  }

  get enforcing(): boolean {
    return this.config.enforce === true;
  }

  /** The names that need no entry beyond the always-answered forms. */
  private automaticNames(): HostNamesView["automatic"] {
    const out: HostNamesView["automatic"] = [];
    const machine = hostnameOf(this.machineName());
    if (machine && !alwaysAnswered(machine)) out.push({ name: machine, source: "machine" });
    const publicHost = hostnameOf(this.publicUrl());
    if (publicHost && !alwaysAnswered(publicHost) && publicHost !== machine) out.push({ name: publicHost, source: "public-address" });
    return out;
  }

  private known(name: string): boolean {
    if (alwaysAnswered(name)) return true;
    if (this.config.accepted.some((a) => a.name === name)) return true;
    return this.automaticNames().some((a) => a.name === name);
  }

  /** Whether a request by this Host is answered without the list: always
   *  answered, automatic or listed. Records nothing. */
  answersTo(hostHeader: string | undefined): boolean {
    if (!hostHeader) return true;
    const name = hostnameOf(hostHeader);
    return name !== null && this.known(name);
  }

  /**
   * Whether to answer a request sent to `hostHeader`. Records a name not on the
   * list either way; refuses it only while refusal is on.
   */
  check(hostHeader: string | undefined, req: RequestFacts): HostCheck {
    if (!hostHeader) return { answer: true };
    const name = hostnameOf(hostHeader);
    if (!name) {
      // Not a name any page can send; refused only while refusal is on.
      if (!this.enforcing) return { answer: true };
      this.logRefused(UNPARSEABLE, req);
      return { answer: false, name: hostHeader.slice(0, 100) };
    }
    if (this.known(name)) return { answer: true };

    this.record(name, req);
    if (!this.enforcing) return { answer: true };
    this.logRefused(name, req);
    return { answer: false, name };
  }

  /** Count a request by a name not on the list. */
  private record(name: string, req: RequestFacts): void {
    const at = new Date(this.now()).toISOString();
    const lastFrom = req.from ?? "unknown";
    const client = clientOf(req.userAgent);
    this.seenDirty = true;
    const prior = this.seen.get(name);
    if (prior) {
      Object.assign(prior, { lastSeen: at, count: prior.count + 1, lastFrom, client });
      return;
    }
    if (this.seen.size >= MAX_SEEN) this.forgetOne();
    this.seen.set(name, { name, firstSeen: at, lastSeen: at, count: 1, lastFrom, client });
    // A refused name says so on logRefused's line; this one is for a name answered.
    if (!this.enforcing) {
      this.nameLine(
        () =>
          `[security] host name "${scrub(name)}" is not on the list (first request ${scrub(req.method)} ${scrub(req.path)} ` +
          `from ${scrub(lastFrom)}); answered: refusal is off`,
      );
    }
    this.scheduleChange();
  }

  /**
   * Make room for a new name. A name not seen in 30 days goes first, then the
   * one in use the shortest time: a burst of names from one page pushes out
   * its own, never a panel seen for weeks.
   */
  private forgetOne(): void {
    const cutoff = this.now() - SEED_WINDOW_MS;
    let victim: SeenName | null = null;
    const rank = (s: SeenName) => (Date.parse(s.lastSeen) < cutoff ? -1 : spanOf(s));
    for (const s of this.seen.values()) {
      if (!victim || rank(s) < rank(victim) || (rank(s) === rank(victim) && s.lastSeen < victim.lastSeen)) victim = s;
    }
    if (!victim) return;
    this.seen.delete(victim.name);
    this.refusedLog.delete(victim.name);
    this.nameLine(() => `[security] host names: the seen list is full (${scrub(MAX_SEEN)}); forgot "${scrub(victim.name)}", the least established`);
  }

  /**
   * A line about one name. Any page can make a browser send a thousand names,
   * so these share a budget a minute and the rest are counted on one line by
   * the tick, rather than pushing everything else out of the log.
   */
  private nameLine(line: () => string): void {
    if (this.nameLines >= NAME_LINES_PER_TICK) {
      this.nameLinesHeld += 1;
      return;
    }
    this.nameLines += 1;
    // Its parts are scrubbed where it is built; scrubbing the whole is a no-op
    // on them and keeps this call honest on its own.
    console.warn(scrub(line()));
  }

  /** One line for the first refusal of a name; the tick adds one an hour with the count. */
  private logRefused(name: string, req: RequestFacts): void {
    const entry = this.refusedLog.get(name);
    if (entry) {
      entry.since += 1;
      return;
    }
    this.refusedLog.set(name, { at: this.now(), since: 0 });
    this.nameLine(
      () => `[security] refused host name "${scrub(name)}": not on the list (${scrub(req.method)} ${scrub(req.path)} from ${scrub(req.from)})`,
    );
  }

  /** Every minute, from the timer (and a test): counts to disk, and the log lines held back. */
  async tick(): Promise<void> {
    if (this.nameLinesHeld > 0) {
      console.warn(
        `[security] host names: ${scrub(this.nameLinesHeld)} more line(s) about names not on the list in the last minute, not written one by one`,
      );
    }
    this.nameLines = 0;
    this.nameLinesHeld = 0;
    const nowMs = this.now();
    for (const [name, entry] of this.refusedLog) {
      if (entry.since === 0 || nowMs - entry.at < REFUSED_LOG_INTERVAL_MS) continue;
      console.warn(`[security] refused host name "${scrub(name)}": ${scrub(entry.since)} more request(s) since the last line`);
      entry.at = nowMs;
      entry.since = 0;
    }
    if (this.seenDirty) await this.flushSeen();
  }

  private scheduleChange(): void {
    if (this.changeTimer) return;
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null;
      void this.flushSeen();
      this.changed();
    }, this.changeDelayMs);
    this.changeTimer.unref?.();
  }

  private async flushSeen(): Promise<void> {
    this.seenDirty = false;
    try {
      await this.seenStore.save({ names: [...this.seen.values()] });
    } catch (err) {
      // An observation, written again by the next tick; nothing an operator did is lost.
      this.seenDirty = true;
      console.warn("[security] host names: could not save the seen list:", scrub(String(err)));
    }
  }

  private waitingNames(): SeenName[] {
    return [...this.seen.values()]
      .filter((s) => !this.known(s.name) && !this.config.dismissed.includes(s.name))
      .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
  }

  view(): HostNamesView {
    return {
      enforce: this.enforcing,
      seeded: this.config.seededAt !== undefined,
      automatic: this.automaticNames(),
      accepted: [...this.config.accepted],
      waiting: this.waitingNames(),
      dismissed: this.config.dismissed.map(
        (name) => this.seen.get(name) ?? { name, firstSeen: "", lastSeen: "", count: 0, lastFrom: "", client: "" },
      ),
    };
  }

  private changed(): void {
    broadcast(HOST_NAMES_CHANNEL, { waiting: this.waitingNames().length, enforce: this.enforcing });
  }

  /** Save `next`, and only then make it the config: a failed save changes nothing. */
  private async commit(next: HostNamesConfig): Promise<void> {
    await this.configStore.save(next);
    this.config = next;
    this.changed();
  }

  /**
   * Turn refusal on or off. The first time it turns on it accepts the names in
   * use (see the top of this file), each one logged.
   */
  async setEnforce(on: boolean): Promise<void> {
    if (on === this.enforcing) return;
    const at = new Date(this.now()).toISOString();
    const seeding = on && !this.config.seededAt;
    const seeded = seeding ? this.namesInUse() : [];
    const room = MAX_LISTED - this.config.accepted.length;
    const next: HostNamesConfig = {
      ...this.config,
      enforce: on ? true : undefined,
      seededAt: seeding ? at : this.config.seededAt,
      accepted: [...this.config.accepted, ...seeded.slice(0, room).map((s) => ({ name: s.name, source: "seen" as const, at }))],
    };
    await this.commit(next);
    for (const s of seeded.slice(0, room)) {
      console.log(`[security] host checking is on; accepted "${scrub(s.name)}", in use over ${scrub(Math.round(spanOf(s) / 3_600_000))} hours`);
    }
    if (seeding) {
      const left = this.waitingNames().length;
      if (left > 0) console.log(`[security] host checking is on; ${scrub(left)} name(s) left waiting: seen once, or not in the last 30 days`);
    }
    console.log(`[security] host names: ${scrub(on ? "refusing names not on the list" : "refusal turned off; every name is answered")}`);
    if (on) for (const listener of this.refusalOnListeners) listener();
  }

  /** Waiting names seen in the last 30 days over at least a day. */
  private namesInUse(): SeenName[] {
    const cutoff = this.now() - SEED_WINDOW_MS;
    return this.waitingNames().filter((s) => Date.parse(s.lastSeen) >= cutoff && spanOf(s) >= ESTABLISHED_MS);
  }

  /** Put a name on the list: typed (`added`) or picked from the waiting list (`accepted`). */
  async add(raw: string, source: "added" | "accepted"): Promise<HostNamesResult> {
    const parsed = listableName(raw);
    if (!parsed.ok) return parsed;
    const { name } = parsed;
    if (this.known(name)) return { ok: true };
    if (this.config.accepted.length >= MAX_LISTED) return { ok: false, error: `The list is full (${MAX_LISTED} names); remove one first.` };
    await this.commit({
      ...this.config,
      accepted: [...this.config.accepted, { name, source, at: new Date(this.now()).toISOString() }],
      dismissed: this.config.dismissed.filter((d) => d !== name),
    });
    console.log(`[security] host name "${scrub(name)}" ${scrub(source)} by the operator`);
    return { ok: true };
  }

  async remove(name: string): Promise<void> {
    if (!this.config.accepted.some((a) => a.name === name)) return;
    await this.commit({ ...this.config, accepted: this.config.accepted.filter((a) => a.name !== name) });
    console.log(`[security] host name "${scrub(name)}" removed from the list by the operator`);
  }

  /** Mark a waiting name as not the operator's. Only a name that is waiting. */
  async dismiss(name: string): Promise<HostNamesResult> {
    if (this.config.dismissed.includes(name)) return { ok: true };
    if (!this.waitingNames().some((s) => s.name === name)) return { ok: false, error: "That name is not waiting for a decision." };
    if (this.config.dismissed.length >= MAX_LISTED) {
      return { ok: false, error: `The dismissed list is full (${MAX_LISTED} names); undo one first.` };
    }
    await this.commit({ ...this.config, dismissed: [...this.config.dismissed, name] });
    console.log(`[security] host name "${scrub(name)}" dismissed by the operator: it will not be accepted on its own`);
    return { ok: true };
  }

  async undismiss(name: string): Promise<void> {
    if (!this.config.dismissed.includes(name)) return;
    await this.commit({ ...this.config, dismissed: this.config.dismissed.filter((d) => d !== name) });
  }

  /** For a stopping server or a test: write what is pending, stop the timers. */
  async stop(): Promise<void> {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    if (this.changeTimer) clearTimeout(this.changeTimer);
    this.changeTimer = null;
    if (this.seenDirty) await this.flushSeen();
  }
}

/**
 * A restored host-name list, held to what `add` and `dismiss` take: every
 * listed name one listableName accepts (and stored as it returns it), at most
 * MAX_LISTED of each. This list decides which names the server answers to, so
 * a restore must not be a way onto it that the card is not.
 */
const restoreCheck = checked((raw) => {
  const cfg = asObject(raw, "the host names");
  optional(cfg.enforce, "boolean", "enforce");
  optional(cfg.seededAt, "string", "seededAt");
  const accepted = asArray(cfg.accepted ?? [], "the accepted host names");
  const dismissed = asArray(cfg.dismissed ?? [], "the dismissed host names");
  for (const [list, what] of [[accepted, "accepted"], [dismissed, "dismissed"]] as const) {
    if (list.length > MAX_LISTED) refuse(`at most ${MAX_LISTED} ${what} host names (this has ${list.length})`);
  }
  const listable = (name: unknown, what: string): string => {
    const parsed = typeof name === "string" ? listableName(name) : null;
    if (!parsed?.ok) refuse(`the ${what} host name "${String(name).slice(0, 60)}" is not one the list takes`);
    return parsed.name;
  };
  return {
    ...cfg,
    accepted: accepted.map((a, i) => {
      const entry = asObject(a, `accepted host name ${i + 1}`);
      return { ...entry, name: listable(entry.name, "accepted") };
    }),
    dismissed: dismissed.map((d) => listable(d, "dismissed")),
  };
});

export const hostNamesConfigStore = new DataStore<HostNamesConfig>("host-names.json", { accepted: [], dismissed: [] }, "config", { restoreCheck });
export const hostNamesSeenStore = new DataStore<{ names: SeenName[] }>("host-names-seen.json", { names: [] }, "runtime");

export const hostNames = new HostNames(hostNamesConfigStore, hostNamesSeenStore);
