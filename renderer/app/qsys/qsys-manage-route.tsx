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
  findPanelBySlug,
  isQsysPanel,
  isQsysSlug,
  qsysSlugsOf,
  slugify,
  uniqueQsysSlug,
  type PanelKind,
  type QsysAddress,
  type QsysPanelBlock,
} from "@main/types/qsys";
import type { View } from "@main/types/views";
import { viewSurface, walkLayoutObjects } from "@main/types/views";
import { errorMessage } from "@main/services/errors";
import { Button, Callout, DialogContent, DialogDescription, DialogRoot, DialogTitle, Input, NumberInput, Switch, confirm } from "../../components/ui";
import { invoke, onNotification } from "../../lib/api";
import { logReadFailure, logToServer } from "../../lib/client-log";
import { canEditInPlace } from "../../editor/can-edit";
import { AppLink } from "../app-link";
import { ConsoleEditor, InPlaceEditFrame } from "../console-route";
import { useStageSettings } from "../use-stage-settings";
import { QsysPanelNotFound, QsysPanelSurface } from "./qsys-panel-route";
import { qsysManagePanelPath, qsysPanelPath } from "./qsys-paths";

const INTEGRATIONS_PATH = "/settings/integrations";

type AllowEntry = { component: string; control: string; label: string; min: number | null; max: number | null; confirm: "none" | "hold" };
type Problem = { panelId: string; objectId: string; address: QsysAddress; problem: "missing-component" | "missing-control" | "not-allowed" | "read-only" };
type Status = { connected: boolean; state: "connected" | "reconnecting" | "offline"; designName: string | null; isEmulator: boolean | null; configured?: boolean };

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
  const [allow, allowSaved] = useAllowlist();
  const bindings = useBindings(views, allow, status);

  return (
    <div className="flex flex-col gap-6 pb-8">
      <PanelsSection views={views} panels={panels} bindings={bindings} />
      <ConnectionSection status={status} />
      <AllowlistSection allow={allow} saved={allowSaved} panels={panels} connected={status?.connected === true} />
      <BindingsSection bindings={bindings} views={views} />
      <Section title="Staff PIN" hint="A volunteer panel's way into Stage Utility. It keeps curious taps out; the network is still the real boundary.">
        <p className="text-footnote text-fg-muted" data-qsys-pin>No staff PIN is set.</p>
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

/** The connection, read once and then followed on qsys:status. Null until known. */
function useQsysStatus(): Status | null {
  const [status, setStatus] = useState<Status | null>(null);
  useEffect(() => {
    let live = true;
    invoke<Status>("qsys:status").then(
      (st) => live && setStatus((cur) => cur ?? st),
      (err: unknown) => logReadFailure("qsys", "the Q-SYS connection for /qsys/manage", err),
    );
    const off = onNotification("qsys:status", (p) => live && setStatus(p as Status));
    return () => {
      live = false;
      off();
    };
  }, []);
  return status;
}

type AllowState = { state: "loading" } | { state: "ok"; entries: AllowEntry[]; invalid: string | null } | { state: "failed" };

/** The allowlist as read, and a way to put what a save answered in its place. */
function useAllowlist(): [AllowState, (entries: AllowEntry[]) => void] {
  const [allow, setAllow] = useState<AllowState>({ state: "loading" });
  useEffect(() => {
    let live = true;
    invoke<{ entries: AllowEntry[]; invalid: string | null }>("qsys:allowlist").then(
      (a) => live && setAllow({ state: "ok", entries: a.entries, invalid: a.invalid ?? null }),
      (err: unknown) => {
        logReadFailure("qsys", "the allowlist for /qsys/manage", err);
        if (live) setAllow({ state: "failed" });
      },
    );
    return () => {
      live = false;
    };
  }, []);
  // A save answers with the list it saved, which is valid by then.
  const saved = useCallback((entries: AllowEntry[]) => setAllow({ state: "ok", entries, invalid: null }), []);
  return [allow, saved];
}

/** The binding check, read again whenever the views, the allowlist or the connection change. */
function useBindings(views: View[], allow: AllowState, status: Status | null): Bindings {
  const [bindings, setBindings] = useState<Bindings>({ state: "loading" });
  const connected = status?.connected === true;
  const allowKey = allow.state === "ok" ? JSON.stringify(allow.entries) : allow.state;
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
  }, [views, allowKey, connected]);
  return bindings;
}

