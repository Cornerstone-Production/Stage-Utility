// Segmented theme picker — light, follow the system, dark.
//
// Extracted from settings-view.tsx so the settings panel and the operator app
// show the same control. `vertical` stacks the segments so it fits the narrow
// collapsed rail, where the wide pill would clip.

import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { THEME_MODES, type ThemeMode } from "../../lib/use-theme";
import { cn } from "../../lib/cn";

/** Label and icon per mode. Keyed off THEME_MODES so a new mode cannot be added
 *  to the type without the compiler demanding an entry here. */
const OPTIONS: Record<ThemeMode, { label: string; Icon: typeof SunIcon }> = {
  light: { label: "Light mode", Icon: SunIcon },
  system: { label: "Match system", Icon: MonitorIcon },
  dark: { label: "Dark mode", Icon: MoonIcon },
};

export function ThemeTogglePill({
  mode,
  setMode,
  vertical = false,
}: {
  mode: ThemeMode;
  setMode: (m: ThemeMode) => void;
  vertical?: boolean;
}) {
  return (
    <div className={cn("flex items-center gap-px rounded-lg bg-accent/12 p-0.5 shrink-0", vertical && "flex-col")}>
      {THEME_MODES.map((m) => {
        const { label, Icon } = OPTIONS[m];
        return (
          <button
            key={m}
            type="button"
            onClick={() => mode !== m && setMode(m)}
            aria-label={label}
            aria-pressed={mode === m}
            className={cn(
              "flex h-5 w-6 items-center justify-center rounded-md transition-colors",
              mode === m ? "text-accent" : "text-fg-subtle hover:text-fg",
            )}
          >
            <Icon className="size-3.5" />
          </button>
        );
      })}
    </div>
  );
}
