// use-qsys-values.ts — a Q-SYS panel's live values, and the only way it writes.
//
// One store per panel (the View holding the Q-SYS objects), shared by every
// object on it and counted by how many are mounted: one watch registration, one
// hydration, one meter loop, however many objects read it.
//
// While mounted the store names `qsys:watch:<viewId>`, which is what makes the
// server watch this panel's controls at all. Values come from two places only,
// both the Core's: the hydration read (GET /api/qsys/values), and the pushes on
// `qsys:values` and `qsys:meters:<kind>`, which carry changes and nothing else.
// The pushes are not replayed on connect (sse-channels.ts), so the read is how a
// panel learns where everything stands.
//
// The rules this file exists to keep, for every Q-SYS panel:
//
// - The page never sends its own state to the Core. Hydrating, reconnecting,
//   waking and receiving values send nothing. Only a fresh pointer gesture
//   writes (useQsysWrite).
// - Input waits for the Core's current state. On mount, on every stream
//   reconnect and on waking, the store waits for the server to acknowledge this
//   page's channels (api.ts whenSubscribed) and then reads the panel; until that
//   read lands every object is "offline": greyed and deaf. Hidden is not live.
//   A new catalog (the Core rebooted or was redeployed) closes input until it
//   has been read too.
// - A write still waiting to go when the stream drops, the page is hidden or
//   the Core goes away is discarded, never sent later. The `epoch` counts those
//   breaks; a gesture in progress ends when it moves.
// - Nothing is lit from the page's own last write. A write's read-back is the
//   Core's answer and is shown as such; a refusal shows the Core's value again.

import { createContext, useContext, useEffect, useMemo, useSyncExternalStore } from "react";

import type { WriteResult } from "@main/services/qsys/qsys-write";
import { addressKey, isReadOnlyDirection, type PanelKind, type QsysAddress } from "@main/types/qsys";
import { getStreamStatus, invoke, onNotification, onStreamStatusChange, streamClientId, whenSubscribed } from "../../lib/api";
import { logToServer } from "../../lib/client-log";
import { MeterAnimator, type MeterSink } from "./meter-tween";

export type { WriteResult };

/** "live": a Core value, input accepted. "offline": the Core or this page's stream is
 *  not there, or the panel has not been read since it came back. "unavailable": no
 *  binding, no such panel, or a control the Core has no value for. */
export type QsysState = "live" | "offline" | "unavailable";

export interface QsysReading {
  value: unknown;
  string: string;
  position: number | null;
}

export interface QsysValue extends QsysReading {
  state: QsysState;
}

/** What the panel knows about a control from the Core's catalog and the allowlist. */
export interface QsysControlInfo {
  /** The Core's Type ("Float", "Boolean", "Trigger", …); "" until the catalog is read. */
  type: string;
  /** The Core's own range; null when it reports none or the catalog is not read. */
  range: { min: number; max: number } | null;
  /** The choices a combo box offers, when the Core lists them. */
  choices: string[] | null;
  /** False when the Core reports the control read-only (Direction "Read"). */
  writable: boolean;
  /** On the allowlist: writable at all. */
  allowed: boolean;
  /** The allowlist's write limits; null where there are none. */
  limits: { min: number | null; max: number | null };
  /** The allowlist asks every object on this control to hold to confirm. */
  hold: boolean;
}

/** Whether input is open, what the Connection status object says, and the break count. */
export interface QsysPanelState {
  live: boolean;
  connection: "connected" | "reconnecting" | "offline";
  epoch: number;
}

/** Worst of several states: offline beats unavailable beats live. */
export function combineStates(...states: QsysState[]): QsysState {
  if (states.includes("offline")) return "offline";
  if (states.includes("unavailable")) return "unavailable";
  return "live";
}

/** The SSE channel a panel's values arrive on. Mirrors main/services/qsys/qsys-watch.ts. */
export const QSYS_VALUES_CHANNEL = "qsys:values";
export const qsysMeterChannel = (kind: PanelKind): string => `qsys:meters:${kind}`;
export const qsysWatchChannel = (viewId: string): string => `qsys:watch:${viewId}`;
const QSYS_STATUS_CHANNEL = "qsys:status";

