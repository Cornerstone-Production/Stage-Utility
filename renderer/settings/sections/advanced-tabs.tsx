// advanced-tabs.tsx — the tab strip and the search box of Settings > Advanced.
//
// Presentational only: which tab is current, and what the query is, belong to
// AdvancedSection. The strip itself is the shared PageTabBar; what is Advanced's
// is its tab list and the two marks the rail's Advanced row carries.

import type { RefObject } from "react";

import { plural } from "@main/services/plural";

import type { AdvancedSignals } from "../../app/advanced-signals";
import { PageSearchBox, PageTabBar, type TabMark } from "../../components/page-tabs";
import { ADVANCED_TABS, SEARCH_TAB_ID, type AdvancedPageTab } from "./advanced-settings";

export function tabButtonId(tab: AdvancedPageTab): string {
  return `advanced-tab-${tab}`;
}

export const ADVANCED_PANEL_ID = "advanced-tab-panel";

/**
 * The strip.
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
  const markFor = (id: AdvancedPageTab): TabMark => {
    const names = id === "network" ? signals.hostNamesWaiting : 0;
    const flagged = id === "updates" && signals.updateAvailable;
    const said: string[] = [];
    if (flagged) said.push("update available");
    if (names > 0) said.push(`${plural(names, "host name")} waiting`);
    return {
      said: said.length > 0 ? said.join(", ") : undefined,
      mark: (
        <>
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
        </>
      ),
    };
  };
  return (
    <PageTabBar<AdvancedPageTab>
      label="Advanced settings"
      tabs={ADVANCED_TABS}
      searchId={SEARCH_TAB_ID}
      tab={tab}
      onSelect={onSelect}
      onMove={onMove}
      idPrefix="advanced-tab"
      panelId={ADVANCED_PANEL_ID}
      markFor={markFor}
    />
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
    <PageSearchBox
      value={value}
      onChange={onChange}
      inputRef={inputRef}
      name="advanced-search"
      label="Search Advanced settings"
      placeholder="Search Advanced settings"
    />
  );
}
