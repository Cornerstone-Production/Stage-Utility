// use-page-tabs.ts — the tab state a page with URL tabs and a Search tab shares.
//
// The tab belongs to the URL when the route hands `onTabChange` down, and to the
// page when not (a test, or a page mounted without a router). Opening Search also
// puts the cursor in its box, unless an arrow key got there: focus then stays on
// the strip. Cmd-F (Ctrl-F elsewhere) opens Search from any tab, with the text in
// the box selected, unless something nearer took the key or a dialog is open.

import { useEffect, useRef, useState, type RefObject } from "react";

export interface PageTabs<Id extends string> {
  tab: Id;
  /** Open a tab. Pass `focusSearch = false` for an arrow key's move. */
  goTo: (next: Id, focusSearch?: boolean) => void;
  searchRef: RefObject<HTMLInputElement | null>;
}

export function usePageTabs<Id extends string>({
  segment,
  onTabChange,
  parse,
  fallback,
  searchId,
}: {
  /** The URL's tab segment. Anything that is not a tab shows `fallback`. */
  segment: string | undefined;
  /** Called when the operator picks a tab, which the URL then hands back as `segment`. */
  onTabChange?: (tab: Id) => void;
  parse: (segment: string | undefined) => Id | null;
  fallback: Id;
  searchId: Id;
}): PageTabs<Id> {
  const [ownTab, setOwnTab] = useState<Id>(() => parse(segment) ?? fallback);
  const tab: Id = onTabChange ? (parse(segment) ?? fallback) : ownTab;
  const searchRef = useRef<HTMLInputElement>(null);
  // Bumped each time the operator asks for Search; the effect below answers it once the box exists.
  const [searchAsked, setSearchAsked] = useState(0);
  const searchAnswered = useRef(0);

  const latest = useRef({ tab, onTabChange });
  useEffect(() => {
    latest.current = { tab, onTabChange };
  });

  function goTo(next: Id, focusSearch = true) {
    if (next === searchId && focusSearch) setSearchAsked((n) => n + 1);
    if (latest.current.onTabChange) latest.current.onTabChange(next);
    else setOwnTab(next);
  }
  // The listener below is registered once; it calls the newest goTo through this.
  const goToRef = useRef(goTo);
  useEffect(() => {
    goToRef.current = goTo;
  });

  useEffect(() => {
    if (tab !== searchId || searchAnswered.current === searchAsked) return;
    searchAnswered.current = searchAsked;
    searchRef.current?.focus();
    searchRef.current?.select();
  }, [tab, searchAsked, searchId]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== "f") return;
      // Something nearer already took the key, or a dialog is open and the page behind it is not the operator's focus.
      if (e.defaultPrevented || document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      e.preventDefault();
      goToRef.current(searchId);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [searchId]);

  return { tab, goTo, searchRef };
}
