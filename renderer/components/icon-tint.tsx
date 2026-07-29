import type { LucideIcon } from "lucide-react";
import { invoke } from "../lib/api";

/** The theme accent, used when an item has no colour of its own. Kept as a CSS
 *  var so a tinted and an untinted icon still agree with the rest of the theme. */
const DEFAULT_TINT = "var(--su-accent)";

/**
 * An item's icon, click to retint.
 *
 * Colours are stored in one map keyed by display id ("display-1") or tool path
 * ("/baptism"), so a colour set on the Displays tab or on Connect also shows on
 * the picker at "/" — the icon belongs to the thing, not to the screen it happens
 * to be rendered on.
 *
 * Built on a native <input type="color"> (as the static-slot colour field already
 * is) so it uses the OS picker rather than a bespoke palette: no new component to
 * maintain, and it works the same on a laptop and a phone.
 */
export function IconTint({
  itemKey,
  icon: Icon,
  color,
  label,
  className,
  iconClassName,
}: {
  /** Display id or tool path — the key this colour is stored under. */
  itemKey: string;
  icon: LucideIcon;
  /** Current colour, or null/undefined for the theme default. */
  color?: string | null;
  /** Used for the accessible name, e.g. "Left Mic Display". */
  label: string;
  className?: string;
  iconClassName?: string;
}) {
  const tint = color || DEFAULT_TINT;
  return (
    <label
      className={
        className ??
        "flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg transition-colors hover:brightness-125"
      }
      style={{ backgroundColor: `color-mix(in srgb, ${tint} 12%, transparent)` }}
      title={`Change the ${label} icon colour`}
    >
      <Icon className={iconClassName ?? "size-4"} style={{ color: tint }} />
      <input
        type="color"
        // Native colour inputs need a concrete value; the CSS var can't be one, so
        // fall back to a neutral when untinted rather than showing black.
        value={color || "#3b82f6"}
        onChange={(e) => void invoke("icons:setColor", { key: itemKey, color: e.target.value })}
        className="sr-only"
        aria-label={`${label} icon colour`}
      />
    </label>
  );
}
