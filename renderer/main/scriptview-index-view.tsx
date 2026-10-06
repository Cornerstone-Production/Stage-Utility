import { useEffect, useMemo, useState } from "react";
import { Tooltip } from "../components/ui/tooltip";
import { ErrorNote } from "../components/ui/error-note";
import { Loader2Icon, ListChecksIcon, ArrowRightIcon, ChevronDownIcon } from "lucide-react";

import { pcoConnected, useStageState } from "./use-stage-state";
import { invoke } from "../lib/api";
import { useFailedReads } from "../lib/use-failed-reads";
import { useResyncOn } from "../lib/use-resync-on";

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
/**
 * `standalone` is the chromeless `/scriptview` the tablet opens: no rail and no
 * context bar, so the page draws its own heading, as `/history` does. The
 * operator's `/scriptview/manage` renders inside the shell, which titles it.
 */
export function ScriptViewIndex({ standalone = false }: { standalone?: boolean } = {}) {
  const stage = useStageState();
  const stateLoading = stage.isLoading;
  const [types, setTypes] = useState<ServiceTypeDTO[] | null>(null);
  const [layouts, setLayouts] = useState<ScriptViewLayout[]>([]);
  const [shownIds, setShownIds] = useState<string[]>([]);
  const { failed, fail, clear } = useFailedReads<"load">("scriptview");
  const [sel, setSel] = useState<Record<string, string>>({});
  // A launcher for Planning Center's service types, so nothing is read until it
  // is connected (see pcoConnected).
  const pcoConfigured = pcoConnected(stage.state, stage.error);
  // A read tried while the state was unknown may have failed only because
  // Planning Center is not connected; once the state says so, that is the page.
  useResyncOn([pcoConfigured], () => {
    if (pcoConfigured === false) clear("load");
  });

  useEffect(() => { document.title = "ScriptView"; }, []);

  useEffect(() => {
    if (!pcoConfigured) return;
    let cancelled = false;
    Promise.all([
      invoke<ServiceTypeDTO[]>("stage:listServiceTypes"),
      invoke<ScriptViewLayout[]>("scriptview:listLayouts"),
      invoke<ScriptViewConfig>("scriptview:getConfig"),
    ])
      .then(([t, l, c]) => {
        if (cancelled) return;
        setTypes(t);
        setLayouts(l);
        setShownIds(c.serviceTypeIds ?? []);
        clear("load");
      })
      .catch((err: unknown) => { if (!cancelled) fail("load", "the ScriptView service types and layouts", err); });
    return () => { cancelled = true; };
  }, [pcoConfigured, fail, clear]);

  // Layouts are global — every service type offers the same set.
  const globalLayouts = useMemo(() => [...layouts].sort((a, b) => a.order - b.order), [layouts]);

  // The curated set is authoritative: show exactly the enabled service types, in
  // the configured order. Nothing enabled → empty (guide the operator to the ScriptView page).
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


  return (
    // Two URLs, one page. /scriptview is chromeless (isSharedChromelessPath),
    // like /history, and draws its own heading because nothing else on the
    // screen says what it is; /scriptview/manage sits in the shell, which
    // titles it, so the heading would be a second one there.
    <div className="flex flex-col h-full overscroll-none pt-[env(safe-area-inset-top)]">
      {standalone && (
        <div className="pt-5">
          <h1 className="text-subheadline font-semibold text-fg">ScriptView</h1>
          <p className="text-footnote text-fg-muted">Pick a service and a layout to open its rundown.</p>
        </div>
      )}
      {/* Scroll container + inner min-h-full centering wrapper: centers when the
          list is short, scrolls without clipping the ends when it's long. */}
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
        {/* CENTRED, in both axes. This is a launcher — four rows and an arrow —
            and left-aligned at the top of a page the width of a monitor it read
            as something that had come loose in the corner, with the rest of the
            screen empty behind it. The page's own title stays where the shell
            puts it; this is the content, and the content is the picker.

            `m-auto` rather than `justify-center`, because a flex child centred
            by justify has its overflowing top cut off when the list grows past
            the window — auto margins collapse instead of clipping. */}
        <div className="flex min-h-full py-8 max-sm:py-4">
        <div className="m-auto flex flex-col gap-2 w-full max-w-md">

          {pcoConfigured === false ? (
            <p className="text-body text-fg-subtle text-center max-w-xs">Connect Planning Center to use ScriptView.</p>
          ) : failed.has("load") ? (
            <ErrorNote>Couldn't load ScriptView's service types and layouts.</ErrorNote>
          ) : !types || stateLoading ? (
            <div className="flex justify-center py-8"><Loader2Icon className="size-7 text-fg-subtle animate-spin" /></div>
          ) : rows.length === 0 ? (
            <p className="text-body text-fg-subtle text-center max-w-xs">No service types enabled. Choose them on the ScriptView page, under Shown on the landing page.</p>
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
                      className="appearance-none cursor-pointer rounded-lg bg-fill py-1.5 pl-3 pr-8 text-caption1 font-medium text-fg-muted outline-none transition-colors hover:bg-fill-hover hover:text-fg focus:text-fg"
                    >
                      {options.map((o) => <option key={o.value} value={o.value} className="bg-surface font-medium">{o.label}</option>)}
                    </select>
                    <ChevronDownIcon className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-fg-subtle" />
                  </div>
                  <Tooltip label={`Open ${type.name}`}>
                    <a
                      href={scriptViewUrl(type.name, cur, globalLayouts.find((l) => l.id === cur)?.name)}
                      className="flex items-center justify-center rounded-lg border border-line bg-surface size-8 shrink-0 transition-colors hover:bg-fill-hover"
                      aria-label={`Open ${type.name}`}
                    >
                      <ArrowRightIcon className="size-4 text-fg-muted" />
                    </a>
                  </Tooltip>
                </div>
              );
            })
          )}
          <a
            href="/scriptview/presets"
            className="mt-2 self-start text-caption1 text-accent hover:underline"
          >
            Edit column presets
          </a>
        </div>
        </div>
      </div>
    </div>
  );
}
