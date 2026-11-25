// qsys-bindings.ts — the binding check, and the wiring from Views to the watch.
//
// A "panel" is any View whose layout holds Q-SYS objects. Every time the Views
// change, the catalog is read again, or the allowlist is saved, this rebuilds the
// watch's panel list from the views and reruns the check, so a binding that no
// longer resolves is said on /log and answered by GET /api/qsys/bindings rather than found
// out by a volunteer on a Sunday.
//
// An object that WRITES (fader, mute, button, switch, presets, selector, a
// strip's gain and mute) needs its control in the Core's design, on the
// allowlist, and writable: not a read-only control, and not a number with no
// range set. An object that only READS (meter, label, a strip's name and meters,
// every indicator) needs the control to exist.
//
// A config restore needs no rerun here: it writes the files and the process restarts, and
// start() reads them fresh at boot.
//
// The report is logged only when it changes: one `[qsys] binding:` line for each
// problem that was not in the last report.
//
// The same run says, once per range for the life of the process, which control
// ranges a fader or a strip's level is bound to with no measured Q-SYS taper
// (types/qsys-taper.ts): such a fader moves linearly in dB, not as the Core's own
// fader does. /qsys/manage lists them from the same rule.

import { scrub } from "../scrub.js";
import { viewsStore } from "../views-store.js";
import { walkLayoutObjects, type LayoutObject, type View } from "../../types/views.js";
import { addressKey, addressOf, panelKindOf, qsysAddressesOf, slotsOf, type QsysAddress, type QsysSlotRole } from "../../types/qsys.js";
import { rangeText, untaperedRanges } from "../../types/qsys-taper.js";
import { qsysAllowlist, type AllowEntry } from "./qsys-allowlist-store.js";
import { qsysService, type QsysCatalog } from "./qsys-service.js";
import { qsysWatch, type WatchPanel } from "./qsys-watch.js";
import { unwritableReason } from "./qsys-write.js";

export type BindingProblem = "missing-component" | "missing-control" | "not-allowed" | "read-only";

export type BindingReport = { panelId: string; objectId: string; address: QsysAddress; problem: BindingProblem }[];

/** The Q-SYS objects of a view, each with the addresses it reads. Empty for a view with none. */
export function qsysObjectsOf(view: View): LayoutObject[] {
  const out: LayoutObject[] = [];
  walkLayoutObjects(view.layout?.objects ?? [], (o) => {
    if (qsysAddressesOf(o.config).length > 0) out.push(o);
  });
  return out;
}

/** The controls a view's objects WRITE (a fader's level, a mute, a button's
 *  trigger, a strip's gain and mute), each once. Indicators, meters and labels are
 *  only read, so "Add all controls this panel uses" leaves them off the allowlist. */
export function writeAddressesOf(view: View): QsysAddress[] {
  const seen = new Set<string>();
  const out: QsysAddress[] = [];
  for (const o of qsysObjectsOf(view)) {
    for (const { binding, role } of slotsOf(o.config)) {
      if (!binding || role !== "write") continue;
      const a = addressOf(binding);
      const k = addressKey(a);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(a);
    }
  }
  return out;
}

/** The watch's panel list: every view with Q-SYS objects or a Q-SYS panel block,
 *  its addresses once each. A panel's kind picks its meter rate; a view with Q-SYS
 *  objects and no block is a staff panel. A panel with nothing on it yet is listed
 *  too, so its page reads as a panel (an empty one) rather than as no panel. */
export function panelsFromViews(views: View[]): WatchPanel[] {
  const panels: WatchPanel[] = [];
  for (const v of views) {
    const seen = new Set<string>();
    const addresses: QsysAddress[] = [];
    for (const o of qsysObjectsOf(v)) {
      for (const a of qsysAddressesOf(o.config)) {
        const k = addressKey(a);
        if (seen.has(k)) continue;
        seen.add(k);
        addresses.push(a);
      }
    }
    if (addresses.length > 0 || v.qsys) panels.push({ id: v.id, kind: panelKindOf(v), addresses });
  }
  return panels;
}

/** Why a control cannot be written, or null when it can. The writer's own rule
 *  (unwritableReason): a control it would refuse whatever the value is not writable
 *  here either. A number with no range set is reported as read-only too, since it
 *  is, until the allowlist gives it one. */
function writeProblem(entry: AllowEntry | undefined, control: QsysCatalog["components"][number]["controls"][number], viaChoices: boolean): BindingProblem | null {
  if (!entry) return "not-allowed";
  return unwritableReason(control, entry, viaChoices) === null ? null : "read-only";
}

/**
 * Check every binding of every Q-SYS panel against the Core's catalog and the
 * allowlist. Pure: the caller says what the Core has. With no catalog (the Core is
 * not connected) there is nothing to check against, and the report is empty (the
 * route answers 503 then, so an empty report only ever means clean).
 */
export function checkBindings(views: View[], catalog: QsysCatalog | null, allow: Map<string, AllowEntry>): BindingReport {
  if (!catalog) return [];
  const components = new Map(catalog.components.map((c) => [c.name, new Map(c.controls.map((x) => [x.Name, x]))]));
  const report: BindingReport = [];
  for (const view of views) {
    for (const object of qsysObjectsOf(view)) {
      const seen = new Set<string>();
      for (const { binding, role, viaChoices = false } of slotsOf(object.config)) {
        if (!binding) continue;
        // The binding's own address is read or written; its indicator is only ever read.
        const targets: { address: QsysAddress; role: QsysSlotRole; viaChoices: boolean }[] = [{ address: addressOf(binding), role, viaChoices }];
        if (binding.indicator) targets.push({ address: addressOf(binding.indicator), role: "read", viaChoices: false });
        for (const t of targets) {
          const { address } = t;
          const problem = problemOf(components, allow, t);
          if (!problem) continue;
          const key = `${addressKey(address)}\u0000${problem}`;
          if (seen.has(key)) continue;
          seen.add(key);
          report.push({ panelId: view.id, objectId: object.id, address, problem });
        }
      }
    }
  }
  return report;
}

