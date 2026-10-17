import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useResyncOn } from "@renderer/lib/use-resync-on";
import { CableIcon, ChevronRightIcon, TriangleAlertIcon } from "lucide-react";

import { invoke } from "../lib/api";
import { useStageState } from "./use-stage-state";
import { useStatusChannel } from "./use-status-channel";
import { resolvePatch, endpointKey } from "../lib/patch-resolve";
import { rootFontPx, useElementWidth } from "../lib/use-element-width";
import { chainNodes, collectChanges, noRowsMessage, rackSections, sourceColor, withOwnerHeadings } from "../lib/patch-view-model";
import { plural } from "@main/services/plural";
import { LEGEND_NODES, PatchChain } from "./patch-chain";
import { PatchWide } from "./patch-view-wide";

/**
 * How wide the page itself (the pane beside the sidebar, not the window) has to be
 * for the table-per-rack layout; below it the page is the stacked column that
 * suits a phone held in the wings.
 *
 * Measured: with the console node left out of the path, which the rack card does
 * below 62rem, the widest table this app draws (real chain labels such as
 * "1.11 SD Rack in 12", a mic name, the longest note) is 879px. The card is the
 * pane minus the 270px column and its 14px gap, so the pane has to be at least
 * 1163px, and 74rem (1184px) is that rounded up to a whole rem. At that width the
 * note column, which says why a row changed, is never scrolled out of its card. A
 * 1440px window with the sidebar open is a 1176px pane and stacks; a 1280px one
 * with it collapsed is exactly 1184px, and 1440px collapsed is 1344px.
 */
export const PATCH_WIDE_MIN_PANE_REM = 74;

function SheetTabs({ sheets, activeId, onPick, className }: { sheets: PatchSheet[]; activeId?: string; onPick: (id: string) => void; className: string }) {
  if (sheets.length < 2) return null;
  return (
    <div className={`flex items-center gap-1 overflow-x-auto ${className}`}>
      {sheets.map((s) => (
        <button
          key={s.id}
          type="button"
          onClick={() => onPick(s.id)}
          className={`shrink-0 rounded-md px-3 py-1.5 text-footnote font-medium transition-colors ${s.id === activeId ? "bg-fill-active text-fg" : "text-fg-muted hover:text-fg"}`}
        >
          {s.name}
        </button>
      ))}
    </div>
  );
}

/** The editor is the back of this page. Without this link it is a route
 *  nobody can find — which is exactly what happened when Settings
 *  dissolved and only the viewer was routed. "Settings → Patch" is also
 *  no longer where it lives. */
function PatchFooter() {
  return (
    <div className="mt-6 flex items-center justify-center gap-2 text-caption2 text-fg-faint">
      <CableIcon className="size-3.5" />
      <span>Read-only · updates live ·</span>
      <a href="/patch/edit" className="text-accent hover:underline">Edit the patch</a>
    </div>
  );
}

/**
 * Public, read-only stage patch at /patch — a shareable link so volunteers see
 * THIS week's resolved patch (default → service-type variant → plan/week tweaks)
 * and, front and center, what changed vs the default. One tab per populated patch
 * sheet (Analog / Dante / WSG / Monitoring). Auto-follows the live/next PCO plan
 * via stage state; live-updates via the patch:updated SSE channel.
 */
