// Persisted sidebar collapse, shared by the settings panel and the operator app.
//
// Extracted from settings-view.tsx alongside useTheme so the two shells cannot
// offer different collapse behaviour. The storage key is unchanged, so an
// operator who collapsed the settings sidebar finds the operator rail collapsed
// too — one preference about how much chrome they want, not two.

import { useState } from "react";
import { readStored, writeStored } from "./safe-storage";

export const SIDEBAR_COLLAPSED_KEY = "settings-sidebar-collapsed";

export function useSidebarCollapsed() {
  const [collapsed, setCollapsed] = useState(() => readStored(SIDEBAR_COLLAPSED_KEY, (raw) => raw === "1", false));
  function toggle() {
    setCollapsed((prev) => {
      const next = !prev;
      // Storage unavailable: the collapse still applies for this session.
      writeStored(SIDEBAR_COLLAPSED_KEY, next ? "1" : "0");
      return next;
    });
  }
  return { collapsed, toggle };
}