/** The release of a drag always writes; in between, at most one write this often. */
export const DRAG_COALESCE_MS = 40;
/** Not ready yet (the Core reconnecting): read again after this, doubling to the cap. */
const RETRY_FIRST_MS = 1_000;
const RETRY_MAX_MS = 8_000;

type Change = { Component?: unknown; Name?: unknown; Value?: unknown; String?: unknown; Position?: unknown };
type ValuesAnswer = { ready: boolean; values: { component: string; control: string; value: unknown; string: string; position?: number }[] };
type AllowAnswer = { entries: { component: string; control: string; min: number | null; max: number | null; confirm: "none" | "hold" }[] };
type CatalogAnswer = {
  designCode: string;
  components: { name: string; controls: { Name: string; Type: string; Direction?: string; ValueMin?: number; ValueMax?: number; Choices?: unknown }[] }[];
};
type StatusPush = { connected?: unknown; state?: unknown; catalogAt?: unknown };

/** A write that never left this page, said in the same shape as the server's refusals. */
const notSent = (message: string): WriteResult => ({ ok: false, reason: "offline", message });

const readingOf = (c: Change): QsysReading => ({
  value: c.Value,
  string: typeof c.String === "string" ? c.String : String(c.Value ?? ""),
  position: typeof c.Position === "number" ? c.Position : null,
});

interface Held {
  value: number | boolean | string;
  final: boolean;
  epoch: number;
  waiters: ((r: WriteResult) => void)[];
  /** A momentary press: the server holds a lease the page renews (renewLease). */
  lease: boolean;
}

/** The Core's echo of a value this page sent: equal, within its float precision. */
const sameValue = (a: unknown, b: unknown): boolean =>
  typeof a === "number" && typeof b === "number" ? Math.abs(a - b) <= 0.01 : a === b;

/** One control's writes: one in flight at a time, so they land in the order they were made. */
interface Lane {
  inFlight: boolean;
  held: Held | null;
  timer: ReturnType<typeof setTimeout> | null;
  lastSentAt: number;
  coalesceMs: number;
  /** Values this gesture's drag writes sent: a push carrying one is the Core's echo
   *  of the page's own write, not news, so it does not outrank the release's read-back. */
  echoes: unknown[];
}

export class QsysPanel {
  private readings = new Map<string, QsysReading>();
  private info = new Map<string, Omit<QsysControlInfo, "allowed" | "limits" | "hold">>();
  private allow: Map<string, AllowAnswer["entries"][number]> | null = null;
  private catalogAt: unknown = undefined;
  private catalogRead = false;

  /**
   * A read has landed since the last break that started AFTER the server
   * acknowledged this page's channels (see `resync`). Input waits for it: a read
   * sent before the acknowledgement can miss a change that no push carries.
   */
  private hydrated = false;
  /** Bumped by every break; a resync whose acknowledgement belongs to an older one is ignored. */
  private syncGen = 0;
  private ackedGen = -1;
  /** Bumped when the Core announces a new catalog: a read sent before it may carry the old one. */
  private catalogGen = 0;
  private allowFailing = false;
  private lastReadAt = 0;
  private ready = false;
  /** The server has no panel with this id. */
  private missing = false;
  private streamUp = getStreamStatus().up;
  /** The Core connection as its last status push said; null until one arrives. */
  private coreState: "connected" | "reconnecting" | "offline" | null = null;

  private hydrating = false;
  private again = false;
  /** Pushes that arrived while a hydration was on its way: applied over its answer. */
  private buffered: Change[] | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelay = 0;
  /** The last read failed; the next failure is not logged again. */
  private failing = false;
  private catalogFailing = false;
  /** Counts every change to the readings, so a write's read-back can tell whether
   *  anything newer from the Core landed while it was on its way. */
  private stamp = 0;
  private readonly touched = new Map<string, number>();
  private hydratedAt = 0;

  private rev = 0;
  private readonly listeners = new Set<() => void>();
  private readonly snaps = new Map<string, { rev: number; snap: unknown }>();
  private readonly meterListeners = new Map<string, Set<(r: QsysReading) => void>>();
  private readonly lanes = new Map<string, Lane>();
  private offs: (() => void)[] = [];
  private refs = 0;

