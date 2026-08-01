import { useEffect, useMemo, useState } from "react";
import { Tooltip } from "../components/ui/tooltip";
import { Loader2Icon, ListChecksIcon, ArrowRightIcon, ChevronDownIcon } from "lucide-react";

import { BrandLogo } from "../components/brand-logo";
import { QrHint } from "../components/qr-hint";
import { useStageState } from "./use-stage-state";
import { invoke } from "../lib/api";

// Implicit layout that shows every note-category column — always available so the
// landing page works before any custom layout is configured (Phase 3 adds those).
export const ALL_COLUMNS_LAYOUT_ID = "__all__";
export const ALL_COLUMNS_SLUG = "all-columns";

/** URL-friendly slug from a name ("The Salt Company" → "the-salt-company"). */
export function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "x";
}

/** Build a pretty ScriptView URL from names (falls back to ids when unnamed). */
export function scriptViewUrl(typeName: string, layoutId: string, layoutName?: string): string {
  const laySlug = layoutId === ALL_COLUMNS_LAYOUT_ID ? ALL_COLUMNS_SLUG : slugify(layoutName ?? layoutId);
  return `/scriptview/${encodeURIComponent(slugify(typeName))}/${encodeURIComponent(laySlug)}`;
}

// ScriptView landing at "/scriptview". Lists PCO service types, each with a layout
// dropdown + open arrow, deep-linking to /scriptview/{serviceTypeId}/{layoutId}.
// Our own take on ScriptViewer's "Plans" page, in the kiosk design language.
export function ScriptViewIndex() {
  const { state, isLoading: stateLoading } = useStageState();
  const [types, setTypes] = useState<ServiceTypeDTO[] | null>(null);
  const [layouts, setLayouts] = useState<ScriptViewLayout[]>([]);
  const [shownIds, setShownIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<Record<string, string>>({});

  useEffect(() => { document.title = "ScriptView"; }, []);

  useEffect(() => {
    Promise.all([
      invoke<ServiceTypeDTO[]>("stage:listServiceTypes"),
      invoke<ScriptViewLayout[]>("scriptview:listLayouts"),
      invoke<ScriptViewConfig>("scriptview:getConfig"),
    ])
      .then(([t, l, c]) => { setTypes(t); setLayouts(l); setShownIds(c.serviceTypeIds ?? []); })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  // Layouts are global — every service type offers the same set.
  const globalLayouts = useMemo(() => [...layouts].sort((a, b) => a.order - b.order), [layouts]);

  // The curated set is authoritative: show exactly the enabled service types, in
  // the configured order. Nothing enabled → empty (guide the operator to Settings).
  const rows = useMemo(() => {
    if (!types) return [];
    return shownIds
      .map((id) => types.find((t) => t.id === id))
      .filter((t): t is ServiceTypeDTO => !!t);
  }, [types, shownIds]);

  const options = [
    ...globalLayouts.map((l) => ({ value: l.id, label: l.name })),
    { value: ALL_COLUMNS_LAYOUT_ID, label: "All columns" },
  ];
  const selectedFor = (typeId: string) => sel[typeId] ?? globalLayouts[0]?.id ?? ALL_COLUMNS_LAYOUT_ID;

  // Same centered brand mark the display picker shows above its list.
  const centerLogo = state?.emptySlotLogo ?? state?.appLogo;

  return (
    <div className="flex flex-col h-[100dvh] overscroll-none kiosk-surface pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
      {/* Brand top bar — matches the display picker. */}
      <div
        className="relative flex items-center h-10 shrink-0"
        style={{
          background: "rgba(0,0,0,0.50)",
          backdropFilter: "blur(20px)",
          borderBottom: "1px solid rgba(255,255,255,0.09)",
          boxShadow: "inset 0 1px 0 rgba(255,255,255,0.07), 0 1px 8px rgba(0,0,0,0.40)",
        }}
      >
        <div className="shrink-0 ml-3 flex items-center gap-2 text-fg-muted relative z-10">
          {state?.appLogo && (
            <BrandLogo logo={state.appLogo} monochrome className="size-5 rounded select-none text-fg" />
          )}
          <span className="text-caption1 font-title select-none truncate" style={{ letterSpacing: "0.02em" }}>
            {state?.appName ?? "ScriptView"}
          </span>
        </div>
        {state?.showQr && state.remoteUrl && (
          <Tooltip label="Open settings in a new tab">
            <a href="/settings" target="_blank" rel="noopener noreferrer" className="shrink-0 ml-auto mr-3 relative z-10 rounded transition-opacity hover:opacity-70" aria-label="Open settings in a new tab">
              <QrHint url={state.remoteUrl} compact />
            </a>
          </Tooltip>
        )}
      </div>

      {/* Scroll container + inner min-h-full centering wrapper: centers when the
          list is short, scrolls without clipping the ends when it's long. */}
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
        <div className="min-h-full flex flex-col items-center justify-center gap-8 px-6 py-8">
        {centerLogo && (
          <BrandLogo
            logo={centerLogo}
            monochrome
            className="text-fg-faint shrink-0"
            style={{ width: "clamp(6rem,22vmin,16rem)", height: "clamp(6rem,22vmin,16rem)" }}
          />
        )}
        <div className="flex flex-col gap-2 w-full max-w-md">
          <span className="text-caption2 font-medium uppercase tracking-wider text-fg-subtle text-center select-none mb-1" style={{ letterSpacing: "0.08em" }}>
            ScriptView · pick a service
          </span>

          {error ? (
            <p className="text-body text-red-10 text-center px-4">{error}</p>
          ) : !types || stateLoading ? (
            <div className="flex justify-center py-8"><Loader2Icon className="size-7 text-gray-7 animate-spin" /></div>
          ) : rows.length === 0 ? (
            <p className="text-body text-fg-subtle text-center max-w-xs">No service types enabled. Turn them on in Settings → ScriptView.</p>
          ) : (
            rows.map((type) => {
              const cur = selectedFor(type.id);
              return (
                <div key={type.id} className="flex items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3">
                  <ListChecksIcon className="size-5 text-fg-subtle shrink-0" />
                  <span className="text-body font-medium text-fg flex-1 truncate">{type.name}</span>
                  <div className="relative shrink-0">
                    <select
                      value={cur}
                      onChange={(e) => setSel((s) => ({ ...s, [type.id]: e.target.value }))}
                      className="appearance-none cursor-pointer rounded-lg bg-white/[0.06] py-1.5 pl-3 pr-8 text-caption1 font-medium text-fg-muted outline-none transition-colors hover:bg-white/10 hover:text-fg focus:text-fg"
                    >
                      {options.map((o) => <option key={o.value} value={o.value} className="bg-[var(--kiosk-surface-1)] font-medium">{o.label}</option>)}
                    </select>
                    <ChevronDownIcon className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-fg-subtle" />
                  </div>
                  <Tooltip label={`Open ${type.name}`}>
                    <a
                      href={scriptViewUrl(type.name, cur, globalLayouts.find((l) => l.id === cur)?.name)}
                      className="flex items-center justify-center rounded-lg border border-line bg-surface size-8 shrink-0 transition-colors hover:bg-white/15"
                      aria-label={`Open ${type.name}`}
                    >
                      <ArrowRightIcon className="size-4 text-fg-muted" />
                    </a>
                  </Tooltip>
                </div>
              );
            })
          )}
        </div>
        </div>
      </div>
    </div>
  );
}
