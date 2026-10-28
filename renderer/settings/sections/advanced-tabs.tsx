// advanced-tabs.tsx — the tab strip and the search box of Settings > Advanced.
//
// Presentational only: which tab is current, and what the query is, belong to
// AdvancedSection.

import type { RefObject } from "react";
import { SearchIcon } from "lucide-react";

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

export function AdvancedTabBar({ tab, onSelect }: { tab: AdvancedPageTab; onSelect: (tab: AdvancedPageTab) => void }) {
  const button = (id: AdvancedPageTab, label: string, className?: string, icon?: boolean) => (
    <button
      key={id}
      id={tabButtonId(id)}
      type="button"
      role="tab"
      aria-selected={tab === id}
      aria-controls={ADVANCED_PANEL_ID}
      onClick={() => onSelect(id)}
      className={cn(
        TAB_BUTTON,
        tab === id ? "border-accent text-fg" : "border-transparent text-fg-muted hover:text-fg",
        className,
      )}
    >
      {icon && <SearchIcon className="size-3.5" aria-hidden="true" />}
      {label}
    </button>
  );
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