  /** Counts breaks (a dropped stream, a hidden page, the Core going away). */
  epoch = 0;
  readonly meters = new MeterAnimator();

  constructor(
    readonly id: string,
    readonly kind: PanelKind,
  ) {}

  // ── Lifetime ──────────────────────────────────────────────────────────────

  acquire(): void {
    if (this.refs++ > 0) return;
    // Back after a release (React remounting in place): be the one store for this id again.
    if (!registry.has(this.id)) registry.set(this.id, this);
    const noop = () => {};
    const onVisibility = () => (document.visibilityState === "hidden" ? this.onHidden() : this.onVisible());
    document.addEventListener("visibilitychange", onVisibility);
    this.offs = [
      // Naming this channel is what puts the panel's controls in the Core's change groups.
      onNotification(qsysWatchChannel(this.id), noop),
      onNotification(QSYS_VALUES_CHANNEL, (p) => this.onValues(p)),
      onNotification(qsysMeterChannel(this.kind), (p) => this.onMeters(p)),
      onNotification(QSYS_STATUS_CHANNEL, (p, replayed) => this.onStatus(p as StatusPush, replayed)),
      onStreamStatusChange(() => this.onStream(getStreamStatus().up)),
      () => document.removeEventListener("visibilitychange", onVisibility),
    ];
    this.streamUp = getStreamStatus().up;
    // Read at once so the panel draws, and again once the server has this page's
    // channels; input opens on the second.
    this.hydrate();
    this.resync();
  }

  release(): void {
    if (--this.refs > 0) return;
    for (const off of this.offs.splice(0)) off();
    this.clearRetry();
    this.syncGen++;
    this.breakOff();
    this.meters.dispose();
    this.hydrated = false;
    if (registry.get(this.id) === this) registry.delete(this.id);
  }

  // ── Reading ───────────────────────────────────────────────────────────────

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  /**
   * The answer to one question, as the same object until the answer changes.
   * useSyncExternalStore needs that, and it is what React renders from: the
   * React Compiler memoises a component's reads on their inputs, so a read off
   * this store that is not the hook's own snapshot is cached past every change
   * (a panel drawn offline for good, in a built page, with every test green).
   */
  private cached<T>(key: string, make: () => T): T {
    const hit = this.snaps.get(key);
    if (hit && hit.rev === this.rev) return hit.snap as T;
    const next = make();
    const snap = hit && JSON.stringify(hit.snap) === JSON.stringify(next) ? (hit.snap as T) : next;
    this.snaps.set(key, { rev: this.rev, snap });
    return snap;
  }

  valueSnapshot(a: QsysAddress | null): QsysValue {
    return this.cached(`v\u0001${a ? addressKey(a) : ""}`, () => this.value(a));
  }

  controlSnapshot(a: QsysAddress | null): QsysControlInfo {
    return this.cached(`c\u0001${a ? addressKey(a) : ""}`, () => this.control(a));
  }

  /**
   * A control's state for an object that WRITES it: live only when it can be
   * written too. Not on the allowlist, or (`numeric`) no Core range or no write
   * limits, is Unavailable, as the binding check reports it: drawn as such and
   * deaf, never a control that looks live and does nothing.
   */
  writeState(a: QsysAddress | null, numeric = false): QsysState {
    const state = this.value(a).state;
    if (state !== "live") return state;
    const c = this.control(a);
    if (!c.allowed || !c.writable) return "unavailable";
    if (numeric && (!c.range || c.limits.min === null || c.limits.max === null)) return "unavailable";
    return "live";
  }

  /** Several controls' states as one: offline beats unavailable beats live. A string, so it is its own snapshot. */
  combinedState(addresses: (QsysAddress | null)[], write = false): QsysState {
    return addresses.length ? combineStates(...addresses.map((a) => (write ? this.writeState(a) : this.value(a).state))) : "unavailable";
  }

  stateSnapshot(): QsysPanelState {
    return this.cached("state", () => ({ live: this.live, connection: this.connection(), epoch: this.epoch }));
  }

  /** Whether input is accepted at all: the stream is up and the panel has been read since. */
  get live(): boolean {
    return this.streamUp && this.hydrated && this.ready && !this.missing;
  }