// ── Panels ───────────────────────────────────────────────────────────────────

function PanelsSection({ views, panels, bindings }: { views: View[]; panels: View[]; bindings: Bindings }) {
  const [editing, setEditing] = useState<View | null>(null);
  const [creating, setCreating] = useState(false);
  // Consoles with Q-SYS objects and no panel block: their objects work, as staff
  // panels, but they have no address of their own until they are made one.
  const unmade = views.filter((v) => !isQsysPanel(v) && viewSurface(v) === "console" && v.kind === "custom" && hasQsysObjects(v));
  const problemsOf = (id: string) => (bindings.state === "ok" ? bindings.problems.filter((p) => p.panelId === id).length : 0);
  return (
    <Section
      title="Panels"
      hint="Each panel opens full screen at its own address, for an iPad's home screen. Open one here to see it with the app around it and edit it in place."
      action={<Button size="small" onClick={() => setCreating(true)}>New panel</Button>}
    >
      {panels.length === 0 ? (
        <p className="text-footnote text-fg-muted">No panels yet. Make one, then add Q-SYS objects to it in the editor.</p>
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" data-qsys-panels>
          {panels.map((p) => (
            <li key={p.id} className="flex min-h-[120px] flex-col justify-between gap-3 rounded-[14px] border border-line bg-surface p-4" data-qsys-panel-card={p.qsys!.slug}>
              <div className="flex flex-col gap-1">
                <AppLink to={qsysManagePanelPath(p.qsys!.slug)} className="text-callout font-semibold text-fg hover:underline">
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
                <Button size="small" variant="transparent" onClick={() => setEditing(p)} aria-label={`Settings for ${p.name}`}>
                  Settings
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
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
      {editing && <PanelSettingsDialog view={editing} views={views} onClose={() => setEditing(null)} />}
      {creating && <NewPanelDialog views={views} onClose={() => setCreating(false)} />}
    </Section>
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
            <span className="text-fg-muted">{k === "volunteer" ? ": big targets, a cog with no way into settings" : ": dense, every control"}</span>
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
 * A panel's settings: who it is for and its address. Its cog's siblings and its
 * auto-return time are kept as they are: nothing on a panel reads them yet, so
 * they are not offered as if they did something.
 */
export function PanelSettingsDialog({ view, views, onClose }: { view: View; views: View[]; onClose: () => void }) {
  const was = view.qsys;
  const [kind, setKind] = useState<PanelKind>(was?.kind ?? "staff");
  const [slug, setSlug] = useState(was?.slug ?? uniqueQsysSlug(slugify(view.name), qsysSlugsOf(views)));
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
        {message && <p role="alert" className="text-footnote text-danger-11" data-qsys-refused>{message}</p>}
        <div className="flex items-center justify-between gap-2">
          {was ? (
            <Button variant="transparent" onClick={() => void unmake()} disabled={busy}>Make it a console</Button>
          ) : <span />}
          <span className="flex gap-2">
            <Button variant="transparent" onClick={onClose}>Cancel</Button>
            <Button
              onClick={() => void save({ kind, slug, siblings: was?.siblings ?? [], returnAfterMin: was?.returnAfterMin ?? QSYS_RETURN_DEFAULT_MIN })}
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

function AllowlistSection({ allow, saved: onSaved, panels, connected }: { allow: AllowState; saved: (entries: AllowEntry[]) => void; panels: View[]; connected: boolean }) {
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
      const r = await invoke<{ entries: AllowEntry[] }>("qsys:setAllowlist", { entries: draft });
      onSaved(r.entries);
      setDraft(null);
      setMessage({ tone: "ok", text: "Saved." });
    } catch (err) {
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
      const r = await invoke<{ entries: AllowEntry[] }>("qsys:setAllowlist", { entries: [], replaceInvalid: true });
      onSaved(r.entries);
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
      const r = await invoke<{ entries: AllowEntry[]; added: AllowEntry[]; skipped: { component: string; control: string; reason: string }[] }>("qsys:addPanelControls", { panelId: p.id });
      onSaved(r.entries);
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
                    <NumberInput value={e.min} onChange={(min) => edit(i, { min })} onUnset={() => edit(i, { min: null })} className="w-36" />
                  </td>
                  <td className="px-3 py-2">
                    <NumberInput value={e.max} onChange={(max) => edit(i, { max })} onUnset={() => edit(i, { max: null })} className="w-36" />
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

