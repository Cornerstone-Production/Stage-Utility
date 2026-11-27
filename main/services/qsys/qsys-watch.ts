// qsys-watch.ts — which Core controls are watched, and the change groups that watch them.
//
// Only controls bound on a panel somebody has open are watched. A page names
// `qsys:watch:<viewId>` while it shows that panel; the union of the open panels'
// addresses is split into at most three change groups:
//
//   values            every non-meter control, polled at the faster active rate
//   meters-volunteer  meters only volunteer panels show, at the volunteer rate
//   meters-staff      meters any staff panel shows, at the staff rate
//
// QRC allows four groups per connection; three fixed ids never reach it.
//
// QRC facts this leans on (QSC's QRC Commands reference): `ChangeGroup.Remove`
// takes Named Controls only, so a component control leaves a group by Destroy
// and a re-add of what remains; an add resends the control's current state; and
// groups die with the connection, so after a drop nothing is destroyed, the
// groups are built afresh and Invalidated.
//
// The value cache serves hydration (`current`). It belongs to one connection:
// a new transport, or a new DesignCode on the same one, empties it before
// anything is re-read, so a value from before a drop is never served or
// replayed. `ready()` (write readiness) is false from such a reset until every
// rebuilt group's values, resent by its Invalidate, have arrived and been
// cached; `current()` answers per address. With no group to build (no panel
// open), there is nothing to read back and readiness follows the catalog.
//
// AutoPoll pushes arrive as `ChangeGroup.Poll` notifications, or as repeated
// replies to the AutoPoll request, which QrcClient hands over in the same shape.

import { backoffMs } from "../backoff.js";
import { addSubscriptionListener, broadcast, channelNamedByClient } from "../broadcaster.js";
import { errorMessage } from "../errors.js";
import { scrub } from "../scrub.js";
import { addressKey, isMeterControl, parseAddressKey, type PanelKind, type QsysAddress } from "../../types/qsys.js";
import { QrcError, type QrcTransport } from "./qrc-client.js";
import type { QrcChange } from "./qrc-types.js";
import { qsysService, type QsysCatalog } from "./qsys-service.js";
import type { QsysMeterRates } from "./qsys-settings.js";

export const QSYS_VALUES_CHANNEL = "qsys:values";
export const qsysMeterChannel = (kind: PanelKind): string => `qsys:meters:${kind}`;
/** The channel a page names while it shows panel `viewId`. */
export const watchChannel = (viewId: string): string => `qsys:watch:${viewId}`;

type GroupId = "values" | "meters-volunteer" | "meters-staff";
const GROUP_IDS: readonly GroupId[] = ["values", "meters-volunteer", "meters-staff"];

export interface WatchPanel {
  id: string;
  kind: PanelKind;
  addresses: QsysAddress[];
}

/** What the watch needs from the connection. QsysService satisfies it. */
export interface WatchSource {
  readonly transport: QrcTransport | null;
  readonly meterRates: QsysMeterRates;
  getCatalog(): QsysCatalog | null;
  onCatalog(cb: (c: QsysCatalog) => void): void;
}

// The rule lives in types/qsys.ts so the editor shares it; re-exported for the server.
export { isMeterControl };

interface Group {
  keys: Set<string>;
  /** AutoPoll interval in seconds. */
  rate: number;
}

interface Desired {
  groups: Map<GroupId, Group>;
  /** Which panel kinds show each meter, for routing a push to both meter channels. */
  meterKinds: Map<string, Set<PanelKind>>;
}

const sameChange = (a: QrcChange, b: QrcChange): boolean =>
  a.Value === b.Value && a.String === b.String && a.Position === b.Position;

/** Retry a failed update after 1 s, doubling to this cap. */
const RETRY_FIRST_MS = 1_000;
const RETRY_MAX_MS = 30_000;
/** How long an Invalidate's resent values may take before it is asked again; doubling to the cap. */
export const REREAD_TIMEOUT_MS = 10_000;
const REREAD_MAX_MS = 5 * 60_000;

export class QsysWatch {
  private panels: WatchPanel[] = [];