  /** What the Connection status object says. Reconnecting while the Core or this page's
   *  stream is coming back and the panel is being read again; offline when there is no Core. */
  connection(): "connected" | "reconnecting" | "offline" {
    if (this.live) return "connected";
    if (this.missing || this.coreState === "offline") return "offline";
    if (this.coreState === "reconnecting" || !this.streamUp || !this.hydrated) return "reconnecting";
    return "offline";
  }

  value(a: QsysAddress | null): QsysValue {
    if (!a || this.missing) return { value: null, string: "", position: null, state: "unavailable" };
    const r = this.readings.get(addressKey(a));
    if (!this.live) return { ...(r ?? { value: null, string: "", position: null }), state: "offline" };
    // No value yet for a control the Core's design has: it has not been read since the
    // watch took it in (the first page to open a panel). Held, not Unavailable, so a
    // panel opening does not flash the word at every control.
    if (!r) return { value: null, string: "", position: null, state: this.info.has(addressKey(a)) ? "offline" : "unavailable" };
    return { ...r, state: "live" };
  }

  control(a: QsysAddress | null): QsysControlInfo {
    const k = a ? addressKey(a) : "";
    const base = this.info.get(k) ?? { type: "", range: null, choices: null, writable: true };
    const entry = this.allow?.get(k);
    return {
      ...base,
      allowed: !!entry,
      limits: { min: entry?.min ?? null, max: entry?.max ?? null },
      hold: entry?.confirm === "hold",
    };
  }

  /** Call `cb` with every meter reading for `a`, hydration included. Returns the stop. */
  onMeter(a: QsysAddress, cb: (r: QsysReading) => void): () => void {
    const k = addressKey(a);
    let set = this.meterListeners.get(k);
    if (!set) this.meterListeners.set(k, (set = new Set()));
    set.add(cb);
    const r = this.readings.get(k);
    if (r) cb(r);
    return () => {
      set.delete(cb);
      if (set.size === 0) this.meterListeners.delete(k);
    };
  }

  /** Draw meter `a` into `sink`, eased between samples. Returns the stop. */
  addMeterSink(a: QsysAddress, level: (r: QsysReading) => number, sink: MeterSink): () => void {
    const k = addressKey(a);
    const stopDraw = this.meters.add(k, sink);
    let first = true;
    const stopListen = this.onMeter(a, (r) => {
      this.meters.sample(k, level(r), first);
      first = false;
    });
    return () => {
      stopListen();
      stopDraw();
    };
  }

  private bump(): void {
    this.rev++;
    for (const cb of [...this.listeners]) cb();
  }

  // ── Hydration ─────────────────────────────────────────────────────────────

  /**
   * Input closes until the server has acknowledged this page's channels and a
   * read sent after that has landed. On mount, on every stream reconnect, and on
   * waking: each is a moment the server may not have this page's filter.
   */
  private resync(): void {
    this.hydrated = false;
    const gen = ++this.syncGen;
    void whenSubscribed().then((acked) => {
      if (gen !== this.syncGen || this.refs === 0) return;
      if (!acked) {
        // Read anyway: a panel must not stay closed for ever. Said, because a change made
        // before the server took this page's channels may be missed until it changes again.
        logToServer("qsys", `panel ${this.id}: the server did not acknowledge this page's channels in time; reading anyway`);
      }
      this.ackedGen = gen;
      this.hydrate();
    });
  }

  /** Read the panel again. Input stays off until the answer lands. */
  hydrate(): void {
    if (this.hydrating) {
      this.again = true;
      return;
    }
    this.hydrating = true;
    this.buffered = [];
    void this.readPanel().finally(() => {
      this.hydrating = false;
      this.buffered = null;
      this.bump();
      if (this.again && this.refs > 0) {
        this.again = false;
        this.hydrate();
      }
    });
  }

