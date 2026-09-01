import { createElement } from "react";
import type { LucideIcon } from "lucide-react";
import { Tooltip } from "./ui/tooltip";
import { invoke } from "../lib/api";
import { errorMessage } from "@main/services/errors";
import { ColorField } from "./ui/color-field";
import { useEditableIcon } from "./editable-icon";
import { toast } from "./ui";
import { cn } from "../lib/cn";

/** The theme accent, used when an item has no color of its own. Kept as a CSS
 *  var so a tinted and an untinted icon still agree with the rest of the theme. */
const DEFAULT_TINT = "var(--su-accent)";

/**
 * An item's icon, click to retint.
 *
 * Colors are stored in one map keyed by display id ("display-1") or tool path
 * ("/baptism"), so a color set on the Screens page or on Connect also shows on
 * the picker at "/" — the icon belongs to the thing, not to the screen it happens
 * to be rendered on.
 *
 * Built on the app's own ColorField, like every other colour control here — the
 * OS picker it used to open could not be themed, could not express an opacity,
 * and on a wall-mounted touch screen put a system window over a live dashboard.
 *
 * ONE PANEL for both the colour and the glyph. They were two popups on the same
 * object — click for one, right-click for the other — which is two menus for one
 * thing and a gesture nobody discovers. The panel now previews the icon in the
 * colour being dragged and carries a button that swaps its body for the set.
 *
 * The glyph is stored in its own map under the same key as the colour, so an
 * icon chosen on the Screens tab shows on Connect and on the picker at "/" too —
 * the icon belongs to the thing, exactly as its colour does.
 */
export function IconTint({
  itemKey,
  legacyKey,
  icon: Icon,
  color,
  label,
  className,
  iconClassName,
}: {
  /** Display id, tool path or view id — the key this color is stored under. */
  itemKey: string;
  /**
   * A key this item was stored under before `itemKey`, if it moved.
   *
   * The GLYPH falls back to it here; the COLOUR falls back at the call site,
   * because the caller already resolves the colour out of the state it holds.
   * Both are migrated on the next write, which is the only moment a stored
   * choice may be moved — reading must not save.
   */
  legacyKey?: string;
  icon: LucideIcon;
  /** Current color, or null/undefined for the theme default. */
  color?: string | null;
  /** Used for the accessible name, e.g. "Left Mic Display". */
  label: string;
  className?: string;
  iconClassName?: string;
}) {
  const tint = color || DEFAULT_TINT;
  const { glyph, iconEditing } = useEditableIcon(itemKey, Icon, legacyKey);
  return (
    <Tooltip label={`Change the ${label} icon`}>
      <span
        className={cn(
          // RELATIVE, and that is load-bearing. The picker below covers this box
          // absolutely; without a positioned ancestor it resolved against the
          // document instead, so every tinted icon on a page sat at a fixed
          // point and stayed there while the page scrolled underneath it.
          "relative",
          className ??
            "flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors hover:brightness-125",
        )}
        style={{
          backgroundColor: `color-mix(in srgb, ${tint} 12%, transparent)`,
        }}
      >
        {/* An ordinary centred child — it is the picker that overlays it, not
            the other way round. */}
        {createElement(glyph, {
          className: cn("pointer-events-none", iconClassName ?? "size-4"),
          style: { color: tint },
        })}
        <ColorField
          label={`${label} icon color`}
          allowAlpha={false}
          // The stored value may be absent — the icon is then on the theme's own
          // colour, which is a token with no numbers to put on a slider.
          value={color || "#3b82f6"}
          // The legacy entry is cleared only AFTER the new one has landed, so a
          // failure loses nothing: at worst the colour stays where it was and is
          // still found by the fallback above.
          onChange={(v: string) => {
            void invoke("icons:setColor", { key: itemKey, color: v })
              .then(() => {
                if (!legacyKey || legacyKey === itemKey) return;
                return invoke("icons:setColor", { key: legacyKey, color: "" });
              })
              .catch((e: unknown) => {
                console.error("[icon-tint:setColor]", itemKey, v, e);
                toast.error(`Could not change the icon colour: ${errorMessage(e)}`);
              });
          }}
          className="absolute inset-0 [&>button]:size-full [&>button]:border-0 [&>button]:bg-transparent [&>button]:opacity-0"
          icon={iconEditing}
        />
      </span>
    </Tooltip>
  );
}