  /** The connection the groups and the cache below belong to. */
  private transport: QrcTransport | null = null;
  private designCode: string | null = null;
  private readonly groups = new Map<GroupId, Group>();
  private meterKinds = new Map<string, Set<PanelKind>>();
  private readonly cache = new Map<string, QrcChange>();
  /** Set when the connection or the design is new; cleared once the rebuilt
   *  groups have been Invalidated. */
  private rebuilding = true;
  /** What ready() said when last asked by noteReady; listeners hear only a false-to-true turn. */
  private wasReady = false;
  private readonly readyListeners = new Set<() => void>();
  /**
   * Groups Invalidated since the last reset whose resent values have not all
   * arrived: the keys still missing. Write readiness waits for it to empty.
   */
  private readonly rereading = new Map<GroupId, Set<string>>();
  /** Groups that must be Invalidated (again) before writes may resume: one rebuilt
   *  while it was waiting, or one whose values did not come back in time. */
  private readonly toInvalidate = new Set<GroupId>();
  private rereadTimer: ReturnType<typeof setTimeout> | null = null;
  /** Re-asks in a row on this connection; backs the next one off. */
  private rereadAttempts = 0;
  /** A run failed on the live connection, so which groups the Core holds is unknown. */
  private broken = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;

  /** Addresses already logged as missing from this catalog, and those the Core
   *  would not add to a group; neither is asked for again until the catalog changes. */
  private skipped = new Set<string>();
  private refused = new Set<string>();
  private skippedFor: QsysCatalog | null = null;
  private lastSummary = "";

  private running: Promise<void> | null = null;
  private dirty = false;

  constructor(
    private readonly source: WatchSource,
    onSubscriptions: (cb: () => void) => void = addSubscriptionListener,
  ) {
    source.onCatalog(() => this.kick());
    onSubscriptions(() => this.kick());
  }

  /** Every panel that could be open, with the addresses its objects read. */
  setPanels(panels: WatchPanel[]): void {
    this.panels = panels.map((p) => ({ id: p.id, kind: p.kind, addresses: [...p.addresses] }));
    this.kick();
  }

  /**
   * Bring the Core's change groups in line with the open panels. One run at a
   * time; a call during a run queues one more pass, which runs even if the
   * current pass fails. Rejects when the last pass was refused by the Core on the
   * live connection (a retry is already scheduled); a connection that drops
   * mid-run is not a failure, because the reconnect rebuilds from scratch.
   */
  recompute(): Promise<void> {
    this.dirty = true;
    this.running ??= this.drain().finally(() => {
      this.running = null;
      // A call between drain() leaving its loop and this line found the run
      // still going and joined it; nobody would run its pass.
      if (this.dirty) this.kick();
    });
    return this.running;
  }

  /** The addresses panel `id` reads, or null when no registered panel has that id. */
  panelAddresses(id: string): QsysAddress[] | null {
    const p = this.panels.find((x) => x.id === id);
    return p ? [...p.addresses] : null;
  }

  /**
   * The cached values of these addresses, read on the live connection and the
   * current design, keyed by addressKey (so an address listed twice is one
   * entry). An address with no value yet is absent: this is the per-address
   * "have we read it" answer, for hydration.
   */
  current(addresses: QsysAddress[]): Map<string, QrcChange> {
    this.sync();
    const out = new Map<string, QrcChange>();
    if (this.designStale()) return out;
    for (const a of addresses) {
      const k = addressKey(a);
      const v = this.cache.get(k);
      if (v) out.set(k, v);
    }
    return out;
  }

  /**
   * Write readiness, at connection level. False from a connect, a reconnect or a
   * new DesignCode until every rebuilt group's Invalidate has resent its values
   * and they have arrived, so nothing is written before the Core's current state
   * has been read again. Opening a panel or a refused group update on a live
   * connection does not change it.
   */
  ready(): boolean {
    this.sync();
    return !!this.transport && !this.rebuilding && this.toInvalidate.size === 0 && this.rereading.size === 0 && !this.designStale();
  }

  /** The catalog moved to a new design that the groups have not caught up with yet. */
  private designStale(): boolean {
    return this.designCode !== null && this.source.getCatalog()?.designCode !== this.designCode;
  }

  private kick(): void {
    // A refusal is logged, and retried, by scheduleRetry where it is caught.
    this.recompute().catch(() => undefined);
  }

  private async drain(): Promise<void> {
    let failure: unknown = null;
    while (this.dirty) {
      this.dirty = false;
      try {
        await this.reconcile();
        failure = null;
      } catch (err) {
        failure = err;
      }
    }
    if (failure) throw failure;
  }

  /**
   * Call `cb` each time writes become possible again: after a connect, a
   * reconnect or a new design, once every rebuilt group's resent values have
   * arrived (the moment ready() turns true). A release the server owes is sent
   * from here (qsys-write.ts). Returns the function that stops listening.
   */
  onReady(cb: () => void): () => void {
    this.readyListeners.add(cb);
    return () => this.readyListeners.delete(cb);
  }