  private async readPanel(): Promise<void> {
    // Only a read sent after the acknowledgement may open input (see `hydrated`).
    const opens = this.ackedGen === this.syncGen;
    const gen = this.syncGen;
    const catalogGen = this.catalogGen;
    this.lastReadAt = Date.now();
    const [values, allow] = await Promise.allSettled([
      invoke<ValuesAnswer>("qsys:panelValues", { panel: this.id }),
      invoke<AllowAnswer>("qsys:allowlist"),
    ]);
    const ready = values.status === "fulfilled" && values.value.ready === true;
    // The catalog only exists while connected; while not, the status says whether the
    // Core is coming back (Reconnecting) or not there (Offline). Neither is pushed on connect.
    const [catalog, status] = await Promise.allSettled([
      ready && !this.catalogRead ? invoke<CatalogAnswer>("qsys:catalog") : Promise.resolve(null),
      ready ? Promise.resolve(null) : invoke<StatusPush>("qsys:status"),
    ]);
    if (this.refs === 0) return;
    if (status.status === "fulfilled" && status.value) this.noteCoreState(status.value.state);

    if (allow.status === "fulfilled") {
      this.allow = new Map(allow.value.entries.map((e) => [addressKey(e), e]));
      this.allowFailing = false;
    } else {
      // Without it nothing on the page counts as writable; the server would refuse anyway.
      // Once per run of failures.
      if (!this.allowFailing) logToServer("qsys", `panel ${this.id}: the allowlist could not be read (${String(allow.reason)})`);
      this.allowFailing = true;
    }
    // A new catalog announced while this read was out: what it read may be the old one.
    const catalogCurrent = catalogGen === this.catalogGen;
    if (catalog.status === "fulfilled" && catalog.value && catalogCurrent) {
      this.readCatalog(catalog.value);
      this.catalogFailing = false;
    }

    if (values.status === "rejected") {
      const status = (values.reason as { status?: number } | null)?.status;
      if (status === 404) {
        if (!this.missing) logToServer("qsys", `panel ${this.id} is not a Q-SYS panel on the server; its objects show Unavailable`);
        this.missing = true;
        return;
      }
      // Once per run of failures, not once per retry.
      if (!this.failing) logToServer("qsys", `panel ${this.id}: its values could not be read (${String(values.reason)}); retrying`);
      this.failing = true;
      this.hydrated = false;
      this.ready = false;
      this.scheduleRetry();
      return;
    }

    this.missing = false;
    this.failing = false;
    this.readings = new Map(values.value.values.map((v) => [addressKey(v), readingOf({ Value: v.value, String: v.string, Position: v.position })]));
    // A push that arrived while the read was on its way is newer than the read's answer.
    this.hydratedAt = ++this.stamp;
    for (const c of this.buffered ?? []) this.store(c);
    // A break during the read: what it read stays on screen, but it opens nothing.
    if (opens && gen === this.syncGen && catalogCurrent) this.hydrated = true;
    this.ready = values.value.ready === true;
    const catalogFailed = catalog.status === "rejected";
    if (catalogFailed) {
      // Without it no fader has a range, so every one reads Unavailable: say so, and try again.
      if (!this.catalogFailing) logToServer("qsys", `panel ${this.id}: the Core's catalog could not be read (${String(catalog.reason)}); faders stay Unavailable until it is; retrying`);
      this.catalogFailing = true;
    }
    if (this.ready && !catalogFailed) this.clearRetry();
    else this.scheduleRetry();
    for (const [k, set] of this.meterListeners) {
      const r = this.readings.get(k);
      if (r) for (const cb of set) cb(r);
    }
  }

