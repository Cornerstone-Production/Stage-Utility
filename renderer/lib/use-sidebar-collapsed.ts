// Persisted sidebar collapse, shared by the settings panel and the operator app.
//
// Extracted from settings-view.tsx alongside useTheme so the two shells cannot
// offer different collapse behaviour. The storage key is unchanged, so an
// operator who collapsed the settings sidebar finds the operator rail collapsed
// too — one preference about how much chrome they want, not two.

import { useState } from "react";

export const SIDEBAR_COLLAPSED_KEY = "settings-sidebar-collapsed";

export function useSidebarCollapsed() {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  });
  function toggle() {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? "1" : "0");
      } catch {
        // localStorage unavailable — collapse still applies for this session.
      }
      return next;
    });
  }
  return { collapsed, toggle };
}
