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
// refused (409): the banner says the plot was saved elsewhere and offers Reload,
// and nothing is overwritten. When the plot changes while the draft is clean
// the new items are taken; when its items are unchanged (a rename, a fade) only
// the version is.
//
// The draft is kept on the server a second after each change (use-draft-keeper.ts,
// stageplot-drafts.json), so a reload, a closed tab or another device opens it
// again. Switching plot or venue stores it and goes on; it asks only when the draft
// could not be stored. Leaving the page asks only while the newest change has not
// reached the server.

import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type CSSProperties, type Dispatch, type ReactNode } from "react";
import { ChevronLeftIcon, MaximizeIcon, MinusIcon, PlusIcon, Redo2Icon, Undo2Icon } from "lucide-react";

import { errorMessage } from "@main/services/errors";
import { PLOT_UNITS_WIDE, type BackgroundView, type Plot, type PlotDraft, type PlotItem, type StagePlotsView, type VenueView } from "@main/types/stageplots";

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
import { useInAppLink, useRouterHandle } from "../../lib/use-search-param";
import { PLOT_PARAM, VENUE_PARAM, backgroundOf, plotsOf, selectedPlot } from "../../main/stageplots/doc-helpers";
import { editorReducer, initialEditorState, isDirty, sameItems, type AddKind, type EditorAction, type EditorState } from "../../main/stageplots/editor-state";
import { round1 } from "../../main/stageplots/geometry";
import { PlotLegend } from "../../main/stageplots/plot-legend";
import { PrintControl } from "../../main/stageplots-print";
import { overridesOfPlot, plotHeight } from "@main/services/stageplots-doc";
import { resolveItems, stampLinks, type PatchRead, type ResolvedItems } from "@main/services/stageplots-patch-link";
import { stageplotsApi, type DraftNotice } from "../../main/stageplots/stageplots-api";
import { usePanZoom } from "../../main/stageplots/use-pan-zoom";
import { usePatchContext, useStagePlotsPatch } from "../../main/stageplots/use-patch";
import { useStagePlots } from "../../main/stageplots/use-stageplots";
import { useDraftKeeper } from "../../main/stageplots/use-draft-keeper";
import { usePlotDrafts, type PlotDraftsState } from "../../main/stageplots/use-plot-drafts";
import { formatClock } from "../../lib/clock-format";
import { useSearchParam } from "../../lib/use-search-param";
import { BackgroundsCard } from "./stageplots-backgrounds-card";
import { StagePlotsCanvas, toPlot } from "./stageplots-canvas";
import { StagePlotsInspector } from "./stageplots-inspector";
import { PALETTE_ICONS_PX, PALETTE_PX, StagePlotsPalette } from "./stageplots-palette";
import { PlotTabs } from "./stageplots-plot-tabs";
import { SaveError, iconButton, type Save } from "./stageplots-shared";
import { useCurrentPlan } from "../../main/stageplots/plan-following";
import { planNamer } from "./plan-date-label";
import { PendingLinksCard, PublishCard, whenLabel } from "./stageplots-publish-card";
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
  discard,
  shown,
  patch,
}: {
  doc: StagePlotsView;
  venue: VenueView;
  plot: Plot;
  save: Save;
  draft: EditorState;
  dispatch: Dispatch<EditorAction>;
  dirty: boolean;
  saveDraft: () => Promise<boolean>;
  /** The editor's Discard: the draft, its banner and its error go, and the keeper deletes it on the server. */
  discard: () => void;
  /** The draft as drawn: linked points with their devices' names and colours. */
  shown: ResolvedItems;
  patch: PatchRead | null;
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
    if (how === "discard") discard();
    await update({ backgroundId: target.id });
  };

  /** Add at the middle of what the canvas shows, each add a little further on. */
  const add = (kind: AddKind) => {
    const { x: vx, y: vy, w: vw, h: vh } = pz.view;
    const off = (adds.current++ % ADD_STAGGER_STEPS) * ADD_STAGGER;
    dispatch({ type: "add", kind, at: { x: round1(vx + vw / 2 + off), y: round1(vy + vh / 2 + off) }, id: uid("i") });
    svgRef.current?.focus({ preventScroll: true });
  };

  /** A palette item let go at a screen point: added there, centred on it, when the point is on the plot. */
  const drop = (kind: AddKind, at: { x: number; y: number }) => {
    const svg = svgRef.current;
    const r = svg?.getBoundingClientRect();
    if (!svg || !r || at.x < r.left || at.x > r.right || at.y < r.top || at.y > r.bottom) return;
    const p = toPlot(svg, at.x, at.y);
    if (!p) return;
    dispatch({ type: "add", kind, at: { x: round1(p.x), y: round1(p.y) }, id: uid("i") });
    svg.focus({ preventScroll: true });
  };

  const selected = shown.items.find((it) => it.id === draft.selectedId) ?? null;
  // The label field suggests what this venue already uses: the draft, then its other plots.
  const labelSources: PlotItem[][] = [shown.items, ...plotsOf(doc, venue).filter((p) => p.id !== plot.id).map((p) => p.items)];

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
          items={shown.items}
          background={background}
          fade={fade}
        />
      </div>
      <SaveError message={error} className="mb-2" />
      <div
        className="grid grid-cols-[var(--palette)_minmax(0,1fr)] items-start gap-3 xl:grid-cols-[var(--palette)_minmax(0,1fr)_280px]"
        style={{ "--palette": `${iconPalette ? PALETTE_ICONS_PX : PALETTE_PX}px` } as CSSProperties}
      >
        <StagePlotsPalette onAdd={add} onDrop={drop} icons={iconPalette} />
        <div className="flex min-w-0 flex-col gap-3" ref={canvasColumn}>
          <div className="su-card overflow-hidden p-0">
            <StagePlotsCanvas
              name={plot.name}
              items={shown.items}
              selectedId={draft.selectedId}
              background={background}
              fade={fade}
              pz={pz}
              svgRef={svgRef}
              dispatch={dispatch}
              canUndo={draft.undo.length > 0 || !!draft.gesture}
              canRedo={draft.redo.length > 0}
            />
          </div>
          <PlotLegend items={shown.items} emptyHint="Labelled items are listed here." className="su-card px-3.5 py-2.5" />
        </div>
        <div className="col-span-2 xl:col-span-1">
          <StagePlotsInspector
            item={selected}
            labelSources={labelSources}
            dispatch={dispatch}
            link={selected ? shown.links.get(selected.id) : undefined}
            patch={patch}
          />
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

