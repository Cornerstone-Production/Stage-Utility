// stageplots-edit.tsx — /stageplots/edit: venues, backgrounds, plots and the
// plot editor.
//
// Venues, Backgrounds, This week (the plot the live plan, and any other
// upcoming plan, shows instead of the default) and Publish (the venue on the
// public page behind a secret link) down the left; the selected
// venue's plots as tabs, a toolbar (undo and redo, zoom, background, fade,
// print, which prints the canvas as it stands, unsaved changes included), and
// the work area: the palette, the canvas with its legend under it, and the
// inspector for the selected item. Structural changes (venues, backgrounds, plots, a plot's
// background and fade) save at once and broadcast to every open /stageplots;
// a failed save says so beside the control that made it.
//
// Markup is a draft (editor-state.ts) saved with the version of the plot it
// was loaded at. Nothing reaches /stageplots until Save; Discard puts back
// what the server holds. A save from a version that is no longer current is
// refused (409): the banner says the plot changed elsewhere and offers Reload,
// and nothing is overwritten. When the plot changes while the draft is clean
// the new items are taken; when its items are unchanged (a rename, a fade) only
// the version is. Leaving the page, or switching plot or venue, with unsaved
// changes asks first.

import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type Dispatch, type ReactNode } from "react";
import { ChevronLeftIcon, MaximizeIcon, MinusIcon, PlusIcon, Redo2Icon, Undo2Icon } from "lucide-react";

import { errorMessage } from "@main/services/errors";
import { PLOT_UNITS_WIDE, type BackgroundView, type Plot, type PlotItem, type StagePlotsView, type Venue } from "@main/types/stageplots";

import { LeaveGuard } from "../../components/leave-guard";
import { Button } from "../../components/ui/button";
import { confirm } from "../../components/ui/confirm-dialog";
import { EmptyState } from "../../components/ui/empty-state";
import { ErrorNote } from "../../components/ui/error-note";
import { DialogContent, DialogDescription, DialogFooter, DialogRoot, DialogTitle } from "../../components/ui/dialog";
import { UnsavedBanner } from "../../components/ui/unsaved-banner";
import type { ApiError } from "../../lib/api";
import { cn } from "../../lib/cn";
import type { OpenPdf } from "../../lib/pdf-raster";
import { uid } from "../../lib/uid";
import { useElementSize } from "../../lib/use-element-size";
import { useLatestRef } from "../../lib/use-latest-ref";
import { useResyncOn } from "../../lib/use-resync-on";
import { useRouterHandle } from "../../lib/use-search-param";
import { backgroundOf, plotsOf, selectedPlot } from "../../main/stageplots/doc-helpers";
import { editorReducer, initialEditorState, isDirty, sameItems, type AddKind, type EditorAction, type EditorState } from "../../main/stageplots/editor-state";
import { round1 } from "../../main/stageplots/geometry";
import { PlotLegend } from "../../main/stageplots/plot-legend";
import { PrintControl } from "../../main/stageplots-print";
import { overridesOfPlot, plotHeight } from "@main/services/stageplots-doc";
import { stageplotsApi } from "../../main/stageplots/stageplots-api";
import { usePanZoom } from "../../main/stageplots/use-pan-zoom";
import { useStagePlots } from "../../main/stageplots/use-stageplots";
import { BackgroundsCard } from "./stageplots-backgrounds-card";
import { StagePlotsCanvas } from "./stageplots-canvas";
import { StagePlotsInspector } from "./stageplots-inspector";
import { PALETTE_ICONS_PX, PALETTE_PX, StagePlotsPalette } from "./stageplots-palette";
import { PlotTabs } from "./stageplots-plot-tabs";
import { SaveError, iconButton, type Save } from "./stageplots-shared";
import { useCurrentPlan } from "../../main/stageplots/plan-following";
import { planNamer } from "./plan-date-label";
import { PendingLinksCard, PublishCard } from "./stageplots-publish-card";
import { ThisWeekCard } from "./stageplots-this-week-card";
import { VenuesCard } from "./stageplots-venues-card";

/** The narrowest the canvas may be before the palette gives up its names. */
const MIN_CANVAS_PX = 600;

