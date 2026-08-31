import { errorMessage } from "@main/services/errors";
import { useEffect, useMemo, useState } from "react";
import { Tooltip } from "../components/ui/tooltip";
import { Loader2Icon, ListChecksIcon, ArrowRightIcon, ChevronDownIcon } from "lucide-react";

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
  const { isLoading: stateLoading } = useStageState();
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
      .catch((e) => setError(errorMessage(e)));
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


  return (
    // `h-full` rather than `h-[100dvh]`, and no `kiosk-surface` or safe-area
    // padding: this renders inside the operator shell, below the rail and the
    // context bar, and follows the light/dark toggle. All three were correct
    // when it was served as a standalone chrome-free page.
    //
    // The brand top bar and its settings QR are gone too - the rail carries the
    // logo, the app name and a Settings link, so repeating them here put two
    // brand rows on one screen.
    <div className="flex flex-col h-full overscroll-none">
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

          {error ? (
            <p className="text-body text-red-10 text-center px-4">{error}</p>
          ) : !types || stateLoading ? (
            <div className="flex justify-center py-8"><Loader2Icon className="size-7 text-fg-subtle animate-spin" /></div>
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
