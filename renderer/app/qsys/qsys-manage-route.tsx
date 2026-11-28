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

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "@tanstack/react-router";

import {
  QSYS_KIND_TEXT,
  QSYS_RETURN_DEFAULT_MIN,
  QSYS_RETURN_MAX_MIN,
  addressKey,
  canBeQsysPanel,
  parseQsysPanelBlock,
  findPanelBySlug,
  isQsysPanel,
  isQsysSlug,
  kindOf,
  qsysSlugFromName,
  qsysSlugsOf,
  siblingsOf,
  uniqueQsysSlug,
  type AllowEntry,
  type PanelKind,
  type QsysAddress,
  type QsysPanelBlock,
  type QsysSlugRepair,
} from "@main/types/qsys";
import type { View } from "@main/types/views";
import { walkLayoutObjects } from "@main/types/views";
import { allowEntryFor } from "@main/types/qsys-allow-entry";
import { kindText, untaperedRanges, type TaperCatalog, type UntaperedRange } from "@main/types/qsys-taper";
import { errorMessage } from "@main/services/errors";
import { Button, Callout, Checkbox, DialogContent, DialogDescription, DialogRoot, DialogTitle, Input, NumberInput, Radio, RadioGroup, Switch, confirm } from "../../components/ui";
import { invoke } from "../../lib/api";
import { logReadFailure, logToServer } from "../../lib/client-log";
import { useRead, type ReadState } from "../../lib/use-read";
import { canEditInPlace } from "../../editor/can-edit";
import { QsysCoreBrowser, allowKey } from "../../editor/qsys-core-browser";
import { downloadJson } from "../mic-slots/download";
import { AppLink } from "../app-link";
import { cn } from "../../lib/cn";
import { ConsoleEditor, InPlaceEditFrame } from "../console-route";
import { INTEGRATIONS_ROUTE } from "../legacy-hash";
import { useStageSettings } from "../use-stage-settings";
import { QsysPanelNotFound, QsysPanelSurface } from "./qsys-panel-route";
import { qsysManagePanelPath, qsysPanelPath } from "./qsys-paths";
import { usePinSet } from "./use-pin-set";
import { useQsysStatus, type Status } from "./use-qsys-status";

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

// ── /qsys/manage/<slug> ──────────────────────────────────────────────────────

/** One panel inside the shell, with in-place Edit like any console. */
export function QsysManagePanelRoute() {
  const { slug = "" } = useParams({ strict: false }) as { slug?: string };
  const s = useStageSettings();
  const router = useRouter();
  // Which panel is being edited, not a yes/no: moving to another panel is a param
  // change on this route, and a boolean would open it straight into the editor.
  const [editingFor, setEditingFor] = useState<string | null>(null);
  // An address the panel had before a rename leads to it: the URL is put right.
  const found = s.stageState ? findPanelBySlug(s.stageState.views ?? [], slug) : null;
  const renamedTo = found?.qsys && found.qsys.slug !== slug ? found.qsys.slug : null;
  useEffect(() => {
    if (renamedTo !== null) void router.navigate({ to: qsysManagePanelPath(renamedTo), replace: true });
  }, [router, renamedTo]);
  if (!s.stageState) return null;
  const view = found;
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
  const editable = canEditInPlace(view, "shell");
  return (
    // The panel's status strip (h-10, address and kind) runs along the top. The pill sits inside it, at the
    // right, and the strip leaves that end clear, so it covers none of the strip's text.
    <InPlaceEditFrame editable={editable} onEdit={() => setEditingFor(view.id)} cornerClass="top-2">
      <div className="min-h-0 flex-1">
        <QsysPanelSurface view={view} settingsLink inShell reserveEdit={editable} />
      </div>
    </InPlaceEditFrame>
  );
}

// ── /qsys/manage ─────────────────────────────────────────────────────────────