/** How far each palette add lands from the last, and after how many it starts over. */
const ADD_STAGGER = 20;
const ADD_STAGGER_STEPS = 5;

function PlotEditor({
  doc,
  venue,
  plot,
  save,
  draft,
  dispatch,
  dirty,
  saveDraft,
}: {
  doc: StagePlotsView;
  venue: Venue;
  plot: Plot;
  save: Save;
  draft: EditorState;
  dispatch: Dispatch<EditorAction>;
  dirty: boolean;
  saveDraft: () => Promise<boolean>;
}) {
  const background: BackgroundView | null = backgroundOf(doc, plot);
  const svgRef = useRef<SVGSVGElement>(null);
  const pz = usePanZoom(svgRef, PLOT_UNITS_WIDE, plotHeight(background));
  const [error, setError] = useState<string | null>(null);
  // The slider previews on the plot as it moves and saves when it is let go.
  const [fade, setFade] = useState(plot.bgFade);
  useResyncOn([plot.id, plot.bgFade], () => setFade(plot.bgFade));
  const adds = useRef(0);
  // The palette drops to icons when, with its names, it would leave the canvas
  // under 600 px: the mockup's layout inside the app's own sidebar left about 480
  // px at 1440, and labels crowded. Measured on the canvas column, not the window,
  // and judged as if the palette had its names, so the choice does not flip back
  // the moment it widens the canvas.
  const canvasColumn = useRef<HTMLDivElement>(null);
  const { w: canvasPx } = useElementSize(canvasColumn);
  const [iconPalette, setIconPalette] = useState(false);
  useResyncOn([canvasPx], () => {
    if (canvasPx > 0) setIconPalette(canvasPx - (iconPalette ? PALETTE_PX - PALETTE_ICONS_PX : 0) < MIN_CANVAS_PX);
  });

  const update = async (changes: { backgroundId?: string | null; bgFade?: number }) => {
    const r = await save(() => stageplotsApi.updatePlot(plot.id, changes));
    setError(r.ok ? null : r.error);
    if (!r.ok) setFade(plot.bgFade);
  };
  // Let go, a key up and leaving the slider each commit, so the value last sent
  // is kept: the same fade is sent once, not again before the save lands.
  const [sentFade, setSentFade] = useState(plot.bgFade);
  useResyncOn([plot.id, plot.bgFade], () => setSentFade(plot.bgFade));
  const commitFade = () => {
    const value = Math.round(fade * 100) / 100;
    if (value === sentFade) return;
    setSentFade(value);
    void update({ bgFade: value });
  };

  /**
   * Another background. The server moves items below a shorter plot's edge up
   * onto it, which a draft based on the old items could then never save (400
   * for an item still below, then 409 for the server's own move). So with
   * unsaved changes it asks first: save and switch, discard and switch, or not.
   */
  const [pendingBackground, setPendingBackground] = useState<{ id: string | null } | null>(null);
  const pickBackground = (id: string | null) => {
    if (id === plot.backgroundId) return;
    if (dirty) setPendingBackground({ id });
    else void update({ backgroundId: id });
  };
  const switchAfter = async (how: "save" | "discard") => {
    const target = pendingBackground;
    setPendingBackground(null);
    if (!target) return;
    if (how === "save" && !(await saveDraft())) return;
    if (how === "discard") dispatch({ type: "discard" });
    await update({ backgroundId: target.id });
  };

  /** Add at the middle of what the canvas shows, each add a little further on. */
  const add = (kind: AddKind) => {
    const { x: vx, y: vy, w: vw, h: vh } = pz.view;
    const off = (adds.current++ % ADD_STAGGER_STEPS) * ADD_STAGGER;
    dispatch({ type: "add", kind, at: { x: round1(vx + vw / 2 + off), y: round1(vy + vh / 2 + off) }, id: uid("i") });
    svgRef.current?.focus({ preventScroll: true });
  };

  const selected = draft.items.find((it) => it.id === draft.selectedId) ?? null;
  // The label field suggests what this venue already uses: the draft, then its other plots.
  const labelSources: PlotItem[][] = [draft.items, ...plotsOf(doc, venue).filter((p) => p.id !== plot.id).map((p) => p.items)];

  return (
    <>
      <div role="toolbar" aria-label="Plot tools" className="mb-2.5 flex flex-wrap items-center gap-x-3.5 gap-y-1.5">
        <span className="flex items-center gap-0.5">
          <button
            type="button"
            className={cn(iconButton, "size-7")}
            aria-label="Undo"
            title="Undo"
            data-testid="undo"
            onClick={() => dispatch({ type: "undo" })}
            disabled={draft.undo.length === 0 && !draft.gesture}
          >
            <Undo2Icon className="size-4" />
          </button>
          <button
            type="button"
            className={cn(iconButton, "size-7")}
            aria-label="Redo"
            title="Redo"
            data-testid="redo"
            onClick={() => dispatch({ type: "redo" })}
            disabled={draft.redo.length === 0}
          >
            <Redo2Icon className="size-4" />
          </button>
        </span>
        <span className="flex items-center gap-0.5">
          <button type="button" className={cn(iconButton, "size-7")} aria-label="Zoom out" onClick={pz.zoomOut} disabled={pz.zoom <= 1}>
            <MinusIcon className="size-4" />
          </button>
          <span className="min-w-[46px] text-center font-mono text-caption1 text-fg-soft tabular-nums" data-testid="zoom">
            {Math.round(pz.zoom * 100)}%
          </span>
          <button type="button" className={cn(iconButton, "size-7")} aria-label="Zoom in" onClick={pz.zoomIn}>
            <PlusIcon className="size-4" />
          </button>
          <button type="button" className={cn(iconButton, "size-7")} aria-label="Fit" onClick={pz.fit}>
            <MaximizeIcon className="size-4" />
          </button>
        </span>
        <span className="flex items-center gap-0.5">
          <label htmlFor="stageplots-background" className="mr-1.5 text-caption1 text-fg-muted">
            Background
          </label>
          <select
            id="stageplots-background"
            value={plot.backgroundId ?? ""}
            onChange={(e) => pickBackground(e.target.value || null)}
            className="h-7 max-w-[220px] rounded-md border border-line-strong bg-field px-1.5 text-caption1 text-fg focus:border-focus focus:ring-1 focus:ring-focus focus:outline-none"
          >
            {doc.backgrounds.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
            <option value="">None (grid)</option>
          </select>
        </span>
        <span className="flex items-center gap-0.5">
          <label htmlFor="stageplots-fade" className="mr-1.5 text-caption1 text-fg-muted">
            Fade
          </label>
          <input
            id="stageplots-fade"
            type="range"
            min={0}
            max={100}
            value={Math.round(fade * 100)}
            disabled={!background}
            onChange={(e) => setFade(Number(e.target.value) / 100)}
            onPointerUp={commitFade}
            onKeyUp={commitFade}
            onBlur={commitFade}
            className="w-[110px] accent-[var(--su-accent)] disabled:opacity-45"
          />
          <span className="min-w-[34px] font-mono text-caption1 text-fg-soft tabular-nums">{Math.round(fade * 100)}%</span>
        </span>
        <span className="flex-1" />
        {/* What the canvas shows, saved or not: it goes to paper, not to /stageplots. */}
        <PrintControl
          venueName={venue.name}
          plotName={plot.name}
          planLine={plot.id === venue.defaultPlotId ? "Default plot" : null}
          items={draft.items}
          background={background}
          fade={fade}
        />
      </div>
      <SaveError message={error} className="mb-2" />
      <div
        className={cn(
          "grid items-start gap-3",
          iconPalette ? "grid-cols-[44px_minmax(0,1fr)] xl:grid-cols-[44px_minmax(0,1fr)_280px]" : "grid-cols-[132px_minmax(0,1fr)] xl:grid-cols-[132px_minmax(0,1fr)_280px]",
        )}
      >
        <StagePlotsPalette onAdd={add} icons={iconPalette} />
        <div className="flex min-w-0 flex-col gap-3" ref={canvasColumn}>
          <div className="su-card overflow-hidden p-0">
            <StagePlotsCanvas
              name={plot.name}
              items={draft.items}
              selectedId={draft.selectedId}
              background={background}
              fade={fade}
              pz={pz}
              svgRef={svgRef}
              dispatch={dispatch}
            />
          </div>
          <PlotLegend items={draft.items} emptyHint="Labelled items are listed here." className="su-card px-3.5 py-2.5" />
        </div>
        <div className="col-span-2 xl:col-span-1">
          <StagePlotsInspector item={selected} labelSources={labelSources} dispatch={dispatch} />
        </div>
      </div>
      {venue.notes && <p className="mt-2.5 text-caption1 text-fg-muted">{venue.notes}</p>}
      <DialogRoot open={pendingBackground !== null} onOpenChange={(open) => !open && setPendingBackground(null)}>
          <DialogContent className="max-w-sm" data-testid="background-switch">
            <DialogTitle>Change the background?</DialogTitle>
            <DialogDescription>
              {plot.name} has unsaved changes. Save them or discard them first; a shorter background moves items below its edge up onto
              it.
            </DialogDescription>
            <DialogFooter>
              <Button variant="transparent" size="small" onClick={() => setPendingBackground(null)}>
                Cancel
              </Button>
              <Button variant="filled" size="small" onClick={() => void switchAfter("discard")}>
                Discard and switch
              </Button>
              <Button variant="accent" size="small" onClick={() => void switchAfter("save")}>
                Save and switch
              </Button>
            </DialogFooter>
          </DialogContent>
      </DialogRoot>
    </>
  );
}

/** Undo and redo keys, anywhere on the page but in a field, which keeps its own. */
function useUndoKeys(dispatch: Dispatch<EditorAction>, active: boolean) {
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z") return;
      const t = e.target as HTMLElement | null;
      if (t?.closest?.("input, textarea, select, [contenteditable]")) return;
      e.preventDefault();
      dispatch({ type: e.shiftKey ? "redo" : "undo" });
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [dispatch, active]);
}