function problemOf(
  components: Map<string, Map<string, QsysCatalog["components"][number]["controls"][number]>>,
  allow: Map<string, AllowEntry>,
  { address, role, viaChoices }: { address: QsysAddress; role: QsysSlotRole; viaChoices: boolean },
): BindingProblem | null {
  const controls = components.get(address.component);
  if (!controls) return "missing-component";
  const control = controls.get(address.control);
  if (!control) return "missing-control";
  return role === "write" ? writeProblem(allow.get(addressKey(address)), control, viaChoices) : null;
}

const lineOf = (r: BindingReport[number]): string =>
  `[qsys] binding: ${r.panelId}/${r.objectId} ${r.problem} (${r.address.component}/${r.address.control})`;

export interface BindingSources {
  getCatalog(): QsysCatalog | null;
  onCatalog(cb: (c: QsysCatalog) => void): void;
  /** Throws while the views file cannot be read, rather than answering the defaults. */
  loadViews(): Promise<View[]>;
  loadAllow(): Promise<AllowEntry[]>;
  onViewsSaved(cb: () => void): void;
  onAllowSaved(cb: () => void): void;
  setPanels(panels: WatchPanel[]): void;
}

/** What GET /api/qsys/bindings answers: the report, or why there is none. */
export type BindingAnswer = { report: BindingReport } | { error: "not-connected" | "check-failed" };

/** Keeps the watch's panels and the binding report current. One per process. */
export class QsysBindings {
  private report: BindingReport = [];
  /** The last run could not read the views or the allowlist (or none has run): there is no report to serve. */
  private failed = true;
  private logged = new Set<string>();
  /** Ranges already said to have no measured taper: one line each, ever. */
  private untapered = new Set<string>();
  /** The catalog the logged lines were said against: a new one (a reconnect, a redeploy) says them again. */
  private loggedFor: QsysCatalog | null = null;
  private running: Promise<void> | null = null;
  private dirty = false;
  private started = false;

  constructor(private readonly src: BindingSources) {}

  /** Subscribe to every change that can alter the answer, and run once now. Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    const again = () => void this.refresh();
    this.src.onCatalog(again);
    this.src.onViewsSaved(again);
    this.src.onAllowSaved(again);
    again();
  }

  /**
   * The last report. Never a report from an earlier connection, and never an
   * empty one standing in for a check that could not run: an empty report means
   * every binding resolves.
   */
  current(): BindingAnswer {
    if (!this.src.getCatalog()) return { error: "not-connected" };
    if (this.failed) return { error: "check-failed" };
    return { report: this.report };
  }

  /** Resolves once any run in flight, and any queued behind it, has finished. Starts nothing and changes nothing. */
  async settled(): Promise<void> {
    while (this.running) await this.running;
  }

  /** Rebuild the watch's panels and rerun the check. One run at a time; a call during a run queues one more. */
  refresh(): Promise<void> {
    this.dirty = true;
    this.running ??= this.drain().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async drain(): Promise<void> {
    while (this.dirty) {
      this.dirty = false;
      try {
        const [views, entries] = await Promise.all([this.src.loadViews(), this.src.loadAllow()]);
        this.src.setPanels(panelsFromViews(views));
        const catalog = this.src.getCatalog();
        this.failed = false;
        // No catalog, nothing to check against, and nothing said.
        if (!catalog) {
          this.report = [];
          continue;
        }
        this.report = checkBindings(views, catalog, new Map(entries.map((e) => [addressKey(e), e])));
        this.say(catalog);
        this.sayUntapered(views, catalog);
      } catch (err) {
        // No report rather than a stale one: the route answers 503 with the reason
        // until a run succeeds. The watch keeps the panels it last had.
        this.failed = true;
        this.report = [];
        console.warn(`[qsys] binding check could not run: ${scrub(err instanceof Error ? err.message : err)}`);
      }
    }
  }

  private sayUntapered(views: View[], catalog: QsysCatalog): void {
    for (const r of untaperedRanges(views, catalog)) {
      const range = rangeText(r);
      if (this.untapered.has(range)) continue;
      this.untapered.add(range);
      const on = r.controls.map((a) => `${a.component}/${a.control}`).join(", ");
      console.log(`[qsys] no measured taper for range ${scrub(range)}; faders on it move linearly in dB, not as the Core's do (${scrub(on)}). See /qsys/manage`);
    }
  }

  private say(catalog: QsysCatalog): void {
    // A new catalog is a new connection or a new design: every problem is said again.
    if (catalog !== this.loggedFor) {
      this.logged = new Set();
      this.loggedFor = catalog;
    }
    const now = new Map(this.report.map((r) => [lineOf(r), r]));
    for (const line of now.keys()) if (!this.logged.has(line)) console.warn(scrub(line));
    if (this.logged.size > 0 && now.size === 0) console.log("[qsys] binding check: every binding resolves");
    this.logged = new Set(now.keys());
  }
}

export const qsysBindings = new QsysBindings({
  getCatalog: () => qsysService.getCatalog(),
  onCatalog: (cb) => qsysService.onCatalog(cb),
  loadViews: () => viewsStore.loadStrict(),
  loadAllow: () => qsysAllowlist.list(),
  onViewsSaved: (cb) => viewsStore.onSaved(() => cb()),
  onAllowSaved: (cb) => qsysAllowlist.onSaved(cb),
  setPanels: (p) => qsysWatch.setPanels(p),
});
