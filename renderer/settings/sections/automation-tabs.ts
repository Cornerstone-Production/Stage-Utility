// automation-tabs.ts — the tabs of the Automation page, and where each lives.
//
// Each tab is its own URL, `/automation/<tab>`, as Advanced's are, so Back works
// between them and a link can be handed to someone. Bare `/automation` is the
// Commands tab. The Search tab sits beside the content tabs and holds one box
// across every list.

export const AUTOMATION_TABS = [
  { id: "commands", name: "Commands" },
  { id: "rules", name: "Rules" },
  { id: "activity", name: "Activity" },
  { id: "access", name: "Access" },
] as const;

export type AutomationTabId = (typeof AUTOMATION_TABS)[number]["id"];

export const AUTOMATION_SEARCH_TAB_ID = "search";
export type AutomationPageTab = AutomationTabId | typeof AUTOMATION_SEARCH_TAB_ID;

export const DEFAULT_AUTOMATION_TAB: AutomationTabId = "commands";

/** Where a tab lives. */
export function automationTabPath(tab: AutomationPageTab): string {
  return `/automation/${tab}`;
}

/** The tab a URL segment names, or null for anything that is not one. */
export function parseAutomationTab(segment: string | undefined): AutomationPageTab | null {
  if (segment === AUTOMATION_SEARCH_TAB_ID) return AUTOMATION_SEARCH_TAB_ID;
  return AUTOMATION_TABS.find((t) => t.id === segment)?.id ?? null;
}
