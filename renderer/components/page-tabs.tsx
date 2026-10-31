// page-tabs.tsx — the underline tab strip and search box shared by the pages whose
// tabs live in the URL: Settings > Advanced and Automation.
//
// Presentational only. Which tab is current, and what the query is, belong to the
// page; `usePageTabs` holds the part every such page repeats (the URL-or-own-state
// tab, the Search focus request, Cmd-F).
//
// ASSUMES A SEARCH TAB, and draws it last, pushed to the right edge (`ml-auto`) with a
// magnifier: a page whose strip has no Search tab, or wants it elsewhere, needs another bar.
//
// One tab is the Search tab. It sits at the right end of the strip, shows a
// magnifier, and is the one an arrow key must land on WITHOUT stealing focus into
// its box mid-arrow, which is why the strip has both `onSelect` and `onMove`.

import type { KeyboardEvent, ReactNode, RefObject } from "react";
import { SearchIcon } from "lucide-react";

import { cn } from "../lib/cn";

/** The key that opens Search from anywhere on the page, as the platform writes it. */
export function searchShortcutLabel(): string {
  const platform = typeof navigator === "undefined" ? "" : navigator.platform;
  return /mac|iphone|ipad/i.test(platform) ? "⌘F" : "Ctrl F";
}

const TAB_BUTTON =
  "flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3.5 py-2 text-footnote font-medium " +
  "transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus";

/** The tab an arrow key, Home or End moves to from `tab` within `order`, or null for a key that is not one. Wraps at both ends. */
export function tabAfterKey<Id extends string>(order: readonly Id[], tab: Id, key: string): Id | null {
  const at = order.indexOf(tab);
  if (key === "ArrowRight") return order[(at + 1) % order.length];
  if (key === "ArrowLeft") return order[(at - 1 + order.length) % order.length];
  if (key === "Home") return order[0];
  if (key === "End") return order[order.length - 1];
  return null;
}

/** What a tab carries beside its name: a spoken addition for its accessible name and a mark drawn after the name. */
export interface TabMark {
  said?: string;
  mark?: ReactNode;
}

/**
 * The strip. A click calls `onSelect`. An arrow key, Home or End moves focus to a
 * neighbouring tab and calls `onMove`, which selects it without taking focus away
 * from the strip. Only the selected tab is in the tab order; the arrows reach the
 * rest.
 *
 * `idPrefix` names the buttons (`<prefix>-<tab>`) so the panel can point back at
 * the selected one; `panelId` is the panel they control.
 */
export function PageTabBar<Id extends string>({
  label,
  tabs,
  searchId,
  tab,
  onSelect,
  onMove,
  idPrefix,
  panelId,
  markFor,
}: {
  /** The strip's accessible name. */
  label: string;
  /** The content tabs, in order. */
  tabs: readonly { id: Id; name: string }[];
  /** The Search tab, drawn last and pushed to the right. */
  searchId: Id;
  tab: Id;
  onSelect: (tab: Id) => void;
  onMove: (tab: Id) => void;
  idPrefix: string;
  panelId: string;
  markFor?: (tab: Id) => TabMark;
}) {
  const order: readonly Id[] = [...tabs.map((t) => t.id), searchId];
  const buttonId = (id: Id) => `${idPrefix}-${id}`;

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>, id: Id) {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const next = tabAfterKey(order, id, e.key);
    if (!next) return;
    e.preventDefault();
    document.getElementById(buttonId(next))?.focus();
    onMove(next);
  }

  const button = (id: Id, name: string, className?: string, icon?: boolean) => {
    const { said, mark } = markFor?.(id) ?? {};
    return (
      <button
        key={id}
        id={buttonId(id)}
        type="button"
        role="tab"
        aria-selected={tab === id}
        aria-controls={panelId}
        aria-label={said ? `${name}, ${said}` : undefined}
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
        {name}
        {mark}
      </button>
    );
  };

  return (
    <div role="tablist" aria-label={label} className="flex gap-0.5 overflow-x-auto border-b border-line">
      {tabs.map((t) => button(t.id, t.name))}
      {button(searchId, "Search", "ml-auto", true)}
    </div>
  );
}

export function PageSearchBox({
  value,
  onChange,
  inputRef,
  name,
  label,
  placeholder = label,
}: {
  value: string;
  onChange: (value: string) => void;
  inputRef: RefObject<HTMLInputElement | null>;
  name: string;
  /** The box's accessible name. */
  label: string;
  placeholder?: string;
}) {
  return (
    <label className="relative block">
      <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden="true" />
      <input
        ref={inputRef}
        type="search"
        name={name}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={label}
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