export function QsysManageRoute() {
  const s = useStageSettings();
  const views = useMemo(() => s.stageState?.views ?? [], [s.stageState?.views]);
  const panels = useMemo(() => views.filter(isQsysPanel), [views]);
  const { status, failed: statusFailed } = useQsysStatus();
  const [allow, allowTook] = useAllowlist();
  const bindings = useBindings(views, allow, status);
  const catalog = useTaperCatalog(status);

  return (
    <div className="flex flex-col gap-6 pb-8">
      <PanelsSection views={views} panels={panels} bindings={bindings} />
      <ConnectionSection status={status} failed={statusFailed} />
      <AllowlistSection allow={allow} took={allowTook} panels={panels} connected={status?.connected === true} catalog={catalog} />
      <BindingsSection bindings={bindings} views={views} />
      <TapersSection views={views} read={catalog} />
      <Section title="Staff PIN" hint="A volunteer panel's way into Stage Utility. It keeps curious taps out; the network is still the real boundary.">
        <PinSection />
      </Section>
      <Section title="Meter rates" hint="Volunteer panels' meters move at the volunteer rate and staff panels' at the staff rate. Both are set on the Q-SYS integration.">
        <AppLink to={INTEGRATIONS_ROUTE} className="text-footnote font-medium text-accent hover:underline" data-qsys-rates>
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

/** The allowlist as read: its entries, why a stored file is refused (absent once a
 *  save has answered, which is valid by then), and its revision. */
type AllowRead = { entries: AllowEntry[]; invalid?: string | null; rev: string };
type AllowState = ReadState<AllowRead>;

/** The allowlist as read, with its revision, and a way to put what a save or a fresh read answered in its place. */
function useAllowlist(): [AllowState, (a: AllowRead) => void] {
  return useRead<AllowRead>("qsys:allowlist", "qsys", "the allowlist for /qsys/manage");
}

/** The binding check, read again whenever the views, the allowlist or the connection change. */
function useBindings(views: View[], allow: AllowState, status: Status | null): Bindings {
  const [bindings, setBindings] = useState<Bindings>({ state: "loading" });
  const connected = status?.connected === true;
  const allowKey = allow.state === "ok" ? JSON.stringify(allow.value.entries) : allow.state;
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

/** What a load did to one view's panel settings, in a sentence. */
function repairText(r: QsysSlugRepair): string {
  if (r.why === "shared") return `"${r.name}" shared /qsys/${r.from} with an earlier panel, so it opens at /qsys/${r.to} now`;
  if (r.why === "not-a-console") return `"${r.name}" had panel settings for /qsys/${r.from} but is not a custom console, so they were kept aside`;
  return `"${r.name}" had panel settings this app cannot read, so they were kept aside`;
}


function PanelsSection({ views, panels, bindings }: { views: View[]; panels: View[]; bindings: Bindings }) {
  const [editing, setEditing] = useState<View | null>(null);
  const [creating, setCreating] = useState(false);
  // Panel blocks the server repaired when it loaded the views (a restored backup with
  // two panels at one address). Read once. A failed read says so: it is not "none".
  const [repairsRead] = useRead<QsysSlugRepair[]>("qsys:panelRepairs", "qsys", "the panel repairs for /qsys/manage");
  const repairs = repairsRead.state === "ok" && Array.isArray(repairsRead.value) ? repairsRead.value : [];
  // Consoles with Q-SYS objects and no panel block: their objects work, as staff
  // panels, but they have no address of their own until they are made one.
  // Not Home: it has its own page, cannot be a panel, and draws no Q-SYS panel.
  const unmade = views.filter((v) => !isQsysPanel(v) && canBeQsysPanel(v) && hasQsysObjects(v));
  const gaps = panels.map((panel) => ({ panel, missing: siblingsOf(panel, views).missing })).filter((g) => g.missing.length > 0);
  const problemsOf = (id: string) => (bindings.state === "ok" ? bindings.problems.filter((p) => p.panelId === id).length : 0);
  return (
    <Section
      title="Panels"
      hint="Each panel opens full screen at its own address, for an iPad's home screen. Open one here to see it with the app around it and edit it in place."
      action={<Button size="small" onClick={() => setCreating(true)}>New panel</Button>}
    >
      {repairsRead.state === "failed" && (
        <Callout tone="warn" data-qsys-repairs-failed>
          Couldn&rsquo;t read whether loading the saved views changed any panel&rsquo;s address; see /log.
        </Callout>
      )}
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
                  <span className="text-fg-muted" data-kind>{QSYS_KIND_TEXT[p.qsys!.kind]}</span>
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
 * could not be a panel, or one this app could not read. Nothing is lost by the
 * load; each can be restored once the view can be a panel (a panel's own settings
 * then go aside in their place, never lost), set up again, or dismissed. Dismiss
 * is the operator's choice, confirmed, and logged with the whole block.
 */
function KeptAside({ views }: { views: View[] }) {
  const [message, setMessage] = useState<string | null>(null);
  const kept = views.flatMap((v) => (Array.isArray(v.qsysInactive) ? v.qsysInactive.map((raw, i) => ({ view: v, raw, i })) : []));
  if (kept.length === 0) return null;
  async function restore(view: View, block: QsysPanelBlock) {
    if (view.qsys) {
      const ok = await confirm({
        title: `Restore ${qsysPanelPath(block.slug)} on "${view.name}"?`,
        message: `"${view.name}" is the panel at ${qsysPanelPath(view.qsys.slug)} now. Its settings are kept aside here in place of these, so they can be restored in turn.`,
        confirmLabel: "Restore",
      });
      if (!ok) return;
    }
    setMessage(null);
    try {
      await invoke("views:setQsys", { id: view.id, qsys: block });
    } catch (err) {
      logToServer("qsys", `restoring kept-aside panel settings on ${view.id} was refused: ${errorMessage(err)}`);
      setMessage(errorMessage(err));
    }
  }
  async function dismiss(view: View, raw: unknown) {
    const ok = await confirm({
      title: `Dismiss these settings on "${view.name}"?`,
      message: "They are forgotten. The server's log keeps a copy of them.",
      confirmLabel: "Dismiss",
      destructive: true,
    });
    if (!ok) return;
    setMessage(null);
    try {
      await invoke("views:dismissQsysInactive", { id: view.id, entry: raw });
    } catch (err) {
      logToServer("qsys", `dismissing kept-aside panel settings on ${view.id} was refused: ${errorMessage(err)}`);
      setMessage(errorMessage(err));
    }
  }
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-line p-3" data-qsys-kept-aside>
      <p className="text-footnote text-fg-muted">Panel settings kept aside when the views were loaded. Nothing reads them as a panel until they are restored.</p>
      {kept.map(({ view, raw, i }) => {
        const parsed = parseQsysPanelBlock(raw);
        const slug = (raw as { slug?: unknown } | null)?.slug;
        return (
          <div key={`${view.id}:${i}`} className="flex flex-wrap items-center justify-between gap-3 text-footnote">
            <span className="text-fg">
              {view.name} <span className="font-mono text-fg-muted">{typeof slug === "string" ? qsysPanelPath(slug) : "(no readable address)"}</span>
            </span>
            <span className="flex flex-wrap items-center gap-2">
              {"block" in parsed && canBeQsysPanel(view) ? (
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
              <Button size="small" variant="transparent" onClick={() => void dismiss(view, raw)} data-qsys-dismiss>
                Dismiss
              </Button>
            </span>
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
      <RadioGroup value={value} onValueChange={(v: string) => onChange(v as PanelKind)} className="flex flex-col gap-1.5">
        {(["volunteer", "staff"] as const).map((k) => (
          <label key={k} className="flex min-h-11 cursor-pointer items-center gap-2 text-footnote text-fg">
            <Radio value={k} aria-label={QSYS_KIND_TEXT[k]} />
            <span>
              {QSYS_KIND_TEXT[k]}
              <span className="text-fg-muted">{k === "volunteer" ? ": big targets, and a cog that opens the app only with the staff PIN" : ": dense, every control"}</span>
            </span>
          </label>
        ))}
      </RadioGroup>
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
  const slug = uniqueQsysSlug(qsysSlugFromName(name || "panel"), qsysSlugsOf(views));
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
  const [slug, setSlug] = useState(was?.slug ?? uniqueQsysSlug(qsysSlugFromName(view.name), qsysSlugsOf(views)));
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
          {shapeOk && was && slug !== was.slug && (
            <span className="text-caption1 font-normal text-fg-muted" data-qsys-old-address>
              <span className="font-mono">{qsysPanelPath(was.slug)}</span> keeps leading here, and other panels&rsquo; cog menus follow the new address.
            </span>
          )}
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
 * the PIN is never shown back. Not PIN-gated itself, by design: the network is the
 * boundary.
 */
function PinSection() {
  const [pinSet, putPinSet] = usePinSet();
  const readFailed = pinSet.state === "failed";
  const set = pinSet.state === "ok" ? pinSet.value.set === true : null;
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "danger"; text: string } | null>(null);

  async function save(next: string | null) {
    setBusy(true);
    setMessage(null);
    try {
      const r = await invoke<{ set: boolean }>("qsys:setPin", { pin: next });
      putPinSet({ set: r.set === true });
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

function ConnectionSection({ status, failed }: { status: Status | null; failed: boolean }) {
  let text: string;
  let tone: "ok" | "warn" | "danger" = "warn";
  if (!status && failed) text = "Couldn't read the Q-SYS connection; see /log.";
  else if (!status) text = "Reading the connection…";
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
        <span className="flex items-center gap-2 text-footnote text-fg" data-qsys-connection={status?.state ?? (failed ? "failed" : "unknown")}>
          <span aria-hidden className={`size-2 shrink-0 rounded-full ${dot}`} />
          {text}
        </span>
        <AppLink to={INTEGRATIONS_ROUTE} className="text-footnote font-medium text-accent hover:underline">
          Q-SYS settings
        </AppLink>
      </div>
    </Section>
  );
}

// ── Allowlist ────────────────────────────────────────────────────────────────

/** One way the stored list differs from the one an edit started from. */
type Change = { key: string; what: "added" | "removed" | "changed"; entry: AllowEntry };

/** What changed between `from` and `to`, by address: added, removed, or with other limits, label or hold. */
function changesBetween(from: readonly AllowEntry[], to: readonly AllowEntry[]): Change[] {
  const before = new Map(from.map((e) => [addressKey(e), e]));
  const now = new Map(to.map((e) => [addressKey(e), e]));
  const out: Change[] = [];
  for (const [key, e] of now) {
    const was = before.get(key);
    if (!was) out.push({ key, what: "added", entry: e });
    else if (JSON.stringify(was) !== JSON.stringify(e)) out.push({ key, what: "changed", entry: e });
  }
  for (const [key, e] of before) if (!now.has(key)) out.push({ key, what: "removed", entry: e });
  return out;
}

const CHANGE_TEXT: Record<Change["what"], string> = { added: "added", removed: "removed", changed: "limits, label or hold changed" };

/** A list's limits, as the review shows them. */
const limitsText = (e: AllowEntry) => (e.min === null ? "no limits" : `${e.min} to ${e.max}`) + (e.confirm === "hold" ? ", hold" : "");

function AllowlistSection({
  allow,
  took,
  panels,
  connected,
  catalog,
}: {
  allow: AllowState;
  took: (a: AllowRead) => void;
  panels: View[];
  connected: boolean;
  /** The Core's controls, to tell which listed ones are not numeric. */
  catalog: Tapers;
}) {
  /** The operator's edits, and the list (and revision) they were made on: a save
   *  names that revision, so it can never land over a list nobody here has seen. */
  const [draft, setDraft] = useState<{ entries: AllowEntry[]; base: AllowRead } | null>(null);
  /** A save the server refused because the list had moved on: what moved. Save
   *  stays off until the operator has reviewed it (ruling: never overwrite unseen). */
  const [conflict, setConflict] = useState<{ changes: Change[] | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const current = allow.state === "ok" ? allow.value : null;
  const saved = current?.entries ?? [];
  const entries = draft?.entries ?? saved;
  const dirty = draft !== null;
  const importInput = useRef<HTMLInputElement>(null);
  /** The listed controls the Core says are not numbers, by what they are: a limit means nothing on them. */
  const nonNumeric = useMemo(() => {
    const m = new Map<string, string>();
    if (catalog.state !== "ok") return m;
    for (const comp of catalog.catalog.components) {
      for (const c of comp.controls) {
        const kind = kindOf(c);
        if (kind !== "number") m.set(allowKey(comp.name, c.Name), kind === "boolean" ? "on-off" : kind);
      }
    }
    return m;
  }, [catalog]);
  const onList = useMemo(() => new Set(entries.map((e) => allowKey(e.component, e.control))), [entries]);

  const editTo = (next: AllowEntry[]) => setDraft({ entries: next, base: draft?.base ?? { entries: saved, rev: current?.rev ?? "" } });
  const edit = (i: number, change: Partial<AllowEntry>) => editTo(entries.map((e, j) => (j === i ? { ...e, ...change } : e)));
  const discard = () => {
    setDraft(null);
    setConflict(null);
  };

  async function saveDraft() {
    if (!draft || conflict) return;
    setBusy(true);
    setMessage(null);
    try {
      // A save replaces the whole list, so it names the revision the edits were made
      // on: the server refuses it (409 rev-changed) if anyone has saved since, in the
      // same step as the save, and nobody's edit is overwritten unseen.
      const r = await invoke<{ entries: AllowEntry[]; rev: string }>("qsys:setAllowlist", { entries: draft.entries, rev: draft.base.rev || undefined });
      took(r);
      setDraft(null);
      setMessage({ tone: "ok", text: "Saved." });
    } catch (err) {
      if ((err as { code?: string }).code === "rev-changed") {
        // Read it again and show what moved beside the edits, which stay. Save waits
        // for the operator to look.
        logToServer("qsys", "an allowlist save was stopped: the list changed since the edits began; the page shows what changed");
        try {
          const fresh = await invoke<AllowRead>("qsys:allowlist");
          took(fresh);
          setConflict({ changes: changesBetween(draft.base.entries, fresh.entries) });
        } catch (readErr) {
          logReadFailure("qsys", "the allowlist for /qsys/manage", readErr);
          setConflict({ changes: null });
        }
        setMessage(null);
        return;
      }
      logToServer("qsys", `the allowlist save was refused: ${errorMessage(err)}`);
      setMessage({ tone: "error", text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  /** The operator has seen what changed: their edits now stand on the list as it is. */
  function reviewed() {
    if (!draft || !current) return;
    setDraft({ entries: draft.entries, base: { entries: current.entries, rev: current.rev } });
    setConflict(null);
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
      discard();
    } catch (err) {
      logToServer("qsys", `replacing the invalid allowlist was refused: ${errorMessage(err)}`);
      setMessage({ tone: "error", text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  /** One control picked from the Core: an unsaved row at the Core's own range, to tighten before saving. */
  function addControl(b: { component: string; control: string } | null, _legend?: string, c?: { ValueMin?: number; ValueMax?: number }) {
    if (!b) return;
    editTo([...entries, allowEntryFor(b.component, { Name: b.control, ...c })]);
    setMessage(null);
  }

  async function exportList() {
    setMessage(null);
    try {
      downloadJson("qsys-allowlist.json", await invoke("qsys:exportAllowlist"));
    } catch (err) {
      logToServer("qsys", `exporting the allowlist failed: ${errorMessage(err)}`);
      setMessage({ tone: "error", text: `Couldn't export the allowlist: ${errorMessage(err)}` });
    }
  }

  async function importFile(file: File) {
    setMessage(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch (err) {
      logToServer("qsys", `an allowlist import was refused: the file is not JSON (${errorMessage(err)})`);
      setMessage({ tone: "error", text: "That file is not JSON, so nothing was imported." });
      return;
    }
    const ok = await confirm({
      title: "Replace the allowlist?",
      message: "The list on this server is replaced by the file's. A control that is not in the file is no longer writable by any panel.",
      confirmLabel: "Replace the list",
    });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await invoke<{ entries: AllowEntry[]; rev: string }>("qsys:importAllowlist", { file: parsed, rev: current?.rev || undefined });
      took(r);
      setMessage({ tone: "ok", text: `Imported ${r.entries.length} control${r.entries.length === 1 ? "" : "s"}.` });
    } catch (err) {
      if ((err as { code?: string }).code === "rev-changed") {
        // The list moved since this page read it: read it again, so a second try names the
        // revision that is stored now instead of 409-ing until a reload.
        logToServer("qsys", "an allowlist import was stopped: the list changed since this page read it; the page shows it as it is now");
        try {
          took(await invoke<AllowRead>("qsys:allowlist"));
          setMessage({ tone: "error", text: "Nothing was imported: the list was changed somewhere else. It is shown as it is now; choose the file again to replace it." });
        } catch (readErr) {
          logReadFailure("qsys", "the allowlist for /qsys/manage", readErr);
          setMessage({ tone: "error", text: "Nothing was imported: the list was changed somewhere else, and it could not be read again. Reload the page." });
        }
        return;
      }
      logToServer("qsys", `an allowlist import was refused: ${errorMessage(err)}`);
      setMessage({ tone: "error", text: `Nothing was imported: ${errorMessage(err)}` });
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
      {current?.invalid && (
        <div className="flex flex-col items-start gap-2">
          <Callout tone="warn">{current.invalid}</Callout>
          <Button size="small" variant="transparent" disabled={busy} onClick={() => void startOver()}>
            Start a new, empty list
          </Button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2" data-qsys-allowlist-actions>
        <div className="w-56" data-qsys-add-control>
          <QsysCoreBrowser kind="any" writable={false} value={null} onChange={addControl} label="Add a control" placeholder="Add a control" clearable={false} disabled={busy || !connected} exclude={onList} />
        </div>
        <Button size="small" variant="transparent" disabled={busy} onClick={() => void exportList()}>
          Export
        </Button>
        <Button size="small" variant="transparent" disabled={busy || dirty} onClick={() => importInput.current?.click()}>
          Import
        </Button>
        <input
          ref={importInput}
          type="file"
          accept="application/json,.json"
          aria-label="Allowlist file to import"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void importFile(file);
          }}
        />
      </div>
      {!connected && <p className="text-caption1 text-fg-muted">Adding a control needs the Core connected: the controls and their ranges come from it.</p>}
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
      {dirty && <p className="text-caption1 text-fg-muted">Save or discard your edits before adding a panel's controls or importing a file.</p>}
      {current && entries.length === 0 && <p className="text-footnote text-fg-muted">Nothing is on the list, so no panel can change anything.</p>}
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
                  {nonNumeric.has(allowKey(e.component, e.control)) ? (
                    <td colSpan={2} className="px-3 py-2 text-footnote text-fg-muted" data-qsys-allow-kind>
                      {nonNumeric.get(allowKey(e.component, e.control))} control, no limits
                    </td>
                  ) : (
                    <>
                      <td className="px-3 py-2">
                        <NumberInput aria-label={`Min for ${e.component} ${e.control}`} value={e.min} onChange={(min) => edit(i, { min })} onUnset={() => edit(i, { min: null })} className="w-36" />
                      </td>
                      <td className="px-3 py-2">
                        <NumberInput aria-label={`Max for ${e.component} ${e.control}`} value={e.max} onChange={(max) => edit(i, { max })} onUnset={() => edit(i, { max: null })} className="w-36" />
                      </td>
                    </>
                  )}
                  <td className="px-3 py-2">
                    <Switch aria-label={`Hold to confirm ${e.component} ${e.control}`} checked={e.confirm === "hold"} onCheckedChange={(on) => edit(i, { confirm: on ? "hold" : "none" })} />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Button size="small" variant="transparent" onClick={() => editTo(entries.filter((_, j) => j !== i))} aria-label={`Remove ${e.component} ${e.control}`}>
                      Remove
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {conflict && (
        <div className="flex flex-col gap-3 rounded-xl border border-warn-9/40 p-3" role="alert" data-qsys-allowlist-conflict>
          <p className="text-footnote text-fg">
            The allowlist was changed somewhere else since you started editing, so nothing was saved. Your edits are above; the list as it is now is here.
          </p>
          {conflict.changes === null ? (
            <p className="text-footnote text-warn-11">Couldn&rsquo;t read the list as it is now; see /log. Discard your edits to start again from it.</p>
          ) : (
            <>
              <ul className="flex flex-col gap-0.5 text-footnote" data-qsys-allowlist-changes>
                {conflict.changes.length === 0 && <li className="text-fg-muted">Nothing in it differs from what your edits started from.</li>}
                {conflict.changes.map((c) => (
                  <li key={`${c.what}:${c.key}`} className="text-fg">
                    <span className="font-mono">{c.entry.component} {c.entry.control}</span> <span className="text-fg-muted">{CHANGE_TEXT[c.what]}</span>
                  </li>
                ))}
              </ul>
              <div className="overflow-x-auto rounded-lg border border-line" data-qsys-allowlist-now>
                <table className="w-full text-caption1">
                  <caption className="px-3 pt-2 text-left text-fg-muted">The list as it is now</caption>
                  <tbody>
                    {saved.map((e) => (
                      <tr key={addressKey(e)} className="border-t border-line">
                        <td className="px-3 py-1.5 font-mono text-fg">
                          {e.component} <span className="text-fg-muted">{e.control}</span>
                        </td>
                        <td className="px-3 py-1.5 font-mono text-fg-muted">{limitsText(e)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          <div className="flex flex-wrap gap-2">
            <Button size="small" onClick={reviewed} disabled={conflict.changes === null} data-qsys-allowlist-reviewed>
              Keep my edits over this list
            </Button>
            <Button size="small" variant="transparent" onClick={discard}>
              Discard my edits
            </Button>
          </div>
        </div>
      )}
      {dirty && (
        <div className="flex gap-2">
          <Button onClick={() => void saveDraft()} disabled={busy || conflict !== null}>Save the allowlist</Button>
          <Button variant="transparent" onClick={discard} disabled={busy}>Discard</Button>
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

// ── Fader tapers ─────────────────────────────────────────────────────────────

type Tapers = { state: "loading" | "offline" } | { state: "failed"; message: string } | { state: "ok"; catalog: TaperCatalog };

/** The Core's catalog, read again on each new one (catalogAt), for the taper list. */
function useTaperCatalog(status: Status | null): Tapers {
  const connected = status?.connected === true;
  const key = connected ? String(status?.catalogAt ?? "") : null;
  const [answer, setAnswer] = useState<{ key: string; read: Tapers } | null>(null);
  useEffect(() => {
    if (key === null) return;
    let live = true;
    invoke<TaperCatalog>("qsys:catalog").then(
      (catalog) => live && setAnswer({ key, read: { state: "ok", catalog } }),
      (err: unknown) => {
        logReadFailure("qsys", "the Core's catalog for the fader tapers on /qsys/manage", err);
        if (live) setAnswer({ key, read: { state: "failed", message: `The Core's controls could not be read: ${errorMessage(err)}` } });
      },
    );
    return () => {
      live = false;
    };
  }, [key]);
  if (key === null) return { state: "offline" };
  return answer?.key === key ? answer.read : { state: "loading" };
}

/**
 * The component types and ranges of faders with no measured Q-SYS taper (main/types/qsys-taper.ts): a fader
 * on one moves linearly in dB, not as the Core's own does. Listed so the range can
 * be measured and added; the server logs each once, from the same rule.
 */
function TapersSection({ views, read }: { views: View[]; read: Tapers }) {
  const ranges: UntaperedRange[] = read.state === "ok" ? untaperedRanges(views, read.catalog) : [];
  return (
    <Section title="Fader tapers" hint="A fader on a kind of component and control range whose Q-SYS taper has been measured sits and moves exactly as the Core's own fader does. Any other moves linearly in dB.">
      <div data-qsys-tapers={read.state}>
        {read.state === "loading" && <p className="text-footnote text-fg-muted">Reading the Core…</p>}
        {read.state === "offline" && <p className="text-footnote text-fg-muted">Connect a Core to check the faders&apos; tapers.</p>}
        {read.state === "failed" && <Callout tone="warn">{read.message}</Callout>}
        {read.state === "ok" && ranges.length === 0 && <p className="text-footnote text-fg-muted">Every fader has a measured taper.</p>}
        {read.state === "ok" && ranges.length > 0 && (
          <ul className="flex flex-col divide-y divide-line rounded-xl border border-line bg-surface">
            {ranges.map((r) => (
              <li key={kindText(r)} data-qsys-untapered={kindText(r)} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 py-2 text-footnote">
                <span className="font-mono font-medium text-fg">{kindText(r)}</span>
                <span className="text-warn-11">No measured taper: moves linearly in dB</span>
                <span className="font-mono text-fg-muted">{r.controls.map((a) => `${a.component} ${a.control}`).join(", ")}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
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