  private noteReady(): void {
    const r = this.ready();
    if (r === this.wasReady) return;
    this.wasReady = r;
    if (!r) return;
    for (const cb of [...this.readyListeners]) {
      try {
        cb();
      } catch (err) {
        console.error(`[qsys] ready listener failed: ${scrub(errorMessage(err))}`);
      }
    }
  }

  /** Adopt the service's current transport. A different one means the old groups
   *  died with the old connection: forget them, and every value read on it. */
  private sync(): void {
    const t = this.source.transport;
    if (t === this.transport) return;
    this.wasReady = false;
    this.transport = t;
    this.designCode = null;
    this.broken = false;
    this.cancelRetry();
    // A new connection starts its backoff over: a refused first rebuild must
    // not wait out the old connection's 30 s while writes are blocked.
    this.failures = 0;
    this.reset();
    if (t) t.onNotification((method, params) => this.onNotification(t, method, params));
  }

  /** Forget the groups and every value: the connection or the design is new. */
  private reset(): void {
    this.wasReady = false;
    this.groups.clear();
    this.meterKinds = new Map();
    this.cache.clear();
    this.rebuilding = true;
    this.rereading.clear();
    this.toInvalidate.clear();
    this.rereadAttempts = 0;
    this.cancelReread();
  }

  private async reconcile(): Promise<void> {
    this.sync();
    const t = this.transport;
    const catalog = this.source.getCatalog();
    if (!t || !catalog) return;
    try {
      if (this.designStale()) {
        console.log("[qsys] design changed, rebuilding change groups");
        // Same connection, so the groups are still on the Core: remove them.
        // After a failure the Core may hold a group we never recorded (half built).
        for (const id of this.broken ? GROUP_IDS : [...this.groups.keys()]) await this.destroyLeftover(t, id);
        this.reset();
      } else if (this.broken) {
        console.log("[qsys] rebuilding change groups after a failed update");
        // After a failure the Core may hold any of our groups. Same design and
        // connection, so the cached values stay good; the re-adds resend them.
        for (const id of GROUP_IDS) await this.destroyLeftover(t, id);
        this.groups.clear();
        // A group still waiting on its Invalidate is gone with the rest: ask again once rebuilt.
        if (this.rereading.size || this.toInvalidate.size) {
          this.rereading.clear();
          this.toInvalidate.clear();
          this.rebuilding = true;
        }
      }
      this.broken = false;
      this.designCode = catalog.designCode;

      const want = this.desired(catalog);
      this.meterKinds = want.meterKinds;
      for (const id of GROUP_IDS) await this.apply(t, id, want.groups.get(id));
      for (const k of [...this.cache.keys()]) if (!this.watched(k)) this.cache.delete(k);

      if (this.rebuilding) for (const id of this.groups.keys()) this.toInvalidate.add(id);
      this.rebuilding = false;
      // Every group stays in toInvalidate until invalidate() marks it waiting, so
      // one group's values arriving cannot open readiness before the next is asked.
      for (const id of [...this.toInvalidate]) await this.invalidate(t, id);
      this.cancelRetry();
      this.failures = 0;
      this.logSummary();
      this.noteReady();
    } catch (err) {
      // The connection went away under us: the service logs that, and the next
      // connection's catalog rebuilds everything.
      if (this.source.transport !== t) return;
      this.broken = true;
      this.scheduleRetry(err);
      throw err;
    }
  }

  /**
   * Ask the Core to resend a group's values, and wait for them: the group's
   * keys are marked missing BEFORE the send, because the Core can write the
   * push straight after the reply and it may be handled before this resumes.
   * Values that arrived earlier (from the adds) do not count.
   */
  private async invalidate(t: QrcTransport, id: GroupId): Promise<void> {
    const group = this.groups.get(id);
    this.toInvalidate.delete(id);
    if (!group) return;
    this.rereading.set(id, new Set(group.keys));
    this.armReread();
    await t.send("ChangeGroup.Invalidate", { Id: id });
  }

  /**
   * If the resent values have not all arrived in time, say so and Invalidate
   * those groups again. Each re-ask on a connection waits twice as long as the
   * last (10 s to 5 min), so a Core that never answers costs a line per wait,
   * not one every 10 s.
   */
  private armReread(): void {
    if (this.rereadTimer) return;
    const wait = backoffMs(this.rereadAttempts + 1, REREAD_TIMEOUT_MS, REREAD_MAX_MS);
    this.rereadTimer = setTimeout(() => {
      this.rereadTimer = null;
      if (!this.rereading.size || this.source.transport !== this.transport) return;
      this.rereadAttempts++;
      console.warn(`[qsys] the Core has not resent the values of ${scrub([...this.rereading.keys()].join(", "))} ${scrub(wait / 1000)} s after Invalidate; asking again, and writes wait`);
      for (const id of this.rereading.keys()) this.toInvalidate.add(id);
      this.rereading.clear();
      this.kick();
    }, wait);
  }

