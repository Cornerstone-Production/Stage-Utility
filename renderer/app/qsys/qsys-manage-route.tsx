// The operator's Q-SYS page, in the shell: /qsys/manage lists every panel and
// holds what panels depend on, and /qsys/manage/<slug> opens one panel inside the
// shell with in-place Edit, as a console does.
//
// Sections, in the order the approved navigation board (stage-utility-plans
// mockups Nav.dc.html) gives them: the panel cards, then the connection, the
// allowlist with "Add all controls this panel uses", the binding check, the
// staff PIN and the meter rates.
//
// Every read here can fail on its own; each says so where its section is, and
// on /log, rather than leaving a section that looks empty and clean.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "@tanstack/react-router";

import {
  QSYS_RETURN_DEFAULT_MIN,
  QSYS_RETURN_MAX_MIN,
  parseQsysPanelBlock,
  findPanelBySlug,
  isQsysPanel,
  isQsysSlug,
  qsysSlugsOf,
  siblingsOf,
  slugify,
  uniqueQsysSlug,
  type PanelKind,
  type QsysAddress,
  type QsysPanelBlock,
} from "@main/types/qsys";
import type { View } from "@main/types/views";
import { viewSurface, walkLayoutObjects } from "@main/types/views";
import { errorMessage } from "@main/services/errors";
import { Button, Callout, Checkbox, DialogContent, DialogDescription, DialogRoot, DialogTitle, Input, NumberInput, Switch, confirm } from "../../components/ui";
import { invoke } from "../../lib/api";
import { logReadFailure, logToServer } from "../../lib/client-log";
import { canEditInPlace } from "../../editor/can-edit";
import { AppLink } from "../app-link";
import { cn } from "../../lib/cn";
import { ConsoleEditor, InPlaceEditFrame } from "../console-route";
import { useStageSettings } from "../use-stage-settings";
import { HOME_VIEW_ID } from "@main/services/home-view";
import { QsysPanelNotFound, QsysPanelSurface } from "./qsys-panel-route";
import { qsysManagePanelPath, qsysPanelPath } from "./qsys-paths";
import { useQsysStatus, type Status } from "./use-qsys-status";

const INTEGRATIONS_PATH = "/settings/integrations";

type AllowEntry = { component: string; control: string; label: string; min: number | null; max: number | null; confirm: "none" | "hold" };
type Problem = { panelId: string; objectId: string; address: QsysAddress; problem: "missing-component" | "missing-control" | "not-allowed" | "read-only" };

/** What the binding check said: a list; not connected (503 `not-connected`); or could not run (503
 *  `check-failed`, or any other failure), with the sentence to show. */
type Bindings = { state: "loading" } | { state: "ok"; problems: Problem[] } | { state: "offline" } | { state: "failed"; message: string };

const PROBLEM_TEXT: Record<Problem["problem"], string> = {
  "missing-component": "no such component on the Core",
  "missing-control": "no such control on the component",
  "not-allowed": "not on the allowlist, so it cannot be changed",
  "read-only": "read-only, or a number with no limits set",
};

const KIND_TEXT: Record<PanelKind, string> = { volunteer: "Volunteer panel", staff: "Staff panel" };

// ── /qsys/manage/<slug> ──────────────────────────────────────────────────────

/** One panel inside the shell, with in-place Edit like any console. */
export function QsysManagePanelRoute() {
  const { slug = "" } = useParams({ strict: false }) as { slug?: string };
  const s = useStageSettings();
  // Which panel is being edited, not a yes/no: moving to another panel is a param
  // change on this route, and a boolean would open it straight into the editor.
  const [editingFor, setEditingFor] = useState<string | null>(null);
  if (!s.stageState) return null;
  const view = findPanelBySlug(s.stageState.views ?? [], slug);
  if (!view) {
    return (
      <div className="-mx-2 h-full max-sm:-mx-3">
        <QsysPanelNotFound slug={slug} link />
      </div>
    );
  }
  if (editingFor === view.id) {
    return (
      <div className="h-full min-h-0 pt-3">
        <ConsoleEditor key={view.id} view={view} settings={s} onExit={() => setEditingFor(null)} />
      </div>
    );
  }
  return (
    <InPlaceEditFrame editable={canEditInPlace(view, "shell")} onEdit={() => setEditingFor(view.id)}>
      <div className="min-h-0 flex-1">
        <QsysPanelSurface view={view} settingsLink inShell />
      </div>
    </InPlaceEditFrame>
  );
}

// ── /qsys/manage ─────────────────────────────────────────────────────────────

