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

import { scrub } from "../scrub.js";
import { viewsStore } from "../views-store.js";
import type { LayoutObject, LayoutObjectConfig, View } from "../../types/views.js";
import { addressKey, qsysAddressesOf, type QsysAddress, type QsysBinding } from "../../types/qsys.js";
import { qsysAllowlist, type AllowEntry } from "./qsys-allowlist-store.js";
import { qsysService, type QsysCatalog } from "./qsys-service.js";
import { qsysWatch, type WatchPanel } from "./qsys-watch.js";
import { unwritableReason } from "./qsys-write.js";

export type BindingProblem = "missing-component" | "missing-control" | "not-allowed" | "read-only";

export type BindingReport = { panelId: string; objectId: string; address: QsysAddress; problem: BindingProblem }[];

type Role = "write" | "read";
type Slot = { binding: QsysBinding | null | undefined; role: Role };

/** Each binding an object holds, and whether the object writes it. Indicators are always read. */
export function slotsOf(config: LayoutObjectConfig): Slot[] {
  switch (config.type) {
    case "qsys-fader":
    case "qsys-mute":
    case "qsys-button":
      return [{ binding: config.binding, role: "write" }];
    case "qsys-label":
      return [{ binding: config.binding, role: "read" }];
    case "qsys-meter":
      return [
        { binding: config.binding, role: "read" },
        { binding: config.binding2, role: "read" },
      ];
    case "qsys-switch":
      return [config.binding, config.onBinding, config.offBinding].map((binding) => ({ binding, role: "write" }));
    case "qsys-presets":
      return [...config.items.map((i) => i.binding), config.previous].map((binding) => ({ binding, role: "write" }));
    case "qsys-selector":
      return [config.binding, ...config.items.map((i) => i.binding)].map((binding) => ({ binding, role: "write" }));
    case "qsys-strip":
      return [
        { binding: config.name, role: "read" },
        { binding: config.gain, role: "write" },
        { binding: config.mute, role: "write" },
        { binding: config.meter, role: "read" },
        { binding: config.meter2, role: "read" },
      ];
    default:
      return [];
  }
}

/** Every object in a layout, containers' children included. */
function* walk(objects: LayoutObject[]): Generator<LayoutObject> {
  for (const o of objects) {
    yield o;
    if (o.children) yield* walk(o.children);
  }
}

/** The Q-SYS objects of a view, each with the addresses it reads. Empty for a view with none. */
export function qsysObjectsOf(view: View): LayoutObject[] {
  return [...walk(view.layout?.objects ?? [])].filter((o) => qsysAddressesOf(o.config).length > 0);
}

/** The watch's panel list: every view with Q-SYS objects, its addresses once each. */
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
    // A kind of "staff" for now: the View's own Q-SYS settings arrive with the panel shell.
    if (addresses.length > 0) panels.push({ id: v.id, kind: "staff", addresses });
  }
  return panels;
}

/** Why a control cannot be written, or null when it can. The writer's own rule
 *  (unwritableReason): a control it would refuse whatever the value is not writable
 *  here either. A number with no range set is reported as read-only too, since it
 *  is, until the allowlist gives it one. */
function writeProblem(entry: AllowEntry | undefined, control: QsysCatalog["components"][number]["controls"][number]): BindingProblem | null {
  if (!entry) return "not-allowed";
  return unwritableReason(control, entry) === null ? null : "read-only";
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
      for (const { binding, role } of slotsOf(object.config)) {
        if (!binding) continue;
        // The binding's own address is read or written; its indicator is only ever read.
        const targets: { address: QsysAddress; role: Role }[] = [{ address: { component: binding.component, control: binding.control }, role }];
        if (binding.indicator) targets.push({ address: { component: binding.indicator.component, control: binding.indicator.control }, role: "read" });
        for (const { address, role: r } of targets) {
          const problem = problemOf(components, allow, address, r);
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
  address: QsysAddress,
  role: Role,
): BindingProblem | null {
  const controls = components.get(address.component);
  if (!controls) return "missing-component";
  const control = controls.get(address.control);
  if (!control) return "missing-control";
  return role === "write" ? writeProblem(allow.get(addressKey(address)), control) : null;
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

/** Keeps the watch's panels and the binding report current. One per process. */
export class QsysBindings {
  private report: BindingReport = [];
  private logged = new Set<string>();
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

  /** The last report, or null while the Core is not connected (a report from an earlier connection is not served). */
  current(): BindingReport | null {
    return this.src.getCatalog() ? this.report : null;
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
        // No catalog, nothing to check against: drop the old connection's report, so a
        // reconnect says its problems again, and say nothing.
        if (!catalog) {
          this.report = [];
          this.logged = new Set();
          continue;
        }
        this.report = checkBindings(views, catalog, new Map(entries.map((e) => [addressKey(e), e])));
        this.say();
      } catch (err) {
        // A failed read of views or the allowlist leaves the last report standing, and says why.
        console.warn(`[qsys] binding check could not run: ${scrub(err instanceof Error ? err.message : err)}`);
      }
    }
  }

  private say(): void {
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