export interface StagePlotsEditProps {
  /** How a PDF is opened in the browser; a test hands in its own. */
  openPdf?: (bytes: ArrayBuffer) => Promise<OpenPdf>;
}

export function StagePlotsEdit({ openPdf }: StagePlotsEditProps) {
  const { doc, loading, error, refresh } = useStagePlots();
  const [venueId, setVenueId] = useState<string | null>(null);
  const [plotPick, setPlotPick] = useState<{ venueId: string; plotId: string } | null>(null);
  const [backgroundId, setBackgroundId] = useState<string | null>(null);

  // Every save reads the document again after it, landed or not: a refused
  // change leaves the page showing what the server holds.
  const save: Save = useCallback(
    async (run) => {
      try {
        const value = await run();
        void refresh();
        return { ok: true, value };
      } catch (err) {
        void refresh();
        return { ok: false, error: errorMessage(err) };
      }
    },
    [refresh],
  );

  const header = (
    <div className="pt-1 pb-3">
      <a
        href="/stageplots"
        className="-ml-1 inline-flex items-center gap-0.5 rounded-md px-1 py-0.5 text-caption1 text-fg-muted hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        <ChevronLeftIcon className="size-3.5" />
        Stage plots
      </a>
      <h1 className="mt-0.5 text-title3 font-semibold text-fg">Edit stage plots</h1>
    </div>
  );

  if (!doc) {
    return (
      <div className="pt-5 pb-[50vh] max-sm:pt-4">
        {header}
        {error ? <ErrorNote>Couldn&apos;t load the stage plots.</ErrorNote> : loading ? <p className="text-footnote text-fg-subtle">Loading…</p> : null}
      </div>
    );
  }

  const venue = doc.venues.find((v) => v.id === venueId) ?? doc.venues[0] ?? null;
  const plots = venue ? plotsOf(doc, venue) : [];
  const plot = selectedPlot(venue, plots, plotPick);
  return (
    <EditorBody
      doc={doc}
      venue={venue}
      plots={plots}
      plot={plot}
      header={header}
      error={error}
      save={save}
      refresh={refresh}
      onVenue={setVenueId}
      onPlot={setPlotPick}
      backgroundId={backgroundId}
      onBackground={setBackgroundId}
      openPdf={openPdf}
    />
  );
}