export function QsysManageRoute() {
  const s = useStageSettings();
  const views = useMemo(() => s.stageState?.views ?? [], [s.stageState?.views]);
  const panels = useMemo(() => views.filter(isQsysPanel), [views]);
  const status = useQsysStatus();
  const [allow, allowTook] = useAllowlist();
  const bindings = useBindings(views, allow, status);

  return (
    <div className="flex flex-col gap-6 pb-8">
      <PanelsSection views={views} panels={panels} bindings={bindings} />
      <ConnectionSection status={status} />
      <AllowlistSection allow={allow} took={allowTook} panels={panels} connected={status?.connected === true} />
      <BindingsSection bindings={bindings} views={views} />
      <Section title="Staff PIN" hint="A volunteer panel's way into Stage Utility. It keeps curious taps out; the network is still the real boundary.">
        <PinSection />
      </Section>
      <Section title="Meter rates" hint="Volunteer panels' meters move at the volunteer rate and staff panels' at the staff rate. Both are set on the Q-SYS integration.">
        <AppLink to={INTEGRATIONS_PATH} className="text-footnote font-medium text-accent hover:underline" data-qsys-rates>
          Meter rates on the Q-SYS integration
        </AppLink>
      </Section>
    </div>
  );
}

function Section({ title, hint, children, action }: { title: string; hint?: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-3">
      <div className="flex items-end justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-subheadline font-semibold text-fg">{title}</h2>
          {hint && <p className="max-w-[44rem] text-footnote text-fg-muted">{hint}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

// ── Reads ────────────────────────────────────────────────────────────────────

type AllowRead = { entries: AllowEntry[]; invalid: string | null; rev: string };
type AllowState = { state: "loading" } | ({ state: "ok" } & AllowRead) | { state: "failed" };

/** The allowlist as read, with its revision, and a way to put what a save or a fresh read answered in its place. */
function useAllowlist(): [AllowState, (a: { entries: AllowEntry[]; rev: string; invalid?: string | null }) => void] {
  const [allow, setAllow] = useState<AllowState>({ state: "loading" });
  useEffect(() => {
    let live = true;
    invoke<AllowRead>("qsys:allowlist").then(
      (a) => live && setAllow({ state: "ok", entries: a.entries, invalid: a.invalid ?? null, rev: a.rev }),
      (err: unknown) => {
        logReadFailure("qsys", "the allowlist for /qsys/manage", err);
        if (live) setAllow({ state: "failed" });
      },
    );
    return () => {
      live = false;
    };
  }, []);
  // A save answers with the list it saved (valid by then) and its revision; a read, as it came.
  const took = useCallback((a: { entries: AllowEntry[]; rev: string; invalid?: string | null }) => setAllow({ state: "ok", entries: a.entries, invalid: a.invalid ?? null, rev: a.rev }), []);
  return [allow, took];
}

/** The binding check, read again whenever the views, the allowlist or the connection change. */
function useBindings(views: View[], allow: AllowState, status: Status | null): Bindings {
  const [bindings, setBindings] = useState<Bindings>({ state: "loading" });
  const connected = status?.connected === true;
  const allowKey = allow.state === "ok" ? JSON.stringify(allow.entries) : allow.state;
  // The check reads the views' layouts and panel blocks, nothing else: a stage
  // broadcast that rebuilds the list without changing those reads nothing again.
  const viewsKey = JSON.stringify(views.map((v) => [v.id, v.layoutRev ?? null, v.layout?.objects.length ?? 0, v.qsys?.slug ?? null]));
  useEffect(() => {
    let live = true;
    invoke<Problem[]>("qsys:bindings").then(
      (problems) => live && setBindings({ state: "ok", problems }),
      (err: unknown) => {
        if (!live) return;
        const { status: code, code: why } = err as { status?: number; code?: string };
        // 503 is both "no Core" and "the check could not read the views"; the code says which.
        if (code === 503 && why !== "check-failed") return setBindings({ state: "offline" });
        logReadFailure("qsys", "the binding check for /qsys/manage", err);
        const message = errorMessage(err);
        // The server's check-failed sentence already says the check could not run.
        setBindings({ state: "failed", message: why === "check-failed" ? message.charAt(0).toUpperCase() + message.slice(1) : `The binding check could not run: ${message}` });
      },
    );
    return () => {
      live = false;
    };
  }, [viewsKey, allowKey, connected]);
  return bindings;
}

// ── Panels ───────────────────────────────────────────────────────────────────

type Repair = { viewId: string; name: string; from: string | null; to: string | null; why: "shared" | "not-a-console" | "malformed" };

/** What a load did to one view's panel settings, in a sentence. */
function repairText(r: Repair): string {
  if (r.why === "shared") return `"${r.name}" shared /qsys/${r.from} with an earlier panel, so it opens at /qsys/${r.to} now`;
  if (r.why === "not-a-console") return `"${r.name}" had panel settings for /qsys/${r.from} but is not a custom console, so they were kept aside`;
  return `"${r.name}" had panel settings this app cannot read, so they were kept aside`;
}

/** Panel blocks the server repaired when it loaded the views (a restored backup with
 *  two panels at one address). Read once; empty when there were none. */
function usePanelRepairs(): Repair[] {
  const [repairs, setRepairs] = useState<Repair[]>([]);
  useEffect(() => {
    let live = true;
    invoke<Repair[]>("qsys:panelRepairs").then(
      (r) => live && setRepairs(Array.isArray(r) ? r : []),
      (err: unknown) => logReadFailure("qsys", "the panel repairs for /qsys/manage", err),
    );
    return () => {
      live = false;
    };
  }, []);
  return repairs;
}

function PanelsSection({ views, panels, bindings }: { views: View[]; panels: View[]; bindings: Bindings }) {
  const [editing, setEditing] = useState<View | null>(null);
  const [creating, setCreating] = useState(false);
  const repairs = usePanelRepairs();
  // Consoles with Q-SYS objects and no panel block: their objects work, as staff
  // panels, but they have no address of their own until they are made one.
  // Not Home: it has its own page, cannot be a panel, and draws no Q-SYS panel.
  const unmade = views.filter((v) => v.id !== HOME_VIEW_ID && !isQsysPanel(v) && viewSurface(v) === "console" && v.kind === "custom" && hasQsysObjects(v));
  const gaps = panels.map((panel) => ({ panel, missing: siblingsOf(panel, views).missing })).filter((g) => g.missing.length > 0);
  const problemsOf = (id: string) => (bindings.state === "ok" ? bindings.problems.filter((p) => p.panelId === id).length : 0);
  return (
    <Section
      title="Panels"
      hint="Each panel opens full screen at its own address, for an iPad's home screen. Open one here to see it with the app around it and edit it in place."
      action={<Button size="small" onClick={() => setCreating(true)}>New panel</Button>}
    >
      {repairs.length > 0 && (
        <Callout tone="warn" data-qsys-repairs>
          When the saved views were loaded,{" "}
          {repairs
            .map(repairText)
            .join("; ")}
          . Change an address under the panel's Settings.
        </Callout>
      )}
      {panels.length === 0 ? (
        <p className="text-footnote text-fg-muted">No panels yet. Make one, then add Q-SYS objects to it in the editor.</p>
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" data-qsys-panels>
          {panels.map((p) => (
            <li key={p.id} className="relative flex min-h-[120px] flex-col justify-between gap-3 rounded-[14px] border border-line bg-surface p-4 hover:bg-fill" data-qsys-panel-card={p.qsys!.slug}>
              <div className="flex flex-col gap-1">
                {/* The whole card opens the panel (the link's box covers it); Settings sits above. */}
                <AppLink to={qsysManagePanelPath(p.qsys!.slug)} className="text-callout font-semibold text-fg after:absolute after:inset-0 after:rounded-[14px] after:content-['']">
                  {p.name}
                </AppLink>
                <span className="font-mono text-caption1 text-fg-subtle">{qsysPanelPath(p.qsys!.slug)}</span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-caption1">
                  <span className="text-fg-muted" data-kind>{KIND_TEXT[p.qsys!.kind]}</span>
                  {problemsOf(p.id) > 0 && (
                    <span className="text-warn-11" data-problems>
                      <span className="font-mono">{problemsOf(p.id)}</span> binding {problemsOf(p.id) === 1 ? "problem" : "problems"}
                    </span>
                  )}
                </span>
                <Button size="small" variant="transparent" className="relative z-10" onClick={() => setEditing(p)} aria-label={`Settings for ${p.name}`}>
                  Settings
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <KeptAside views={views} />
      {unmade.length > 0 && (
        <div className="flex flex-col gap-2 rounded-xl border border-line p-3">
          <p className="text-footnote text-fg-muted">These consoles have Q-SYS objects but no panel address. They work as staff panels where they are shown.</p>
          {unmade.map((v) => (
            <div key={v.id} className="flex items-center justify-between gap-3">
              <span className="text-footnote text-fg">{v.name}</span>
              <Button size="small" variant="transparent" onClick={() => setEditing(v)}>
                Make it a panel
              </Button>
            </div>
          ))}
        </div>
      )}
      {gaps.length > 0 && (
        <div className="flex flex-col gap-1 rounded-xl border border-line p-3" data-qsys-missing-siblings>
          <p className="text-footnote text-fg-muted">These panels name others that do not exist, so their cog menus leave them out.</p>
          {gaps.map((g) => (
            <p key={g.panel.id} className="text-footnote text-fg">
              {g.panel.name}: <span className="font-mono">{g.missing.join(", ")}</span>
            </p>
          ))}
        </div>
      )}
      {editing && <PanelSettingsDialog view={editing} views={views} onClose={() => setEditing(null)} />}
      {creating && <NewPanelDialog views={views} onClose={() => setCreating(false)} />}
    </Section>
  );
}

/**
 * Panel settings a load kept aside (View.qsysInactive): a block on a view that
 * could not be a panel, or one this app could not read. Nothing is lost; each can
 * be restored once the view can be a panel, or set up again.
 */
function KeptAside({ views }: { views: View[] }) {
  const [message, setMessage] = useState<string | null>(null);
  const kept = views.flatMap((v) => (Array.isArray(v.qsysInactive) ? v.qsysInactive.map((raw, i) => ({ view: v, raw, i })) : []));
  if (kept.length === 0) return null;
  async function restore(view: View, block: QsysPanelBlock) {
    setMessage(null);
    try {
      await invoke("views:setQsys", { id: view.id, qsys: block });
    } catch (err) {
      logToServer("qsys", `restoring kept-aside panel settings on ${view.id} was refused: ${errorMessage(err)}`);
      setMessage(errorMessage(err));
    }
  }
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-line p-3" data-qsys-kept-aside>
      <p className="text-footnote text-fg-muted">Panel settings kept aside when the views were loaded. Nothing reads them as a panel until they are restored.</p>
      {kept.map(({ view, raw, i }) => {
        const parsed = parseQsysPanelBlock(raw);
        const canBe = view.id !== HOME_VIEW_ID && view.kind === "custom" && viewSurface(view) === "console";
        const slug = (raw as { slug?: unknown } | null)?.slug;
        return (
          <div key={`${view.id}:${i}`} className="flex flex-wrap items-center justify-between gap-3 text-footnote">
            <span className="text-fg">
              {view.name} <span className="font-mono text-fg-muted">{typeof slug === "string" ? qsysPanelPath(slug) : "(no readable address)"}</span>
            </span>
            {"block" in parsed && canBe ? (
              <Button size="small" variant="transparent" onClick={() => void restore(view, parsed.block)}>
                Restore as panel
              </Button>
            ) : (
              <span className="text-fg-muted">
                {"block" in parsed
                  ? "Make it a custom console first, then restore it here."
                  : `These settings cannot be read (${parsed.error}). Make it a panel again under its settings.`}
              </span>
            )}
          </div>
        );
      })}
      {message && <p role="alert" className="text-footnote text-danger-11">{message}</p>}
    </div>
  );
}

function hasQsysObjects(v: View): boolean {
  let found = false;
  walkLayoutObjects(v.layout?.objects ?? [], (o) => {
    if (o.config.type.startsWith("qsys-")) found = true;
  });
  return found;
}

function KindChoice({ value, onChange }: { value: PanelKind; onChange: (k: PanelKind) => void }) {
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1 text-footnote font-medium text-fg">Who uses it</legend>
      {(["volunteer", "staff"] as const).map((k) => (
        <label key={k} className="flex min-h-11 cursor-pointer items-center gap-2 text-footnote text-fg">
          <input type="radio" name="qsys-kind" value={k} checked={value === k} onChange={() => onChange(k)} className="size-4 accent-[var(--su-accent)]" />
          <span>
            {KIND_TEXT[k]}
            <span className="text-fg-muted">{k === "volunteer" ? ": big targets, and a cog that opens the app only with the staff PIN" : ": dense, every control"}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

function NewPanelDialog({ views, onClose }: { views: View[]; onClose: () => void }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<PanelKind>("volunteer");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  /** The slug just made: opened once the page's own state has the view, never before (it would read as no panel). */
  const [made, setMade] = useState<string | null>(null);
  const slug = uniqueQsysSlug(slugify(name || "panel"), qsysSlugsOf(views));
  const arrived = made !== null && views.some((v) => v.qsys?.slug === made);
  useEffect(() => {
    if (!arrived || made === null) return;
    onClose();
    void router.navigate({ to: qsysManagePanelPath(made) });
  }, [arrived, made, onClose, router]);
  async function create() {
    setBusy(true);
    setMessage(null);
    try {
      const block: QsysPanelBlock = { kind, slug, siblings: [], returnAfterMin: QSYS_RETURN_DEFAULT_MIN };
      await invoke("views:add", { name: name.trim() || "Panel", kind: "custom", surface: "console", qsys: block });
      setMade(slug);
    } catch (err) {
      logToServer("qsys", `a new panel was refused: ${errorMessage(err)}`);
      setMessage(errorMessage(err));
      setBusy(false);
    }
  }
  return (
    <DialogRoot open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-[440px]">
        <DialogTitle>New panel</DialogTitle>
        <DialogDescription className="text-footnote text-fg-muted">A blank console with its own address. Add Q-SYS objects to it in the editor.</DialogDescription>
        <label className="flex flex-col gap-1 text-footnote font-medium text-fg">
          Name
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Zone 1" autoFocus />
        </label>
        <p className="text-caption1 text-fg-muted">
          Opens at <span className="font-mono text-fg">{qsysPanelPath(slug)}</span>
        </p>
        <KindChoice value={kind} onChange={setKind} />
        {message && <p role="alert" className="text-footnote text-danger-11">{message}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="transparent" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void create()} disabled={busy}>Make the panel</Button>
        </div>
      </DialogContent>
    </DialogRoot>
  );
}

/**
 * A panel's settings: who it is for, its address, the panels its cog lists, and
 * how long a device whose home it is may be away before it comes back.
 */
export function PanelSettingsDialog({ view, views, onClose }: { view: View; views: View[]; onClose: () => void }) {
  const was = view.qsys;
  const [kind, setKind] = useState<PanelKind>(was?.kind ?? "staff");
  const [slug, setSlug] = useState(was?.slug ?? uniqueQsysSlug(slugify(view.name), qsysSlugsOf(views)));
  // A sibling no panel has is kept as it was: /qsys/manage lists it for somebody to fix.
  const [siblings, setSiblings] = useState<string[]>(was?.siblings ?? []);
  const [returnAfterMin, setReturnAfterMin] = useState(was?.returnAfterMin ?? QSYS_RETURN_DEFAULT_MIN);
  const others = views.filter((v) => v.id !== view.id && isQsysPanel(v));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const shapeOk = isQsysSlug(slug);

  async function save(qsys: QsysPanelBlock | null) {
    setBusy(true);
    setMessage(null);
    try {
      await invoke("views:setQsys", { id: view.id, qsys });
      onClose();
    } catch (err) {
      // The server is the one that knows every slug: a duplicate is refused there, and said here.
      logToServer("qsys", `panel settings for ${view.id} were refused: ${errorMessage(err)}`);
      setMessage(errorMessage(err));
      setBusy(false);
    }
  }

  async function unmake() {
    const ok = await confirm({
      title: `Make "${view.name}" an ordinary console?`,
      message: `It keeps its layout and its objects, but ${qsysPanelPath(slug)} stops opening it and it moves to the consoles in the sidebar.`,
      confirmLabel: "Make it a console",
    });
    if (ok) await save(null);
  }

  return (
    <DialogRoot open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-[480px]">
        <DialogTitle>{view.name}</DialogTitle>
        <DialogDescription className="text-footnote text-fg-muted">Panel settings</DialogDescription>
        <KindChoice value={kind} onChange={setKind} />
        <label className="flex flex-col gap-1 text-footnote font-medium text-fg">
          Address
          <span className="flex items-center gap-1">
            <span className="font-mono text-fg-muted">/qsys/</span>
            <Input value={slug} onChange={(e) => setSlug(e.target.value)} aria-label="Address" className="font-mono" />
          </span>
          {!shapeOk && <span className="text-caption1 font-normal text-warn-11">Lowercase letters, digits and single hyphens, and not "manage".</span>}
        </label>
        <fieldset className="flex flex-col gap-0.5" data-qsys-siblings>
          <legend className="mb-1 text-footnote font-medium text-fg">In its cog menu</legend>
          {others.length === 0 && <p className="text-caption1 text-fg-muted">No other panels yet.</p>}
          {others.map((o) => {
            const s = o.qsys?.slug ?? "";
            return (
              <label key={o.id} className="flex min-h-11 cursor-pointer items-center gap-2 text-footnote text-fg">
                <Checkbox checked={siblings.includes(s)} onCheckedChange={(on) => setSiblings((cur) => (on === true ? [...cur.filter((x) => x !== s), s] : cur.filter((x) => x !== s)))} />
                <span className="grow">{o.name}</span>
                <span className="font-mono text-caption1 text-fg-subtle">{qsysPanelPath(s)}</span>
              </label>
            );
          })}
        </fieldset>
        <label className="flex flex-col gap-1 text-footnote font-medium text-fg">
          Go back here after
          <span className="flex items-center gap-2">
            <NumberInput value={returnAfterMin} onChange={(n) => setReturnAfterMin(Math.max(0, Math.min(QSYS_RETURN_MAX_MIN, Math.round(n))))} min={0} max={QSYS_RETURN_MAX_MIN} className="w-24" aria-label="Minutes before going back" />
            <span className="font-normal text-fg-muted">minutes without a touch, on a device whose home this is. 0 never goes back.</span>
          </span>
        </label>
        {message && <p role="alert" className="text-footnote text-danger-11" data-qsys-refused>{message}</p>}
        <div className="flex items-center justify-between gap-2">
          {was ? (
            <Button variant="transparent" onClick={() => void unmake()} disabled={busy}>Make it a console</Button>
          ) : <span />}
          <span className="flex gap-2">
            <Button variant="transparent" onClick={onClose}>Cancel</Button>
            <Button
              onClick={() => void save({ kind, slug, siblings, returnAfterMin })}
              disabled={busy || !shapeOk}
            >
              Save
            </Button>
          </span>
        </div>
      </DialogContent>
    </DialogRoot>
  );
}

// ── Staff PIN ────────────────────────────────────────────────────────────────

/**
 * Whether a staff PIN is set, and setting, changing or removing it. Four digits,
 * typed as text (a PIN may start with 0). The server keeps only a salted hash, so
 * the PIN is never shown back. Not PIN-gated itself, by Henry's decision: the
 * network is the boundary.
 */
function PinSection() {
  const [set, setSet] = useState<boolean | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "danger"; text: string } | null>(null);

  useEffect(() => {
    let live = true;
    invoke<{ set: boolean }>("qsys:pin").then(
      (r) => live && setSet(r.set === true),
      (err: unknown) => {
        logReadFailure("qsys", "whether a staff PIN is set", err);
        if (live) setReadFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, []);

  async function save(next: string | null) {
    setBusy(true);
    setMessage(null);
    try {
      const r = await invoke<{ set: boolean }>("qsys:setPin", { pin: next });
      setSet(r.set === true);
      setPin("");
      setMessage({ tone: "ok", text: next === null ? "The staff PIN is removed." : "The staff PIN is set." });
    } catch (err) {
      logToServer("qsys", `the staff PIN could not be saved: ${errorMessage(err)}`);
      setMessage({ tone: "danger", text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    const ok = await confirm({
      title: "Remove the staff PIN?",
      message: "Volunteer panels cannot open Stage Utility until a new one is set.",
      confirmLabel: "Remove the PIN",
    });
    if (ok) await save(null);
  }

  const valid = /^\d{4}$/.test(pin);
  let state: string;
  if (readFailed) state = "Couldn't read whether a staff PIN is set; see /log.";
  else if (set === null) state = "Reading…";
  else if (set) state = "A staff PIN is set.";
  else state = "No staff PIN is set. Volunteer panels cannot open Stage Utility until one is.";
  return (
    <div className="flex flex-col gap-2" data-qsys-pin={set === null ? "unknown" : set ? "set" : "none"}>
      <p className="text-footnote text-fg-muted">{state}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="password"
          inputMode="numeric"
          autoComplete="off"
          maxLength={4}
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
          placeholder="4 digits"
          aria-label={set ? "New staff PIN" : "Staff PIN"}
          className="w-32 font-mono"
        />
        <Button onClick={() => void save(pin)} disabled={busy || !valid}>
          {set ? "Change PIN" : "Set PIN"}
        </Button>
        {set && (
          <Button variant="transparent" onClick={() => void remove()} disabled={busy}>
            Remove PIN
          </Button>
        )}
      </div>
      {message && (
        <p role={message.tone === "danger" ? "alert" : "status"} className={cn("text-footnote", message.tone === "danger" ? "text-danger-11" : "text-fg-muted")}>
          {message.text}
        </p>
      )}
    </div>
  );
}

// ── Connection ───────────────────────────────────────────────────────────────

function ConnectionSection({ status }: { status: Status | null }) {
  let text: string;
  let tone: "ok" | "warn" | "danger" = "warn";
  if (!status) text = "Reading the connection…";
  else if (status.configured === false) text = "No Q-SYS Core is set up. Panels stay editable, and their controls are disabled until one is.";
  else if (status.connected) {
    tone = "ok";
    text = `Connected to ${status.designName ?? "the Core"}${status.isEmulator ? " (Emulate)" : ""}`;
  } else if (status.state === "reconnecting") {
    tone = "danger";
    text = "Can't reach the Core. Retrying; every panel shows it is offline.";
  } else text = "Connecting to the Core…";
  const dot = tone === "ok" ? "bg-ok-9" : tone === "danger" ? "bg-danger-9" : "bg-warn-9";
  return (
    <Section title="Connection">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface px-4 py-3">
        <span className="flex items-center gap-2 text-footnote text-fg" data-qsys-connection={status?.state ?? "unknown"}>
          <span aria-hidden className={`size-2 shrink-0 rounded-full ${dot}`} />
          {text}
        </span>
        <AppLink to={INTEGRATIONS_PATH} className="text-footnote font-medium text-accent hover:underline">
          Q-SYS settings
        </AppLink>
      </div>
    </Section>
  );
}

// ── Allowlist ────────────────────────────────────────────────────────────────

function AllowlistSection({
  allow,
  took,
  panels,
  connected,
}: {
  allow: AllowState;
  took: (a: { entries: AllowEntry[]; rev: string; invalid?: string | null }) => void;
  panels: View[];
  connected: boolean;
}) {
  const [draft, setDraft] = useState<AllowEntry[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const saved = allow.state === "ok" ? allow.entries : [];
  const entries = draft ?? saved;
  const dirty = draft !== null;

  const edit = (i: number, change: Partial<AllowEntry>) => setDraft(entries.map((e, j) => (j === i ? { ...e, ...change } : e)));

  async function saveDraft() {
    if (!draft) return;
    setBusy(true);
    setMessage(null);
    try {
      // A save replaces the whole list, so it names the revision this page read: the
      // server refuses it (409 rev-changed) if anyone has saved since, in the same step
      // as the save, and nobody's edit is overwritten unseen.
      const r = await invoke<{ entries: AllowEntry[]; rev: string }>("qsys:setAllowlist", { entries: draft, rev: allow.state === "ok" ? allow.rev : undefined });
      took(r);
      setDraft(null);
      setMessage({ tone: "ok", text: "Saved." });
    } catch (err) {
      if ((err as { code?: string }).code === "rev-changed") {
        // Read it again: the edits stay, and the new list is what Discard shows.
        logToServer("qsys", "an allowlist save was stopped: the list changed since the page read it");
        try {
          took(await invoke<AllowRead>("qsys:allowlist"));
        } catch (readErr) {
          logReadFailure("qsys", "the allowlist for /qsys/manage", readErr);
        }
        setMessage({ tone: "error", text: "The allowlist was changed somewhere else since this page read it, so nothing was saved. Discard to see it, then make your edits again." });
        return;
      }
      logToServer("qsys", `the allowlist save was refused: ${errorMessage(err)}`);
      setMessage({ tone: "error", text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  /** Replace an invalid stored list, deliberately: the file is kept beside it on the server. */
  async function startOver() {
    const ok = await confirm({
      title: "Start a new allowlist?",
      message: "The stored list cannot be read, so nothing is writable now. A new list starts empty; the old file is kept beside it on the server.",
      confirmLabel: "Start a new list",
    });
    if (!ok) return;
    setBusy(true);
    setMessage(null);
    try {
      const r = await invoke<{ entries: AllowEntry[]; rev: string }>("qsys:setAllowlist", { entries: [], replaceInvalid: true });
      took(r);
      setDraft(null);
    } catch (err) {
      logToServer("qsys", `replacing the invalid allowlist was refused: ${errorMessage(err)}`);
      setMessage({ tone: "error", text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  async function addPanel(p: View) {
    setBusy(true);
    setMessage(null);
    try {
      const r = await invoke<{ entries: AllowEntry[]; rev: string; added: AllowEntry[]; skipped: { component: string; control: string; reason: string }[] }>("qsys:addPanelControls", { panelId: p.id });
      took(r);
      const skipped = r.skipped.length > 0 ? ` ${r.skipped.length} not added: ${r.skipped.map((x) => `${x.component} ${x.control} (${x.reason === "read-only" ? "read-only" : "not in the design"})`).join(", ")}.` : "";
      setMessage({ tone: "ok", text: `${r.added.length === 0 ? `Every control "${p.name}" changes was already on the list.` : `Added ${r.added.length} control${r.added.length === 1 ? "" : "s"} "${p.name}" uses, at the Core's own limits.`}${skipped}` });
    } catch (err) {
      logToServer("qsys", `adding a panel's controls to the allowlist was refused: ${errorMessage(err)}`);
      setMessage({ tone: "error", text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      title="Allowlist"
      hint="The only controls any panel may change, each within its limits. A control's limits start at the Core's own range; tighten them here. Hold asks every object on that control to be held to confirm."
    >
      {allow.state === "failed" && <Callout tone="warn">The allowlist could not be read, so it is not shown. See /log.</Callout>}
      {allow.state === "ok" && allow.invalid && (
        <div className="flex flex-col items-start gap-2">
          <Callout tone="warn">{allow.invalid}</Callout>
          <Button size="small" variant="transparent" disabled={busy} onClick={() => void startOver()}>
            Start a new, empty list
          </Button>
        </div>
      )}
      {panels.length > 0 && (
        <div className="flex flex-wrap gap-2" data-qsys-add-panel>
          {panels.map((p) => (
            <Button key={p.id} size="small" variant="transparent" disabled={busy || dirty || !connected} onClick={() => void addPanel(p)}>
              Add all controls {p.name} uses
            </Button>
          ))}
        </div>
      )}
      {panels.length > 0 && !connected && <p className="text-caption1 text-fg-muted">Adding a panel's controls needs the Core connected: their limits come from it.</p>}
      {dirty && <p className="text-caption1 text-fg-muted">Save or discard your edits before adding a panel's controls.</p>}
      {allow.state === "ok" && entries.length === 0 && <p className="text-footnote text-fg-muted">Nothing is on the list, so no panel can change anything.</p>}
      {entries.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-line bg-surface">
          <table className="w-full text-footnote" data-qsys-allowlist>
            <thead className="text-left text-caption1 text-fg-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Control</th>
                <th className="px-3 py-2 font-medium">Min</th>
                <th className="px-3 py-2 font-medium">Max</th>
                <th className="px-3 py-2 font-medium">Hold</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {entries.map((e, i) => (
                <tr key={`${e.component}\u0000${e.control}`} className="border-t border-line">
                  <td className="px-3 py-2 font-mono text-fg">
                    {e.component} <span className="text-fg-muted">{e.control}</span>
                  </td>
                  <td className="px-3 py-2">
                    <NumberInput aria-label={`Min for ${e.component} ${e.control}`} value={e.min} onChange={(min) => edit(i, { min })} onUnset={() => edit(i, { min: null })} className="w-36" />
                  </td>
                  <td className="px-3 py-2">
                    <NumberInput aria-label={`Max for ${e.component} ${e.control}`} value={e.max} onChange={(max) => edit(i, { max })} onUnset={() => edit(i, { max: null })} className="w-36" />
                  </td>
                  <td className="px-3 py-2">
                    <Switch aria-label={`Hold to confirm ${e.component} ${e.control}`} checked={e.confirm === "hold"} onCheckedChange={(on) => edit(i, { confirm: on ? "hold" : "none" })} />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Button size="small" variant="transparent" onClick={() => setDraft(entries.filter((_, j) => j !== i))} aria-label={`Remove ${e.component} ${e.control}`}>
                      Remove
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {dirty && (
        <div className="flex gap-2">
          <Button onClick={() => void saveDraft()} disabled={busy}>Save the allowlist</Button>
          <Button variant="transparent" onClick={() => setDraft(null)} disabled={busy}>Discard</Button>
        </div>
      )}
      {message && (
        <p role={message.tone === "error" ? "alert" : "status"} className={message.tone === "error" ? "text-footnote text-danger-11" : "text-footnote text-fg-muted"}>
          {message.text}
        </p>
      )}
    </Section>
  );
}

// ── Binding check ────────────────────────────────────────────────────────────

function BindingsSection({ bindings, views }: { bindings: Bindings; views: View[] }) {
  const nameOf = (id: string) => views.find((v) => v.id === id)?.name ?? id;
  return (
    <Section title="Binding check" hint="Every Q-SYS object checked against the Core's design and the allowlist. It runs again when a panel, the list or the Core's design changes.">
      <div data-qsys-bindings={bindings.state}>
        {bindings.state === "loading" && <p className="text-footnote text-fg-muted">Checking…</p>}
        {bindings.state === "offline" && <p className="text-footnote text-fg-muted">Connect a Core to check the bindings.</p>}
        {bindings.state === "failed" && <Callout tone="warn">{bindings.message}</Callout>}
        {bindings.state === "ok" && bindings.problems.length === 0 && <p className="text-footnote text-fg-muted">Every binding resolves.</p>}
        {bindings.state === "ok" && bindings.problems.length > 0 && (
          <ul className="flex flex-col divide-y divide-line rounded-xl border border-line bg-surface">
            {bindings.problems.map((p) => (
              <li key={`${p.panelId}/${p.objectId}/${p.address.component}/${p.address.control}/${p.problem}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 py-2 text-footnote">
                <span className="font-medium text-fg">{nameOf(p.panelId)}</span>
                <span className="font-mono text-fg-muted">
                  {p.address.component} {p.address.control}
                </span>
                <span className="text-warn-11">{PROBLEM_TEXT[p.problem]}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Section>
  );
}