  private readCatalog(c: CatalogAnswer): void {
    const info = new Map<string, Omit<QsysControlInfo, "allowed" | "limits" | "hold">>();
    for (const comp of c.components) {
      for (const ctl of comp.controls) {
        const ranged = Number.isFinite(ctl.ValueMin) && Number.isFinite(ctl.ValueMax) && ctl.ValueMin! < ctl.ValueMax!;
        info.set(addressKey({ component: comp.name, control: ctl.Name }), {
          type: String(ctl.Type ?? ""),
          range: ranged ? { min: ctl.ValueMin!, max: ctl.ValueMax! } : null,
          choices: Array.isArray(ctl.Choices) ? ctl.Choices.filter((x): x is string => typeof x === "string") : null,
          writable: !isReadOnlyDirection(ctl.Direction),
        });
      }
    }
    this.info = info;
    this.catalogRead = true;
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.refs === 0) return;
    this.retryDelay = this.retryDelay ? Math.min(this.retryDelay * 2, RETRY_MAX_MS) : RETRY_FIRST_MS;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.hydrate();
    }, this.retryDelay);
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retryDelay = 0;
  }

  // ── Pushes ────────────────────────────────────────────────────────────────

  private changesOf(payload: unknown): Change[] {
    const changes = (payload as { changes?: unknown } | null)?.changes;
    return Array.isArray(changes) ? (changes as Change[]).filter((c) => c && typeof c.Component === "string" && typeof c.Name === "string") : [];
  }

  private store(c: Change): string {
    const k = addressKey({ component: c.Component as string, control: c.Name as string });
    this.readings.set(k, readingOf(c));
    // An echo of this page's own drag write is not newer than its release's read-back.
    const echo = this.lanes.get(k)?.echoes.some((v) => sameValue(v, c.Value));
    if (!echo) this.touched.set(k, ++this.stamp);
    return k;
  }

  private onValues(payload: unknown): void {
    const changes = this.changesOf(payload);
    if (changes.length === 0) return;
    if (this.buffered) this.buffered.push(...changes);
    for (const c of changes) this.store(c);
    // Values arriving while not ready: the Core is back and re-read; ask whether writes
    // are open. At most once a second: values can flow while the server is not ready.
    if (!this.ready && this.hydrated && !this.hydrating && Date.now() - this.lastReadAt >= RETRY_FIRST_MS) this.hydrate();
    this.bump();
  }

  private onMeters(payload: unknown): void {
    for (const c of this.changesOf(payload)) {
      if (this.buffered) this.buffered.push(c);
      const k = this.store(c);
      const r = this.readings.get(k)!;
      for (const cb of this.meterListeners.get(k) ?? []) cb(r);
    }
  }

  private noteCoreState(state: unknown): void {
    if (state === "connected" || state === "reconnecting" || state === "offline") this.coreState = state;
  }

  private onStatus(p: StatusPush, replayed: boolean): void {
    if (replayed || !p) return;
    this.noteCoreState(p.state);
    if (p.catalogAt !== this.catalogAt) {
      const known = this.catalogAt !== undefined;
      this.catalogAt = p.catalogAt;
      this.catalogRead = false;
      // A new catalog (a redeploy, a Core reboot): ranges, types and choices may all
      // have changed. Close input until it is read again.
      if (known) {
        this.catalogGen++;
        this.breakOff();
        this.hydrated = false;
        this.bump();
      }
    }
    if (p.connected === true) {
      this.hydrate();
      return;
    }
    // The Core went away: nothing pending may land when it comes back.
    this.breakOff();
    this.ready = false;
    this.bump();
  }

  private onStream(up: boolean): void {
    if (up === this.streamUp) return;
    this.streamUp = up;
    if (!up) {
      this.syncGen++;
      this.breakOff();
      this.hydrated = false;
    } else {
      // The Core may have rebooted or been redeployed while this page could not hear.
      this.catalogRead = false;
      this.resync();
    }
    this.bump();
  }

  /** Hidden (an iPad sleeping, a tab switched away): not live. Gestures end, holds
   *  cancel, waiting writes are dropped, and nothing opens again until a fresh read. */
  private onHidden(): void {
    this.meters.pause();
    this.syncGen++;
    this.breakOff();
    this.hydrated = false;
    this.bump();
  }

  /** Woken: read again, catalog too, before accepting input; the stream may have died unnoticed. */
  private onVisible(): void {
    this.catalogRead = false;
    this.resync();
    this.bump();
  }

  /** A break: every write still waiting is discarded, and a gesture in progress ends. */
  private breakOff(): void {
    this.epoch++;
    for (const lane of this.lanes.values()) {
      if (lane.timer) clearTimeout(lane.timer);
      lane.timer = null;
      lane.echoes = [];
      const held = lane.held;
      lane.held = null;
      for (const w of held?.waiters ?? []) w(notSent("the connection dropped; this change was not sent"));
    }
  }

  // ── Writing ───────────────────────────────────────────────────────────────

  /**
   * Write one control. `final: false` is the middle of a drag: such writes go at
   * most once per `coalesceMs`, the latest value winning. A final write goes as
   * soon as the one before it has answered. Refused here, unsent, when the panel
   * is not live; discarded, unsent, when a break comes while it waits.
   */
  write(a: QsysAddress, value: number | boolean | string, opts: { final?: boolean; coalesceMs?: number; lease?: boolean } = {}): Promise<WriteResult> {
    const final = opts.final !== false;
    if (!this.live) return Promise.resolve(notSent("the sound system is offline or still being read; nothing was sent"));
    const k = addressKey(a);
    let lane = this.lanes.get(k);
    if (!lane) this.lanes.set(k, (lane = { inFlight: false, held: null, timer: null, lastSentAt: -Infinity, coalesceMs: DRAG_COALESCE_MS, echoes: [] }));
    lane.coalesceMs = opts.coalesceMs ?? DRAG_COALESCE_MS;
    return new Promise<WriteResult>((resolve) => {
      const waiters = [...(lane.held?.waiters ?? []), resolve];
      lane.held = { value, final, epoch: this.epoch, waiters, lease: opts.lease === true };
      this.pump(a, lane);
    });
  }

  private pump(a: QsysAddress, lane: Lane): void {
    const held = lane.held;
    if (!held || lane.inFlight) return;
    if (held.epoch !== this.epoch || !this.live) {
      lane.held = null;
      for (const w of held.waiters) w(notSent("the connection dropped; this change was not sent"));
      return;
    }
    const wait = held.final ? 0 : lane.lastSentAt + lane.coalesceMs - Date.now();
    if (wait > 0) {
      lane.timer ??= setTimeout(() => {
        lane.timer = null;
        this.pump(a, lane);
      }, wait);
      return;
    }
    if (lane.timer) clearTimeout(lane.timer);
    lane.timer = null;
    lane.held = null;
    lane.inFlight = true;
    lane.lastSentAt = Date.now();
    const sentAt = this.stamp;
    if (!held.final) lane.echoes.push(held.value);
    const body = {
      component: a.component,
      control: a.control,
      value: held.value,
      panelId: this.id,
      final: held.final,
      ...(held.lease ? { lease: true, cid: streamClientId() } : {}),
    };
    void invoke<WriteResult>("qsys:write", body)
      .catch((err: unknown): WriteResult => {
        logToServer("qsys", `panel ${this.id}: a write to ${a.component}/${a.control} did not reach the server (${String(err)})`);
        return { ok: false, reason: "offline", message: "the write did not reach the server" };
      })
      .then((result) => {
        lane.inFlight = false;
        if (held.final) {
          if (result.ok) this.adoptReadBack(a, result, sentAt);
          lane.echoes = [];
        }
        for (const w of held.waiters) w(result);
        // A refusal ends the gesture: the drag values queued behind it are not sent.
        const next = lane.held;
        if (!result.ok) lane.echoes = [];
        if (!result.ok && next && !next.final) {
          lane.held = null;
          if (lane.timer) clearTimeout(lane.timer);
          lane.timer = null;
          for (const w of next.waiters) w(result);
        }
        this.pump(a, lane);
      });
  }

  /**
   * Renew a held momentary's lease (see main/services/qsys/qsys-leases.ts). Only
   * while the press is still held and nothing broke; a failure is the server's to
   * notice (the lease lapses and it releases the control), so it is not retried.
   */
  renewLease(a: QsysAddress): Promise<boolean> {
    return invoke<{ held?: unknown }>("qsys:lease", { component: a.component, control: a.control }).then(
      (r) => r.held === true,
      () => false,
    );
  }

  /**
   * The Core's answer to a gesture's last write is the Core's value: show it,
   * unless something newer from the Core (a push for this control, or a fresh
   * read) landed while the write was on its way. Another panel moving the same
   * fader then wins, and this one does not sit on its own value.
   */
  private adoptReadBack(a: QsysAddress, result: Extract<WriteResult, { ok: true }>, sentAt: number): void {
    const k = addressKey(a);
    if ((this.touched.get(k) ?? 0) > sentAt || this.hydratedAt > sentAt) return;
    this.readings.set(k, { value: result.value, string: result.string, position: result.position ?? null });
    this.bump();
  }
}