function EditorBody({
  doc,
  venue,
  plots,
  plot,
  header,
  error,
  save,
  refresh,
  onVenue,
  onPlot,
  backgroundId,
  onBackground,
  openPdf,
}: {
  doc: StagePlotsView;
  venue: Venue | null;
  plots: Plot[];
  plot: Plot | null;
  header: ReactNode;
  error: boolean;
  save: Save;
  refresh: () => Promise<void>;
  onVenue: (id: string) => void;
  onPlot: (pick: { venueId: string; plotId: string }) => void;
  backgroundId: string | null;
  onBackground: (id: string | null) => void;
  openPdf?: (bytes: ArrayBuffer) => Promise<OpenPdf>;
}) {
  const height = plotHeight(backgroundOf(doc, plot));
  // The plan and the names plans go by, once, for the This week card and the
  // plot delete confirm alike.
  const plan = useCurrentPlan(doc.overrides);
  const planName = useMemo(() => planNamer(plan.plans, plan.timeZone, doc.overrides), [plan.plans, plan.timeZone, doc.overrides]);
  const [draft, dispatch] = useReducer(editorReducer, null, () => initialEditorState(plot?.items ?? [], height));
  /** The version of the plot the draft was loaded at: what Save sends. */
  const [base, setBase] = useState(plot?.version ?? 0);
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const draftRef = useLatestRef(draft);
  const router = useRouterHandle();
  const dirty = isDirty(draft);
  // The banner pushes the page down when it appears. Shown mid-drag, it would
  // move the canvas under the pointer and the item would jump across the plot,
  // so a gesture that began on a clean draft brings it up when it ends.
  const showBanner = dirty && !(draft.gesture && sameItems(draft.gesture.items, draft.savedItems));

  // Another plot: its items, its version, nothing pending.
  useResyncOn([plot?.id], () => {
    dispatch({ type: "load", items: plot?.items ?? [], height });
    setBase(plot?.version ?? 0);
    setConflict(false);
    setSaveError(null);
  });
  // The same plot, changed (a broadcast or a read after a save), and again when
  // the draft turns clean (Discard, or undo back to the start) so a save from
  // elsewhere that landed meanwhile is taken then rather than left behind.
  useResyncOn([plot, dirty], () => {
    if (!plot) return;
    if (sameItems(plot.items, draft.savedItems)) setBase(plot.version);
    else if (!isDirty(draft)) {
      dispatch({ type: "load", items: plot.items, height });
      setBase(plot.version);
      // Nothing unsaved is left to protect: a "changed elsewhere" banner no longer applies.
      setConflict(false);
    }
    // Otherwise someone else saved over this draft's base: the version stays
    // where it was, and Save is refused with 409 rather than overwriting it.
  });
  useResyncOn([height], () => dispatch({ type: "height", height }));
  useUndoKeys(dispatch, plot !== null);

  const where = venue && plot ? `${venue.name} · ${plot.name}` : "this plot";

  /** Before anything that leaves this plot: true to go on. Unsaved changes ask first, and are dropped on yes. */
  const confirmLeave = useCallback(async (): Promise<boolean> => {
    if (!isDirty(draftRef.current)) return true;
    const ok = await confirm({
      title: "Discard unsaved changes?",
      message: `Your changes to ${where} are not saved. Going on loses them.`,
      confirmLabel: "Discard changes",
      destructive: true,
    });
    if (ok) dispatch({ type: "discard" });
    return ok;
  }, [draftRef, where]);

  /**
   * Save the draft; true when it landed. A 409 reads the plot again first: if
   * its items are still what this draft was based on (a rename, a fade or a
   * background landed before its broadcast did), the save is sent once more on
   * the new version; otherwise the banner says it changed elsewhere.
   */
  const saveDraft = async (): Promise<boolean> => {
    if (!plot) return false;
    const sent = draft.items;
    const based = draft.savedItems;
    setSaving(true);
    const send = async (version: number) => {
      const r = await stageplotsApi.saveItems(plot.id, version, sent);
      dispatch({ type: "saved", sent, items: r.plot.items });
      setBase(r.plot.version);
      setSaveError(null);
    };
    try {
      try {
        await send(base);
      } catch (err) {
        if ((err as ApiError).status !== 409) throw err;
        const fresh = (await stageplotsApi.get()).plots.find((p) => p.id === plot.id);
        if (!fresh || !sameItems(fresh.items, based)) throw err;
        await send(fresh.version);
      }
      return true;
    } catch (err) {
      if ((err as ApiError).status === 409) setConflict(true);
      else setSaveError(errorMessage(err));
      return false;
    } finally {
      setSaving(false);
      void refresh();
    }
  };

  /** After a 409: take what the server holds now, dropping the draft. */
  const reload = async () => {
    if (!plot) return;
    try {
      const fresh = (await stageplotsApi.get()).plots.find((p) => p.id === plot.id);
      if (fresh) {
        dispatch({ type: "load", items: fresh.items, height });
        setBase(fresh.version);
      }
      setConflict(false);
      setSaveError(null);
    } catch (err) {
      setSaveError(errorMessage(err));
    }
    void refresh();
  };

  return (
    <div className="pt-5 pb-[50vh] max-sm:pt-4">
      {header}
      {router && <LeaveGuard dirty={dirty} message={`Your changes to ${where} are not saved. Leaving loses them.`} />}
      {conflict ? (
        <UnsavedBanner
          className="mb-3"
          message={
            <>
              <b className="font-medium text-fg">This plot changed elsewhere.</b> Reload to see it; your changes here are not saved.
            </>
          }
          actions={
            <Button variant="accent" size="small" onClick={() => void reload()}>
              Reload
            </Button>
          }
        />
      ) : (
        showBanner && (
          <UnsavedBanner
            className="mb-3"
            saving={saving}
            message={
              <>
                Unsaved changes to <b className="font-medium text-fg">{where}</b>. Nothing reaches /stageplots until you save.
              </>
            }
            onSave={() => void saveDraft()}
            onDiscard={() => {
              dispatch({ type: "discard" });
              setSaveError(null);
            }}
          />
        )
      )}
      <SaveError message={saveError} className="mb-3" />
      {error && <ErrorNote className="mb-3">Couldn&apos;t refresh the stage plots; showing the last ones read.</ErrorNote>}
      <div className="grid items-start gap-4 lg:grid-cols-[268px_minmax(0,1fr)]">
        <aside className="flex flex-col gap-3">
          <VenuesCard
            doc={doc}
            selected={venue}
            onSelect={(id) => {
              if (id === venue?.id) return;
              void confirmLeave().then((ok) => ok && onVenue(id));
            }}
            save={save}
          />
          <BackgroundsCard doc={doc} selectedId={backgroundId} onSelect={onBackground} save={save} {...(openPdf ? { openPdf } : {})} />
          {venue && <ThisWeekCard doc={doc} venue={venue} plan={plan} nameOf={planName} save={save} />}
          {venue ? (
            <PublishCard venue={venue} pending={doc.pendingRemovals} save={save} timeZone={plan.timeZone} />
          ) : (
            <PendingLinksCard pending={doc.pendingRemovals} save={save} />
          )}
        </aside>
        <div className="min-w-0">
          {!venue ? (
            <EmptyState title="Add a venue to start" hint="A venue is a room you play in or a place you visit. Each holds its plots." />
          ) : (
            <>
              <PlotTabs
                venue={venue}
                plots={plots}
                selected={plot}
                beforeSwitch={confirmLeave}
                plansUsing={(plotId) => overridesOfPlot(doc, plotId).map(planName)}
                onSelect={(plotId) => {
                  if (plotId === plot?.id) return;
                  void confirmLeave().then((ok) => ok && onPlot({ venueId: venue.id, plotId }));
                }}
                save={save}
              />
              {plot ? (
                <PlotEditor
                  key={plot.id}
                  doc={doc}
                  venue={venue}
                  plot={plot}
                  save={save}
                  draft={draft}
                  dispatch={dispatch}
                  dirty={dirty}
                  saveDraft={saveDraft}
                />
              ) : (
                <EmptyState title={`No plots in ${venue.name} yet`} hint="Add one with the + beside the tabs." />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