/** The unsaved banner's dot: amber while unsaved, red when the draft could not be kept. */
function BannerDot({ tone }: { tone: "warn" | "danger" }) {
  return <span aria-hidden className={cn("size-2 shrink-0 rounded-full", tone === "danger" ? "bg-danger-11" : "bg-warn-11")} />;
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
  const { doc, error, refresh } = useStagePlots();
  const drafts = usePlotDrafts();
  // `/stageplots/edit?venue=<id>&plot=<id>` opens on that venue and plot; a pick in the page wins after.
  const [asked] = useSearchParam(VENUE_PARAM);
  const [askedPlot] = useSearchParam(PLOT_PARAM);
  const goInApp = useInAppLink();
  const [venueId, setVenueId] = useState<string | null>(null);
  const [plotPick, setPlotPick] = useState<{ venueId: string; plotId: string } | null>(null);
  const [backgroundId, setBackgroundId] = useState<string | null>(null);
  /** What the drafts file could not do after the last save that touched a draft, or null. The save itself landed. */
  const [draftNote, setDraftNote] = useState<string | null>(null);

  // Every save reads the document again after it, landed or not: a refused
  // change leaves the page showing what the server holds. One that landed says
  // what the drafts could not do after it (a rename, a delete), or clears that.
  const save: Save = useCallback(
    async (run) => {
      try {
        const value = await run();
        setDraftNote(draftNoticeOf(value));
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
        href="/stageplots/manage"
        // In the app, not a page load: a full load fetched the whole app again
        // and every status read, and opened the remembered venue rather than the list.
        onClick={(e) => goInApp(e, { to: "/stageplots/manage", search: {}, state: { list: true } })}
        className="-ml-1 inline-flex items-center gap-0.5 rounded-md px-1 py-0.5 text-caption1 text-fg-muted hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        <ChevronLeftIcon className="size-3.5" />
        Stage plots
      </a>
      <h1 className="mt-0.5 text-title3 font-semibold text-fg">Edit stage plots</h1>
    </div>
  );

  // Held until the drafts are read as well: a draft this page has not seen must never be
  // stored over, so a failed read stops here rather than reading as none.
  if (!doc || !drafts.drafts) {
    const failed = (error && !doc) || drafts.error;
    return (
      <div className="pt-5 pb-[50vh] max-sm:pt-4">
        {header}
        {failed ? (
          <ErrorNote>
            {error && !doc ? "Couldn't load the stage plots." : "Couldn't read the unsaved drafts, so the editor waits rather than store over one. Reload to try again."}
          </ErrorNote>
        ) : (
          <p className="text-footnote text-fg-subtle">Loading…</p>
        )}
      </div>
    );
  }

  const venue = doc.venues.find((v) => v.id === venueId) ?? doc.venues.find((v) => v.id === asked) ?? doc.venues[0] ?? null;
  const plots = venue ? plotsOf(doc, venue) : [];
  const plot = selectedPlot(venue, plots, plotPick ?? (venue && askedPlot ? { venueId: venue.id, plotId: askedPlot } : null));
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
      drafts={drafts}
      keptDrafts={drafts.drafts}
      draftNote={draftNote}
      onDraftNote={setDraftNote}
    />
  );
}

/** A save's `draftNotice` (stageplots-api.ts), or null. */
function draftNoticeOf(value: unknown): string | null {
  const notice = typeof value === "object" && value !== null ? (value as DraftNotice).draftNotice : undefined;
  return typeof notice === "string" ? notice : null;
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
  drafts,
  keptDrafts,
  draftNote,
  onDraftNote,
}: {
  doc: StagePlotsView;
  venue: VenueView | null;
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
  drafts: PlotDraftsState;
  /** Every kept draft by plot, read before the editor was drawn. */
  keptDrafts: ReadonlyMap<string, PlotDraft>;
  /** What the drafts file could not do after the last save that landed; shown beside the banner. */
  draftNote: string | null;
  onDraftNote: (note: string | null) => void;
}) {
  const height = plotHeight(backgroundOf(doc, plot));
  // The plan and the names plans go by, once, for the This week card and the
  // plot delete confirm alike.
  const plan = useCurrentPlan(doc.overrides);
  const planName = useMemo(() => planNamer(plan.plans, plan.timeZone, doc.overrides), [plan.plans, plan.timeZone, doc.overrides]);
  const [draft, dispatch] = useReducer(editorReducer, null, () => initialEditorState(plot?.items ?? [], height));
  // Linked connection points follow their patch devices as drawn, saved or not; Save stores what they showed.
  const patch = useStagePlotsPatch();
  const patchContext = usePatchContext(plan.planId);
  const shown = useMemo(() => resolveItems(draft.items, patch, patchContext), [draft.items, patch, patchContext]);
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
  const keeper = useDraftKeeper({ plotId: plot?.id ?? null, items: draft.items, dirty, baseVersion: base, onKept: drafts.kept, onDropped: drafts.dropped, onWriting: drafts.writing });
  /** The kept draft this plot opened with, while nothing has changed since: the banner says when it is from. */
  const [restored, setRestored] = useState<{ plotId: string; savedAt: string } | null>(null);
  /** The plot the draft was loaded for: the render that picks another still holds the one before. */
  const [loadedFor, setLoadedFor] = useState(plot?.id ?? null);

  // Another plot: its items, its version, nothing pending; or its kept draft over them. A draft
  // drawn on an older version than the plot's (its items changed since: a rename or a fade
  // carries the draft along) opens as saved elsewhere, and Reload drops it.
  useResyncOn([plot?.id], () => {
    const kept = plot ? (keptDrafts.get(plot.id) ?? null) : null;
    dispatch({ type: "load", items: plot?.items ?? [], height });
    if (kept) dispatch({ type: "restore", items: kept.items });
    setBase(kept ? kept.baseVersion : (plot?.version ?? 0));
    setConflict(!!kept && !!plot && kept.baseVersion !== plot.version && !sameItems(kept.items, plot.items));
    setRestored(kept ? { plotId: kept.plotId, savedAt: kept.savedAt } : null);
    setSaveError(null);
    setLoadedFor(plot?.id ?? null);
    keeper.reset(kept);
  });
  // The same plot, changed (a broadcast or a read after a save), and again when
  // the draft turns clean (Discard, or undo back to the start) so a save from
  // elsewhere that landed meanwhile is taken then rather than left behind.
  useResyncOn([plot, dirty], () => {
    // Another plot: the resync above loads it, and this render's draft is still the last
    // plot's, whose saved items would load over the kept draft just restored and drop it.
    if (!plot || plot.id !== loadedFor) return;
    // Saved elsewhere over this draft's base: its base stays, so Save stays refused. A kept
    // draft opened that way holds the plot's newer items as "saved" ones, which are not its base.
    if (conflict && isDirty(draft)) return;
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

  const drafted = useMemo(() => new Set(keptDrafts.keys()), [keptDrafts]);
  const where = venue && plot ? `${venue.name} · ${plot.name}` : "this plot";

  /**
   * Before anything that leaves this plot: true to go on. Unsaved changes are stored as the
   * plot's draft first and it goes on without asking; only a draft that could not be stored
   * asks, and is dropped on yes.
   */
  const confirmLeave = useCallback(async (): Promise<boolean> => {
    if (!isDirty(draftRef.current)) return true;
    if (await keeper.flush()) return true;
    const ok = await confirm({
      title: "Discard unsaved changes?",
      message: `The draft of ${where} could not be kept on the server, so going on loses your changes.`,
      confirmLabel: "Discard changes",
      destructive: true,
    });
    if (ok) {
      keeper.hold();
      dispatch({ type: "discard" });
    }
    return ok;
  }, [draftRef, where, keeper]);

  /** Discard: the draft goes here, and the keeper deletes it on the server once nothing is unsaved (a failure is shown under the banner). */
  const discard = () => {
    keeper.hold();
    dispatch({ type: "discard" });
    setRestored(null);
    setSaveError(null);
  };

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
    // Each linked point saves the name and colour it shows now. `sent` stays the draft's own
    // list, so the saved reducer still knows the draft is the one that was saved.
    const stamped = stampLinks(sent, shown.links);
    setSaving(true);
    let version = base;
    const send = async (on: number) => {
      const r = await stageplotsApi.saveItems(plot.id, on, stamped);
      onDraftNote(r.draftNotice ?? null);
      dispatch({ type: "saved", sent, items: r.plot.items });
      setBase(r.plot.version);
      version = r.plot.version;
      setSaveError(null);
    };
    // After any draft write already on its way, and before any after: the server deletes the
    // draft as the save lands, and no draft write may land after that and bring it back.
    keeper.hold();
    try {
      await keeper.saving(sent, async () => {
        try {
          await send(base);
        } catch (err) {
          if ((err as ApiError).status !== 409) throw err;
          const fresh = (await stageplotsApi.get()).plots.find((p) => p.id === plot.id);
          if (!fresh || !sameItems(fresh.items, based)) throw err;
          await send(fresh.version);
        }
      });
      keeper.forget();
      drafts.dropped(plot.id);
      setRestored(null);
      // Changed again while the save was on its way: that is a draft on the saved version.
      if (!sameItems(draftRef.current.items, sent)) void keeper.flush(version);
      return true;
    } catch (err) {
      if ((err as ApiError).status === 409) setConflict(true);
      else setSaveError(errorMessage(err));
      // The Save stopped the wait to keep the draft (hold, above): with the Save gone, nothing
      // else would keep it, and the banner would say "Keeping draft" with nothing on its way.
      void keeper.flush();
      return false;
    } finally {
      setSaving(false);
      void refresh();
    }
  };

  /** After a 409, or a kept draft drawn on an older version: take what the server holds now. The draft goes here, and the keeper deletes it on the server once nothing is unsaved. */
  const reload = async () => {
    if (!plot) return;
    keeper.hold();
    try {
      const fresh = (await stageplotsApi.get()).plots.find((p) => p.id === plot.id);
      if (fresh) {
        dispatch({ type: "load", items: fresh.items, height });
        setBase(fresh.version);
      }
      setConflict(false);
      setRestored(null);
      setSaveError(null);
    } catch (err) {
      setSaveError(errorMessage(err));
      // As a failed Save: the draft is still there, and the wait to keep it was stopped.
      void keeper.flush();
    }
    void refresh();
  };

  return (
    <div className="pt-5 pb-[50vh] max-sm:pt-4">
      {header}
      {/* Asks only while the newest change has not reached the server; a link or Back stores it first. */}
      {router && (
        <LeaveGuard
          dirty={keeper.unstored}
          flush={keeper.flush}
          message={`Your latest changes to ${where} have not reached the server, so they are not kept. Leaving loses them.`}
        />
      )}
      {conflict ? (
        <UnsavedBanner
          className="mb-3"
          marker={<BannerDot tone="warn" />}
          message={
            <>
              <b className="font-medium text-fg">This plot was saved elsewhere</b> after your draft began. Reload shows the saved plot and drops the draft.
            </>
          }
          actions={
            <Button variant="accent" size="small" onClick={() => void reload()}>
              Reload
            </Button>
          }
        />
      ) : restored && restored.plotId === plot?.id && keeper.status.kind === "kept" && keeper.status.savedAt === restored.savedAt ? (
        <UnsavedBanner
          className="mb-3"
          marker={<BannerDot tone="warn" />}
          message={
            <>
              <b className="font-medium text-fg">Unsaved draft from {whenLabel(restored.savedAt, plan.timeZone)}</b> on {where}. /stageplots still shows the saved plot.
            </>
          }
          actions={
            <>
              <Button variant="transparent" size="small" onClick={() => void discard()} disabled={saving}>
                Discard draft
              </Button>
              <Button variant="accent" size="small" onClick={() => void saveDraft()} disabled={saving}>
                {saving ? "Saving…" : "Save"}
              </Button>
            </>
          }
        />
      ) : (
        showBanner && (
          <UnsavedBanner
            className="mb-3"
            saving={saving}
            marker={<BannerDot tone={keeper.status.kind === "failed" ? "danger" : "warn"} />}
            message={
              keeper.status.kind === "failed" ? (
                <>
                  Unsaved changes to <b className="font-medium text-fg">{where}</b>. <b className="font-medium text-danger-11">The draft could not be kept</b> (
                  {keeper.status.reason}); leaving now loses it. Trying again.
                </>
              ) : (
                <>
                  Unsaved changes to <b className="font-medium text-fg">{where}</b>. Nothing reaches /stageplots until you save.{" "}
                  {keeper.status.kind === "kept" ? (
                    <span className="font-mono text-fg-subtle tabular-nums" data-testid="draft-kept">
                      Draft kept {formatClock(Date.parse(keeper.status.savedAt), { timeZone: plan.timeZone })}
                    </span>
                  ) : (
                    <span className="text-fg-subtle" data-testid="draft-keeping">
                      Keeping draft…
                    </span>
                  )}
                </>
              )
            }
            onSave={() => void saveDraft()}
            onDiscard={() => void discard()}
          />
        )
      )}
      <SaveError message={saveError ?? (keeper.dropError ? `The server still holds a draft of this plot that was meant to go (${keeper.dropError}); it opens again next time.` : null)} className="mb-3" />
      {draftNote && (
        <p role="status" data-testid="draft-note" className="-mt-1 mb-3 text-caption1 text-fg-muted">
          {draftNote}
        </p>
      )}
      {error && <ErrorNote className="mb-3">Couldn&apos;t refresh the stage plots; showing the last ones read.</ErrorNote>}
      <div className="grid items-start gap-4 lg:grid-cols-[268px_minmax(0,1fr)]">
        <aside className="flex flex-col gap-3">
          <VenuesCard
            doc={doc}
            selected={venue}
            onSelect={async (id) => {
              if (id === venue?.id) return true;
              const ok = await confirmLeave();
              if (ok) onVenue(id);
              return ok;
            }}
            save={save}
            drafted={drafted}
          />
          <BackgroundsCard doc={doc} selectedId={backgroundId} onSelect={onBackground} save={save} {...(openPdf ? { openPdf } : {})} />
          {venue && <ThisWeekCard doc={doc} venue={venue} plan={plan} nameOf={planName} save={save} />}
          {venue ? (
            <PublishCard venue={venue} pending={doc.pendingRemovals} save={save} timeZone={plan.timeZone} follow={doc.notice} landing={doc.landing} />
          ) : (
            <PendingLinksCard pending={doc.pendingRemovals} save={save} notice={doc.notice} timeZone={plan.timeZone} />
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
                drafted={drafted}
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
                  discard={discard}
                  shown={shown}
                  patch={patch}
                />
              ) : (
                <EmptyState title={`No plots in ${venue.name} yet`} hint="Add one with Add plot above." />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