// ── The registry, and the React side ────────────────────────────────────────

const registry = new Map<string, QsysPanel>();

function panelFor(id: string, kind: PanelKind): QsysPanel {
  let p = registry.get(id);
  if (!p || p.kind !== kind) {
    p = new QsysPanel(id, kind);
    registry.set(id, p);
  }
  return p;
}

/** Test seam: forget every panel, as a fresh page would. */
export function __resetQsysPanelsForTests(): void {
  registry.clear();
}

/**
 * The store for panel `viewId`, held for as long as the calling component is
 * mounted. Null without a view (Home, a bare preview): nothing is watched and
 * every object reads Unavailable. `kind` picks the meter channel; every panel is
 * "staff" until a View carries its own Q-SYS kind.
 */
export function useQsysPanel(viewId: string | null, kind: PanelKind = "staff"): QsysPanel | null {
  const panel = useMemo(() => (viewId ? panelFor(viewId, kind) : null), [viewId, kind]);
  useEffect(() => {
    if (!panel) return;
    panel.acquire();
    return () => panel.release();
  }, [panel]);
  return panel;
}

export const QsysPanelContext = createContext<QsysPanel | null>(null);

const noSubscribe = () => () => {};

/** The panel this object is on, for effects and handlers. Never read values off it in
 *  render: use the hooks below, whose snapshots are what re-render a component. */