  private cancelReread(): void {
    if (this.rereadTimer) clearTimeout(this.rereadTimer);
    this.rereadTimer = null;
  }

  /** One retry at a time, 1 s doubling to 30 s; cancelled when the connection changes. */
  private scheduleRetry(err: unknown): void {
    this.cancelRetry();
    const delay = backoffMs(++this.failures, RETRY_FIRST_MS, RETRY_MAX_MS);
    console.warn(`[qsys] change group update failed: ${scrub(errorMessage(err))}; retrying in ${scrub(delay / 1000)} s`);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.kick();
    }, delay);
  }

  private cancelRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  /**
   * Destroy a group that may or may not exist on the Core (after a failed run we
   * cannot know). A refusal from the Core for it means it is already gone, which
   * is what we wanted; a lost connection still throws.
   */
  private async destroyLeftover(t: QrcTransport, id: GroupId): Promise<void> {
    try {
      await t.send("ChangeGroup.Destroy", { Id: id });
    } catch (err) {
      if (!(err instanceof QrcError)) throw err;
      console.log(`[qsys] change group ${scrub(id)} was not on the Core (${scrub(err.message)})`);
    }
  }

  private watched(k: string): boolean {
    for (const g of this.groups.values()) if (g.keys.has(k)) return true;
    return false;
  }

  /** What the groups should hold, from the open panels and the catalog. */
  private desired(catalog: QsysCatalog): Desired {
    if (catalog !== this.skippedFor) {
      this.skippedFor = catalog;
      this.skipped = new Set();
      this.refused = new Set();
    }
    const known = new Map<string, boolean>();
    for (const c of catalog.components) {
      for (const ctl of c.controls) known.set(addressKey({ component: c.name, control: ctl.Name }), isMeterControl(c.type, ctl));
    }
    const values = new Set<string>();
    const meterKinds = new Map<string, Set<PanelKind>>();
    const activeKinds = new Set<PanelKind>();
    for (const p of this.panels) {
      if (!channelNamedByClient(watchChannel(p.id))) continue;
      activeKinds.add(p.kind);
      for (const a of p.addresses) {
        const k = addressKey(a);
        const meter = known.get(k);
        if (this.refused.has(k)) continue;
        if (meter === undefined) {
          if (!this.skipped.has(k)) {
            this.skipped.add(k);
            console.warn(`[qsys] ${scrub(a.component)}/${scrub(a.control)} is on panel ${scrub(p.id)} but not in the Core's design; not watched`);
          }
        } else if (meter) {
          const kinds = meterKinds.get(k) ?? new Set<PanelKind>();
          kinds.add(p.kind);
          meterKinds.set(k, kinds);
        } else values.add(k);
      }
    }
    const { volunteerMeterHz, staffMeterHz } = this.source.meterRates;
    const hz = { volunteer: volunteerMeterHz, staff: staffMeterHz };
    const fastest = Math.max(...[...activeKinds].map((k) => hz[k]));
    const volunteerMeters = new Set<string>();
    const staffMeters = new Set<string>();
    for (const [k, kinds] of meterKinds) (kinds.has("staff") ? staffMeters : volunteerMeters).add(k);
    const groups = new Map<GroupId, Group>();
    if (values.size) groups.set("values", { keys: values, rate: 1 / fastest });
    if (volunteerMeters.size) groups.set("meters-volunteer", { keys: volunteerMeters, rate: 1 / hz.volunteer });
    if (staffMeters.size) groups.set("meters-staff", { keys: staffMeters, rate: 1 / hz.staff });
    return { groups, meterKinds };
  }

  /**
   * Make one group match. Adding only adds. Anything else (a control leaving, a
   * new rate, an empty group) destroys the group and builds it again: Remove
   * cannot take component controls, and a second AutoPoll on a live group is not
   * documented to replace the first.
   */
  private async apply(t: QrcTransport, id: GroupId, want: Group | undefined): Promise<void> {
    const have = this.groups.get(id);
    if (have && want && have.rate === want.rate && [...have.keys].every((k) => want.keys.has(k))) {
      const added = [...want.keys].filter((k) => !have.keys.has(k));
      if (!added.length) return;
      // Membership first: the Core pushes the added controls' state with its reply.
      for (const k of added) have.keys.add(k);
      await this.add(t, id, have, added);
      return;
    }
    // A group still waiting on its Invalidate is rebuilt and asked again after
    // this pass; readiness stays closed meanwhile (toInvalidate).
    if (this.rereading.delete(id)) this.toInvalidate.add(id);
    if (have) {
      this.groups.delete(id);
      await t.send("ChangeGroup.Destroy", { Id: id });
    }
    if (!want) {
      this.toInvalidate.delete(id);
      return;
    }
    const group: Group = { keys: new Set(want.keys), rate: want.rate };
    this.groups.set(id, group);
    await this.add(t, id, group, [...want.keys]);
    if (!group.keys.size) {
      // The Core would add none of it. It may or may not have made the group.
      this.groups.delete(id);
      this.toInvalidate.delete(id);
      await this.destroyLeftover(t, id);
      return;
    }
    const reply = await t.send("ChangeGroup.AutoPoll", { Id: id, Rate: want.rate });
    // QSC's reference shows changes on the AutoPoll reply; take them if present.
    this.ingest(id, reply);
  }

  /**
   * Add `keys` to group `id`, one request per component. A component the Core
   * refuses (a control it lists but will not add) is logged, dropped from the
   * group and not asked for again on this catalog; the rest carry on, so one
   * control cannot keep every write waiting. A lost connection still throws.
   */
  private async add(t: QrcTransport, id: GroupId, group: Group, keys: string[]): Promise<void> {
    const byComponent = new Map<string, string[]>();
    for (const k of keys) {
      const { component } = parseAddressKey(k);
      byComponent.set(component, [...(byComponent.get(component) ?? []), k]);
    }
    for (const [Name, ks] of byComponent) {
      try {
        await t.send("ChangeGroup.AddComponentControl", { Id: id, Component: { Name, Controls: ks.map((k) => ({ Name: parseAddressKey(k).control })) } });
      } catch (err) {
        if (!(err instanceof QrcError)) throw err;
        console.warn(`[qsys] the Core would not watch ${scrub(Name)} (${scrub(ks.map((k) => parseAddressKey(k).control).join(", "))}): ${scrub(err.message)}; not watched`);
        for (const k of ks) {
          group.keys.delete(k);
          this.refused.add(k);
        }
      }
    }
  }

  private onNotification(t: QrcTransport, method: string, params: unknown): void {
    if (method !== "ChangeGroup.Poll" || t !== this.transport) return;
    const id = (params as { Id?: unknown } | null)?.Id;
    if (typeof id !== "string" || !(GROUP_IDS as readonly string[]).includes(id)) return;
    const received = this.ingest(id as GroupId, params);
    const missing = this.rereading.get(id as GroupId);
    if (!missing) return;
    for (const k of received) missing.delete(k);
    if (missing.size) return;
    this.rereading.delete(id as GroupId);
    if (!this.rereading.size) {
      this.cancelReread();
      this.rereadAttempts = 0;
    }
    this.noteReady();
  }

  /** Cache a push and broadcast what actually changed, on the channels of the
   *  panels that show it. Returns the keys it cached. */
  private ingest(id: GroupId, payload: unknown): string[] {
    const changes = (payload as { Changes?: unknown } | null)?.Changes;
    const group = this.groups.get(id);
    const received: string[] = [];
    if (!group || !Array.isArray(changes)) return received;
    const out = new Map<string, QrcChange[]>();
    for (const c of changes as QrcChange[]) {
      if (!c || typeof c.Component !== "string" || typeof c.Name !== "string") continue;
      const k = addressKey({ component: c.Component, control: c.Name });
      if (!group.keys.has(k)) continue;
      const prev = this.cache.get(k);
      this.cache.set(k, c);
      received.push(k);
      if (prev && sameChange(prev, c)) continue;
      const channels =
        id === "values" ? [QSYS_VALUES_CHANNEL] : [...(this.meterKinds.get(k) ?? [])].map(qsysMeterChannel);
      for (const ch of channels) {
        const list = out.get(ch) ?? [];
        list.push(c);
        out.set(ch, list);
      }
    }
    for (const [ch, list] of out) broadcast(ch, { changes: list });
    return received;
  }

  private logSummary(): void {
    const n = (id: GroupId) => this.groups.get(id)?.keys.size ?? 0;
    const summary = `${n("values")} values, ${n("meters-volunteer")} volunteer meters, ${n("meters-staff")} staff meters`;
    if (summary === this.lastSummary) return;
    this.lastSummary = summary;
    console.log(`[qsys] watching ${scrub(summary)}`);
  }
}

export const qsysWatch = new QsysWatch(qsysService);
