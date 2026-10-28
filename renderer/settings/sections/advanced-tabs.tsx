// advanced-tabs.tsx — the tab strip and the search box of Settings > Advanced.
//
// Presentational only: which tab is current, and what the query is, belong to
// AdvancedSection.

import type { KeyboardEvent, RefObject } from "react";
import { SearchIcon } from "lucide-react";

import { plural } from "@main/services/plural";

import type { AdvancedSignals } from "../../app/advanced-signals";
import { cn } from "../../lib/cn";
import { ADVANCED_TABS, SEARCH_TAB_ID, type AdvancedPageTab } from "./advanced-settings";

/** The key that opens Search from anywhere on the page, as the platform writes it. */
export function searchShortcutLabel(): string {
  const platform = typeof navigator === "undefined" ? "" : navigator.platform;
  return /mac|iphone|ipad/i.test(platform) ? "⌘F" : "Ctrl F";
}

const TAB_BUTTON =
  "flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3.5 py-2 text-footnote font-medium " +
  "transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus";

export function tabButtonId(tab: AdvancedPageTab): string {
  return `advanced-tab-${tab}`;
}

export const ADVANCED_PANEL_ID = "advanced-tab-panel";

const TAB_ORDER: readonly AdvancedPageTab[] = [...ADVANCED_TABS.map((t) => t.id), SEARCH_TAB_ID];

/** The tab an arrow key moves to from `tab`, or null for a key that is not one. Wraps at both ends. */
export function tabAfterKey(tab: AdvancedPageTab, key: string): AdvancedPageTab | null {
  const at = TAB_ORDER.indexOf(tab);
  if (key === "ArrowRight") return TAB_ORDER[(at + 1) % TAB_ORDER.length];
  if (key === "ArrowLeft") return TAB_ORDER[(at - 1 + TAB_ORDER.length) % TAB_ORDER.length];
  if (key === "Home") return TAB_ORDER[0];
  if (key === "End") return TAB_ORDER[TAB_ORDER.length - 1];
  return null;
}

/**
 * The strip. A click calls `onSelect`. An arrow key, Home or End moves focus to a
 * neighbouring tab and calls `onMove`, which selects it without taking focus away
 * from the strip (landing on Search must not jump into its box mid-arrow). Only the
 * selected tab is in the tab order; the arrows reach the rest.
 *
 * `signals` puts a dot on Updates while an update waits and a count on Network
 * while host names wait: the same two marks the rail's Advanced row carries.
 */
export function AdvancedTabBar({
  tab,
  onSelect,
  onMove,
  signals,
}: {
  tab: AdvancedPageTab;
  onSelect: (tab: AdvancedPageTab) => void;
  onMove: (tab: AdvancedPageTab) => void;
  signals: AdvancedSignals;
}) {
  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>, id: AdvancedPageTab) {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const next = tabAfterKey(id, e.key);
    if (!next) return;
    e.preventDefault();
    document.getElementById(tabButtonId(next))?.focus();
    onMove(next);
  }

  const button = (id: AdvancedPageTab, label: string, className?: string, icon?: boolean) => {
    const names = id === "network" ? signals.hostNamesWaiting : 0;
    const flagged = id === "updates" && signals.updateAvailable;
    const said: string[] = [];
    if (flagged) said.push("update available");
    if (names > 0) said.push(`${plural(names, "host name")} waiting`);
    return (
      <button
        key={id}
        id={tabButtonId(id)}
        type="button"
        role="tab"
        aria-selected={tab === id}
        aria-controls={ADVANCED_PANEL_ID}
        aria-label={said.length > 0 ? `${label}, ${said.join(", ")}` : undefined}
        tabIndex={tab === id ? 0 : -1}
        onClick={() => onSelect(id)}
        onKeyDown={(e) => onKeyDown(e, id)}
        className={cn(
          TAB_BUTTON,
          tab === id ? "border-accent text-fg" : "border-transparent text-fg-muted hover:text-fg",
          className,
        )}
      >
        {icon && <SearchIcon className="size-3.5" aria-hidden="true" />}
        {label}
        {flagged && <span data-signal="update" aria-hidden="true" className="block size-1.5 rounded-full bg-accent" />}
        {names > 0 && (
          <span
            data-signal="host-names"
            aria-hidden="true"
            className="grid h-4 min-w-4 place-items-center rounded-full bg-accent px-1 text-[10px] font-semibold tabular-nums text-white"
          >
            {names}
          </span>
        )}
      </button>
    );
  };
  return (
    <div role="tablist" aria-label="Advanced settings" className="flex gap-0.5 overflow-x-auto border-b border-line">
      {ADVANCED_TABS.map((t) => button(t.id, t.name))}
      {button(SEARCH_TAB_ID, "Search", "ml-auto", true)}
    </div>
  );
}

export function AdvancedSearchBox({
  value,
  onChange,
  inputRef,
}: {
  value: string;
  onChange: (value: string) => void;
  inputRef: RefObject<HTMLInputElement | null>;
}) {
  return (
    <label className="relative block">
      <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden="true" />
      <input
        ref={inputRef}
        type="search"
        name="advanced-search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search Advanced settings"
        aria-label="Search Advanced settings"
        autoComplete="off"
        spellCheck={false}
        className={cn(
          "h-9 w-full rounded-md border border-line-strong bg-field pl-9 pr-3 text-footnote text-fg",
          "placeholder:text-gray-a8 transition-colors",
          "focus:outline-none focus:border-focus focus:ring-1 focus:ring-focus",
        )}
      />
    </label>
  );
}
