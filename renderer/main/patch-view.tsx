import { Fragment, useEffect, useMemo, useState } from "react";
import { CableIcon, ChevronRightIcon, TriangleAlertIcon } from "lucide-react";

import { invoke, onNotification } from "../lib/api";
import { BrandLogo } from "../components/brand-logo";
import { useStageState } from "./use-stage-state";
import { resolvePatch, endpointKey } from "../lib/patch-resolve";

type ChainNode = { text: string; kind: "source" | "hop" | "rack" | "console" };
const PILL: Record<ChainNode["kind"], string> = {
  source: "border-line-strong bg-fill-active text-fg font-medium",
  hop: "border-line bg-surface text-fg-muted font-mono",
  rack: "border-line-strong bg-surface text-fg font-mono",
  console: "border-line bg-transparent text-fg-subtle font-mono",
};

/** SVG chevron connector between diagram nodes. */
function Arrow() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" className="shrink-0 text-fg-faint" aria-hidden="true">
      <path d="M4 2.5 L7.5 6 L4 9.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** A signal path drawn as connected nodes: source → hops → rack → console. */
function PatchChain({ nodes }: { nodes: ChainNode[] }) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      {nodes.map((n, i) => (
        <Fragment key={i}>
          {i > 0 && <Arrow />}
          <span className={`rounded-md border px-2 py-0.5 text-caption2 whitespace-nowrap ${PILL[n.kind]}`}>{n.text}</span>
        </Fragment>
      ))}
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
  const [file, setFile] = useState<PatchFile | null>(null);
  const [sheetId, setSheetId] = useState<string>("");
  const [tab, setTab] = useState<"in" | "out">("in");
  const [changesOnly, setChangesOnly] = useState(false);
  const [q, setQ] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  useEffect(() => {
    invoke<PatchFile>("patch:get").then(setFile).catch(() => setFile(null));
    return onNotification("patch:updated", (p) => setFile(p as PatchFile));
  }, []);
  useEffect(() => {
    document.title = `${state?.appName ?? "Stage Utility"} — Patch`;
  }, [state?.appName]);

  // Only surface sheets that actually have a patch built; volunteers shouldn't see
  // empty seeded tabs. Keep the selected sheet valid as data loads/changes.
  const sheets = useMemo(() => (file?.sheets ?? []).filter((s) => s.devices.length > 0), [file]);
  const sheet = sheets.find((s) => s.id === sheetId) ?? sheets[0] ?? null;
  useEffect(() => {
    if (sheet && sheet.id !== sheetId) setSheetId(sheet.id);
  }, [sheet, sheetId]);

  const resolved = useMemo(
    () => (sheet ? resolvePatch(sheet, { serviceTypeId: state?.serviceTypeId, planId: state?.planId }) : null),
    [sheet, state?.serviceTypeId, state?.planId],
  );

  const devName = (id: string) => sheet?.devices.find((d) => d.id === id)?.name ?? id;
  const racks = useMemo(() => (sheet?.devices ?? []).filter((d) => d.kind === "rack"), [sheet]);
  const baseByKey = useMemo(() => new Map((sheet?.endpoints ?? []).map((e) => [endpointKey(e), e] as const)), [sheet]);

  function chainNodes(e: PatchEndpoint): ChainNode[] {
    const hops: ChainNode[] = (e.path ?? []).map((h) => ({ text: `${devName(h.deviceId)} ${h.connector}`.trim(), kind: "hop" }));
    const rk = racks.find((r) => r.id === e.rackId);
    const rack: ChainNode = { text: `${rk?.name ?? "rack"} ${e.dir === "in" ? "in" : "out"} ${e.index}`, kind: "rack" };
    const console: ChainNode[] = e.consoleChannel ? [{ text: `console ${e.consoleChannel}`, kind: "console" }] : [];
    const src: ChainNode[] = e.label ? [{ text: e.label, kind: "source" }] : [];
    // Signal flows source → stage boxes → rack → console (outputs flow the other way).
    return e.dir === "in" ? [...src, ...hops, rack, ...console] : [...console, rack, ...hops, ...src];
  }
  function meaningful(e: PatchEndpoint): boolean {
    return Boolean(e.label || e.consoleChannel || (e.path && e.path.length) || e.unused);
  }

  // "What changed vs the default" for the current direction.
  const changes = useMemo(() => {
    if (!resolved) return [];
    return resolved.endpoints
      .filter((e) => e.dir === tab && resolved.changed.has(endpointKey(e)))
      .sort((a, b) => a.index - b.index)
      .map((e) => {
        const base = baseByKey.get(endpointKey(e));
        let note = "";
        if (e.unused) note = "unused this week";
        else if ((base?.label ?? "") !== (e.label ?? "")) note = base?.label ? `was ${base.label}` : "new";
        else if (JSON.stringify(base?.path ?? []) !== JSON.stringify(e.path ?? [])) note = "re-patched";
        return { e, note };
      });
  }, [resolved, tab, baseByKey]);

  const hasPatch = sheets.length > 0;

  return (
    <div className="dark h-full overflow-y-auto bg-bg text-fg">
      <div className="mx-auto max-w-3xl px-4 py-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
        {/* Header */}
        <div className="flex items-center gap-2">
          {state?.appLogo && <BrandLogo logo={state.appLogo} monochrome className="size-5 rounded text-fg" />}
          <span className="text-caption1 font-title text-fg">{state?.appName ?? "Stage Utility"}</span>
          <span className="ml-auto rounded-full border border-line px-2 py-0.5 text-caption2 text-fg-subtle">Read-only</span>
        </div>
        <h1 className="mt-4 text-title2 font-semibold tracking-tight">Patch</h1>
        <p className="mt-1 text-footnote text-fg-muted">This week's inputs &amp; outputs — what's set, and what changed.</p>

        {/* Context */}
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-line bg-surface px-4 py-3">
          <div className="flex flex-col">
            <span className="text-caption2 uppercase tracking-wider text-fg-subtle">This week</span>
            <span className="text-body font-semibold">{state?.serviceTypeName ?? "—"}</span>
          </div>
          {resolved?.variantName && (
            <span className="rounded-full bg-fill px-2.5 py-1 text-caption1 text-fg">Base: {resolved.variantName}</span>
          )}
          {state?.planTitle && <span className="text-footnote text-fg-muted">{state.planTitle}</span>}
        </div>

        {/* Sheet tabs (only when more than one sheet has a patch) */}
        {sheets.length > 1 && (
          <div className="mt-4 flex items-center gap-1 overflow-x-auto">
            {sheets.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setSheetId(s.id)}
                className={`shrink-0 rounded-md px-3 py-1.5 text-footnote font-medium transition-colors ${s.id === sheet?.id ? "bg-fill-active text-fg" : "text-fg-muted hover:text-fg"}`}
              >
                {s.name}
              </button>
            ))}
          </div>
        )}

        {!hasPatch ? (
          <div className="mt-6 rounded-xl border border-line bg-surface px-4 py-10 text-center text-footnote text-fg-subtle">
            No patch has been set up yet.
          </div>
        ) : (
          <>
            {/* How to read the diagram */}
            <div className="mt-4 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface px-4 py-3">
              <span className="text-caption2 font-semibold uppercase tracking-wider text-fg-subtle">How to read</span>
              <PatchChain nodes={[{ text: "Kick In", kind: "source" }, { text: "Snake B 1", kind: "hop" }, { text: "Input Rack in 12", kind: "rack" }, { text: "console 12", kind: "console" }]} />
            </div>
            {/* Changes-first */}
            {changes.length > 0 && (
              <div className="mt-4 overflow-hidden rounded-xl border border-warn-6 bg-warn-2/40">
                <div className="flex items-center gap-2 border-l-2 border-warn-9 px-4 py-2.5 text-footnote font-semibold">
                  <TriangleAlertIcon className="size-4 text-warn-11" />
                  <span className="text-warn-11">{changes.length} change{changes.length === 1 ? "" : "s"}</span>
                  <span className="text-fg-muted">from the standard patch</span>
                </div>
                <div className="divide-y divide-line">
                  {changes.map(({ e, note }) => (
                    <div key={endpointKey(e)} className="flex items-baseline gap-3 px-4 py-2">
                      <span className="w-10 shrink-0 font-mono text-caption1 tabular-nums text-fg-subtle">{tab === "in" ? "in" : "out"} {e.index}</span>
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
                <button type="button" onClick={() => setChangesOnly((v) => !v)} className={`rounded-md border px-3 py-1.5 text-footnote transition-colors ${changesOnly ? "border-warn-7 bg-warn-2/40 text-warn-11" : "border-line text-fg-muted hover:text-fg"}`}>
                  Changes only
                </button>
              </div>
            </div>

            {/* Full patch, grouped by rack (and by owner within a rack) */}
            <div className="mt-4 flex flex-col gap-3">
              {racks.map((rack) => {
                const rows = (resolved?.endpoints ?? [])
                  .filter((e) => e.rackId === rack.id && e.dir === tab && meaningful(e))
                  .filter((e) => !changesOnly || resolved?.changed.has(endpointKey(e)))
                  .filter((e) => {
                    if (!q.trim()) return true;
                    const hay = `${e.index} ${e.label ?? ""} ${e.mic ?? ""} ${e.feedType ?? ""} ${e.consoleChannel ?? ""} ${e.owner ?? ""}`.toLowerCase();
                    return hay.includes(q.toLowerCase());
                  })
                  .sort((a, b) => a.index - b.index);
                if (rows.length === 0) return null;
                const isCollapsed = collapsed[rack.id];
                let lastOwner: string | undefined;
                return (
                  <div key={rack.id} className="overflow-hidden rounded-xl border border-line bg-surface">
                    <button type="button" onClick={() => setCollapsed((c) => ({ ...c, [rack.id]: !c[rack.id] }))} className="flex w-full items-center gap-2 px-4 py-2.5 text-left">
                      <ChevronRightIcon className={`size-4 text-fg-subtle transition-transform ${isCollapsed ? "" : "rotate-90"}`} />
                      <span className="text-footnote font-semibold">{rack.name}</span>
                      <span className="text-caption2 text-fg-subtle">{rows.length}</span>
                    </button>
                    {!isCollapsed && (
                      <div className="divide-y divide-line/60">
                        {rows.map((e) => {
                          const changed = resolved?.changed.has(endpointKey(e));
                          const owner = e.owner?.trim() || undefined;
                          const showOwner = owner !== lastOwner && owner !== undefined;
                          lastOwner = owner;
                          const srcColor = sheet?.devices.find((dv) => dv.id === e.path?.[0]?.deviceId)?.color;
                          return (
                            <Fragment key={endpointKey(e)}>
                              {showOwner && (
                                <div className="bg-fill/60 px-4 py-1 text-caption2 font-semibold uppercase tracking-wider text-fg-subtle">
                                  Owned by {owner}
                                </div>
                              )}
                              <div
                                style={!changed && srcColor ? { boxShadow: `inset 3px 0 0 ${srcColor}` } : undefined}
                                className={`flex items-baseline gap-3 px-4 py-2 ${changed ? "bg-warn-2/25 shadow-[inset_2px_0_0_var(--warn-9)]" : ""} ${e.unused ? "opacity-55" : ""}`}
                              >
                                <span className="w-14 shrink-0 font-mono text-caption1 tabular-nums text-fg-subtle">{e.index}{e.consoleChannel ? ` · ${e.consoleChannel}` : ""}</span>
                                <div className="min-w-0 flex-1">
                                  <div className="flex flex-wrap items-baseline gap-x-2">
                                    <span className={`font-medium ${e.unused ? "line-through text-fg-subtle" : ""}`}>{e.label || "—"}</span>
                                    {tab === "in" && e.mic && <span className="text-caption1 text-fg-muted">{e.mic}</span>}
                                    {tab === "in" && e.phantom && <span className="rounded border border-accent/40 px-1 font-mono text-[10px] text-accent">48V</span>}
                                    {tab === "out" && e.feedType && <span className="text-caption1 text-fg-muted">{e.feedType}</span>}
                                  </div>
                                  <div className="mt-1"><PatchChain nodes={chainNodes(e)} /></div>
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

        <div className="mt-6 flex items-center justify-center gap-2 text-caption2 text-fg-faint">
          <CableIcon className="size-3.5" /> Read-only · updates live · edited in Settings → Patch
        </div>
      </div>
    </div>
  );
}