export function useQsysPanelContext(): QsysPanel | null {
  return useContext(QsysPanelContext);
}

const UNAVAILABLE: QsysValue = { value: null, string: "", position: null, state: "unavailable" };
const NO_CONTROL: QsysControlInfo = { type: "", range: null, choices: null, writable: false, allowed: false, limits: { min: null, max: null }, hold: false };
const NO_PANEL: QsysPanelState = { live: false, connection: "offline", epoch: 0 };

/** One control's value as the Core last reported it, and whether input is open. */
export function useQsysValue(a: QsysAddress | null): QsysValue {
  const panel = useContext(QsysPanelContext);
  return useSyncExternalStore(panel?.subscribe ?? noSubscribe, () => (panel ? panel.valueSnapshot(a) : UNAVAILABLE));
}

/** The control's catalog and allowlist facts. */
export function useQsysControl(a: QsysAddress | null): QsysControlInfo {
  const panel = useContext(QsysPanelContext);
  return useSyncExternalStore(panel?.subscribe ?? noSubscribe, () => (panel ? panel.controlSnapshot(a) : NO_CONTROL));
}

/** Several controls' states as one; `write`: each must be writable to count as live. */
export function useQsysStates(addresses: (QsysAddress | null)[], write = false): QsysState {
  const panel = useContext(QsysPanelContext);
  return useSyncExternalStore(panel?.subscribe ?? noSubscribe, () => (panel ? panel.combinedState(addresses, write) : "unavailable"));
}

/** One control's state for an object that writes it (see QsysPanel.writeState). */
export function useQsysWriteState(a: QsysAddress | null, numeric = false): QsysState {
  const panel = useContext(QsysPanelContext);
  return useSyncExternalStore(panel?.subscribe ?? noSubscribe, () => (panel ? panel.writeState(a, numeric) : "unavailable"));
}

/** The panel's own state: live, the connection, the break count. */
export function useQsysPanelState(): QsysPanelState {
  const panel = useContext(QsysPanelContext);
  return useSyncExternalStore(panel?.subscribe ?? noSubscribe, () => (panel ? panel.stateSnapshot() : NO_PANEL));
}

const refuseAll = (): Promise<WriteResult> => Promise.resolve(notSent("this object is not on a Q-SYS panel; nothing was sent"));

/**
 * The write function for this panel. Call it only from a pointer gesture: that
 * is the rule that keeps a page from sending its own state back to the Core.
 */
export function useQsysWrite(): (a: QsysAddress, value: number | boolean | string, opts?: { coalesceMs?: number; final?: boolean; lease?: boolean }) => Promise<WriteResult> {
  const panel = useContext(QsysPanelContext);
  return useMemo(() => (panel ? (a, value, opts) => panel.write(a, value, opts) : refuseAll), [panel]);
}
