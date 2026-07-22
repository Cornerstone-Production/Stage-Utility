import { useEffect, useMemo, useState } from "react";
import { CableIcon, ChevronRightIcon, TriangleAlertIcon } from "lucide-react";

import { invoke, onNotification } from "../lib/api";
import { BrandLogo } from "../components/brand-logo";
import { useStageState } from "./use-stage-state";
import { resolvePatch, endpointKey } from "../lib/patch-resolve";

/**
 * Public, read-only stage patch at /patch — a shareable link so volunteers see
 * THIS week's resolved patch (default → service-type variant → plan/week tweaks)
 * and, front and center, what changed vs the default. Auto-follows the live/next
 * PCO plan via stage state; live-updates via the patch:updated SSE channel.
 */
export function PatchView() {
  const { state } = useStageState();
  const [file, setFile] = useState<PatchFile | null>(null);
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

  const resolved = useMemo(
    () => (file ? resolvePatch(file, { serviceTypeId: state?.serviceTypeId, planId: state?.planId }) : null),
    [file, state?.serviceTypeId, state?.planId],
  );

  const devName = (id: string) => file?.devices.find((d) => d.id === id)?.name ?? id;
  const racks = useMemo(() => (file?.devices ?? []).filter((d) => d.kind === "rack"), [file]);
  const baseByKey = useMemo(() => new Map((file?.endpoints ?? []).map((e) => [endpointKey(e), e] as const)), [file]);

  function chain(e: PatchEndpoint): string {
    const parts = (e.path ?? []).map((h) => `${devName(h.deviceId)} ${h.connector}`.trim());
    const rk = racks.find((r) => r.id === e.rackId);
    parts.push(`${rk?.name ?? "rack"} ${e.dir === "in" ? "in" : "out"} ${e.index}`);
    if (e.consoleChannel) parts.push(`console ${e.consoleChannel}`);
    return parts.join(" → ");
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

  const hasPatch = (file?.devices.length ?? 0) > 0;

  return (
    <div className="dark min-h-[100dvh] bg-bg text-fg">
      <div className="mx-auto max-w-3xl px-4 py-6">
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

        {!hasPatch ? (
          <div className="mt-6 rounded-xl border border-line bg-surface px-4 py-10 text-center text-footnote text-fg-subtle">
            No patch has been set up yet.
          </div>
        ) : (
          <>
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

            {/* Full patch, grouped by rack */}
            <div className="mt-4 flex flex-col gap-3">
              {racks.map((rack) => {
                const rows = (resolved?.endpoints ?? [])
                  .filter((e) => e.rackId === rack.id && e.dir === tab && meaningful(e))
                  .filter((e) => !changesOnly || resolved?.changed.has(endpointKey(e)))
                  .filter((e) => {
                    if (!q.trim()) return true;
                    const hay = `${e.index} ${e.label ?? ""} ${e.mic ?? ""} ${e.feedType ?? ""} ${e.consoleChannel ?? ""}`.toLowerCase();
                    return hay.includes(q.toLowerCase());
                  })
                  .sort((a, b) => a.index - b.index);
                if (rows.length === 0) return null;
                const isCollapsed = collapsed[rack.id];
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
                          return (
                            <div key={endpointKey(e)} className={`flex items-baseline gap-3 px-4 py-2 ${changed ? "bg-warn-2/25 shadow-[inset_2px_0_0_var(--warn-9)]" : ""} ${e.unused ? "opacity-55" : ""}`}>
                              <span className="w-14 shrink-0 font-mono text-caption1 tabular-nums text-fg-subtle">{e.index}{e.consoleChannel ? ` · ${e.consoleChannel}` : ""}</span>
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-baseline gap-x-2">
                                  <span className={`font-medium ${e.unused ? "line-through text-fg-subtle" : ""}`}>{e.label || "—"}</span>
                                  {tab === "in" && e.mic && <span className="text-caption1 text-fg-muted">{e.mic}</span>}
                                  {tab === "in" && e.phantom && <span className="rounded border border-accent/40 px-1 font-mono text-[10px] text-accent">48V</span>}
                                  {tab === "out" && e.feedType && <span className="text-caption1 text-fg-muted">{e.feedType}</span>}
                                </div>
                                <div className="truncate font-mono text-caption2 text-fg-subtle">{chain(e)}</div>
                              </div>
                            </div>
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