export function PatchView() {
  const { state } = useStageState();
  const [sheetId, setSheetId] = useState<string>("");
  const [tab, setTab] = useState<"in" | "out">("in");
  const [changesOnly, setChangesOnly] = useState(false);
  const [q, setQ] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  // Read once, then live on "patch:updated". The ordering between the two is
  // useStatusChannel's job — see the note there: the read used to be dispatched
  // first and could land after a push, putting the pre-edit sheet back on a wall
  // display until somebody saved the patch again. clearOnReadFailure keeps the
  // old behaviour of showing nothing when the read fails.
  const readPatch = useCallback(() => invoke<PatchFile>("patch:get"), []);
  const { value: file } = useStatusChannel<PatchFile>(readPatch, "patch:updated", true, {
    clearOnReadFailure: true,
  });
  useEffect(() => {
    document.title = `${state?.appName ?? "Stage Utility"} — Patch`;
  }, [state?.appName]);

  // Only surface sheets that actually have a patch built; volunteers shouldn't see
  // empty seeded tabs. Keep the selected sheet valid as data loads/changes.
  const sheets = useMemo(() => (file?.sheets ?? []).filter((s) => s.devices.length > 0), [file]);
  const sheet = sheets.find((s) => s.id === sheetId) ?? sheets[0] ?? null;
  useResyncOn([sheet, sheetId], () => {
    if (sheet && sheet.id !== sheetId) setSheetId(sheet.id);
  });

  const resolved = useMemo(
    () => (sheet ? resolvePatch(sheet, { serviceTypeId: state?.serviceTypeId, planId: state?.planId }) : null),
    [sheet, state?.serviceTypeId, state?.planId],
  );

  const paneRef = useRef<HTMLDivElement>(null);
  const paneWidth = useElementWidth(paneRef);
  const wide = paneWidth >= PATCH_WIDE_MIN_PANE_REM * rootFontPx();

  // Every change, both directions: the desk layout lists them all, the stacked
  // one only the direction on screen.
  const allChanges = useMemo(() => (sheet && resolved ? collectChanges(sheet, resolved) : []), [sheet, resolved]);
  const sections = useMemo(
    () => (sheet && resolved ? rackSections(sheet, resolved, tab, { changesOnly, q }) : []),
    [sheet, resolved, tab, changesOnly, q],
  );

  const hasPatch = sheets.length > 0;
  const toggleRack = (id: string) => setCollapsed((c) => ({ ...c, [id]: !c[id] }));
  const openRack = (id: string) => setCollapsed((c) => (c[id] ? { ...c, [id]: false } : c));

  const body =
    wide && sheet && resolved ? (
      <div className="pb-[max(1rem,env(safe-area-inset-bottom))] pt-1">
        <SheetTabs sheets={sheets} activeId={sheet.id} onPick={setSheetId} className="mb-3" />
        <PatchWide
          sheet={sheet}
          state={state}
          resolved={resolved}
          changes={allChanges}
          sections={sections}
          tab={tab}
          onTab={setTab}
          q={q}
          onQ={setQ}
          changesOnly={changesOnly}
          onChangesOnly={setChangesOnly}
          collapsed={collapsed}
          onToggleRack={toggleRack}
          onOpenRack={openRack}
        />
        <PatchFooter />
      </div>
    ) : null;

  const changes = allChanges.filter(({ e }) => e.dir === tab);

  const stacked = (
  <div className="mx-auto max-w-3xl px-4 py-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
    {/* No brand row here - the shell's rail carries the logo and app name.
        The read-only pill stays: it is information about this page, not
        chrome. */}
    <div className="flex items-center">
      <span className="ml-auto rounded-full border border-line px-2 py-0.5 text-caption2 text-fg-subtle">Read-only</span>
    </div>

    {/* Context */}
    {/* The eyebrow sits ABOVE the row rather than stacked inside it. As one
        column of two lines it was the tallest thing on a centred flex row, so
        everything beside it centred against the PAIR: the plan title's
        baseline landed 8px above the service type's, and the two names read
        as belonging to different lines. Lifted out, every item on the row is
        a single line and they align on the baseline they share. */}
    <div className="mt-4 rounded-xl border border-line bg-surface px-4 py-3">
      <span className="block text-caption2 uppercase tracking-wider text-fg-subtle">This week</span>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-body font-semibold">{state?.serviceTypeName ?? "—"}</span>
        {resolved?.variantName && (
          // self-center: a chip is a box, not a word, and its own baseline
          // would hang it below the names it sits between.
          <span className="self-center rounded-full bg-fill px-2.5 py-1 text-caption1 text-fg">
            Base: {resolved.variantName}
          </span>
        )}
        {state?.planTitle && <span className="text-footnote text-fg-muted">{state.planTitle}</span>}
      </div>
    </div>

    {/* Sheet tabs (only when more than one sheet has a patch) */}
    <SheetTabs sheets={sheets} activeId={sheet?.id} onPick={setSheetId} className="mt-4" />

    {!hasPatch ? (
      <div className="mt-6 rounded-xl border border-line bg-surface px-4 py-10 text-center text-footnote text-fg-subtle">
        No patch has been set up yet.
      </div>
    ) : (
      <>
        {/* How to read the diagram */}
        <div className="mt-4 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface px-4 py-3">
          <span className="text-caption2 font-semibold uppercase tracking-wider text-fg-subtle">How to read</span>
          <PatchChain nodes={LEGEND_NODES} />
        </div>
        {/* Changes-first */}
        {changes.length > 0 && (
          <div className="mt-4 overflow-hidden rounded-xl border border-warn-9/40 bg-warn-9/12">
            <div className="flex items-center gap-2 border-l-2 border-warn-9 px-4 py-2.5 text-footnote font-semibold">
              <TriangleAlertIcon className="size-4 text-warn-11" />
              <span className="text-warn-11">{plural(changes.length, "change")}</span>
              <span className="text-fg-muted">from the standard patch</span>
            </div>
            <div className="divide-y divide-line">
              {changes.map(({ e, note }) => (
                <div key={endpointKey(e)} className="flex items-baseline gap-3 px-4 py-2">
                  <span className="w-10 shrink-0 font-mono text-caption1 tabular-nums text-fg-subtle">{e.dir} {e.index}</span>
                  <span className="font-medium">{e.unused ? <span className="text-fg-subtle line-through">{e.label || "(source)"}</span> : e.label || "(unnamed)"}</span>
                  {note && <span className="text-caption1 text-fg-muted">· {note}</span>}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Controls */}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
          <div className="inline-flex rounded-lg border border-line bg-surface p-1">
            {(["in", "out"] as const).map((t) => (
              <button key={t} type="button" onClick={() => setTab(t)} className={`rounded-md px-3.5 py-1.5 text-footnote transition-colors ${tab === t ? "bg-fill-active text-fg" : "text-fg-muted hover:text-fg"}`}>
                {t === "in" ? "Inputs" : "Outputs"}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter…" className="h-8 w-32 rounded-md border border-line-strong bg-field px-2.5 text-footnote text-fg focus:outline-none focus:border-focus" />
            <button type="button" onClick={() => setChangesOnly((v) => !v)} className={`rounded-md border px-3 py-1.5 text-footnote transition-colors ${changesOnly ? "border-warn-9 bg-warn-9/12 text-warn-11" : "border-line text-fg-muted hover:text-fg"}`}>
              Changes only
            </button>
          </div>
        </div>

        {/* Full patch, grouped by rack (and by owner within a rack) */}
        <div className="mt-4 flex flex-col gap-3">
          {sections.length === 0 && (
            <div className="rounded-xl border border-line bg-surface px-4 py-8 text-center text-footnote text-fg-subtle">
              {noRowsMessage(tab, { changesOnly, q })}
            </div>
          )}
          {sections.map(({ rack, rows }) => {
            const isCollapsed = collapsed[rack.id];
            return (
              <div key={rack.id} style={rack.color ? { boxShadow: `inset 3px 0 0 ${rack.color}` } : undefined} className="overflow-hidden rounded-xl border border-line bg-surface">
                <button type="button" onClick={() => toggleRack(rack.id)} className="flex w-full items-center gap-2 px-4 py-2.5 text-left">
                  <ChevronRightIcon className={`size-4 text-fg-subtle transition-transform ${isCollapsed ? "" : "rotate-90"}`} />
                  {rack.color && <span className="size-2.5 shrink-0 rounded-full" style={{ background: rack.color }} />}
                  <span className="text-footnote font-semibold">{rack.name}</span>
                  <span className="text-caption2 text-fg-subtle">{rows.length}</span>
                </button>
                {!isCollapsed && (
                  <div className="divide-y divide-line/60">
                    {withOwnerHeadings(rows).map(({ e, heading }) => {
                      const changed = resolved?.changed.has(endpointKey(e));
                      const srcColor = sheet ? sourceColor(e, sheet.devices) : undefined;
                      return (
                        <Fragment key={endpointKey(e)}>
                          {heading && (
                            <div className="bg-fill/60 px-4 py-1 text-caption2 font-semibold uppercase tracking-wider text-fg-subtle">
                              Owned by {heading}
                            </div>
                          )}
                          <div
                            style={!changed && srcColor ? { boxShadow: `inset 3px 0 0 ${srcColor}` } : undefined}
                            className={`flex items-baseline gap-3 px-4 py-2 ${changed ? "bg-warn-9/12 shadow-[inset_2px_0_0_var(--su-warn-9)]" : ""} ${e.unused ? "opacity-55" : ""}`}
                          >
                            <span className="w-14 shrink-0 font-mono text-caption1 tabular-nums text-fg-subtle">{e.index}{e.consoleChannel ? ` · ${e.consoleChannel}` : ""}</span>
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-baseline gap-x-2">
                                <span className={`font-medium ${e.unused ? "line-through text-fg-subtle" : ""}`}>{e.label || "—"}</span>
                                {tab === "in" && e.mic && <span className="text-caption1 text-fg-muted">{e.mic}</span>}
                                {tab === "in" && e.phantom && <span className="rounded border border-accent/40 px-1 font-mono text-[10px] text-accent">48V</span>}
                                {tab === "out" && e.feedType && <span className="text-caption1 text-fg-muted">{e.feedType}</span>}
                              </div>
                              <div className="mt-1"><PatchChain nodes={chainNodes(e, sheet?.devices ?? [])} /></div>
                            </div>
                          </div>
                        </Fragment>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </>
    )}

    <PatchFooter />
  </div>
  );

  return (
    // No `dark` class: this renders inside the operator shell, which follows the
    // user's light/dark toggle. It used to force dark because it was served as a
    // standalone chrome-free page alongside the always-dark kiosk.
    // One wrapper for both layouts: the pane's width is measured on it, and a
    // wrapper that remounted when the layout changed would lose the measurement.
    <div ref={paneRef} className="h-full overflow-y-auto bg-bg text-fg">
      {body ?? stacked}
    </div>
  );
}
