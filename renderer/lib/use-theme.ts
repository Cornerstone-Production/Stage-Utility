// Theme mode, shared by the settings panel and the operator app.
//
// Extracted from settings-view.tsx so the two shells cannot drift into offering
// different toggles. The pre-paint application still lives in each entry
// document's inline script (settings-window.html, app.html) — that has to run
// before React, or the page flashes the wrong theme on load.
//
// The `.dark` class on <html> drives the Radix color scales.

import { useEffect, useState } from "react";

/** Order is the order they render in the pill. */
export const THEME_MODES = ["light", "system", "dark"] as const;

/** "system" follows the OS and keeps following it as the OS changes. */
export type ThemeMode = (typeof THEME_MODES)[number];

export const THEME_STORAGE_KEY = "stage-utility-theme";

const SYSTEM_DARK = "(prefers-color-scheme: dark)";

function isThemeMode(v: unknown): v is ThemeMode {
  return typeof v === "string" && (THEME_MODES as readonly string[]).includes(v);
}

function storedMode(): ThemeMode {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (isThemeMode(raw)) return raw;
  } catch {
    // localStorage unavailable (private mode etc.) — fall through to system.
  }
  // No stored choice means the app has always followed the OS, so an install that
  // predates this option keeps the behaviour it already had.
  return "system";
}

export function useTheme() {
  const [mode, setModeState] = useState<ThemeMode>(storedMode);
  const [isDark, setIsDark] = useState(() => document.documentElement.classList.contains("dark"));

  // One place decides what `.dark` should be, so the class can never disagree with
  // the mode — whether it changed because the operator picked one or because the OS
  // flipped underneath us.
  useEffect(() => {
    const mq = window.matchMedia(SYSTEM_DARK);
    const apply = () => {
      const dark = mode === "system" ? mq.matches : mode === "dark";
      document.documentElement.classList.toggle("dark", dark);
      setIsDark(dark);
    };
    apply();
    if (mode !== "system") return;
    // Only worth listening while following the OS; a fixed choice ignores it.
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [mode]);

  function setMode(next: ThemeMode) {
    setModeState(next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Theme still applies for this session; it just will not survive a reload.
    }
  }

  return { mode, isDark, setMode };
}
