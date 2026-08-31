// editable-icon.tsx — an icon the operator can change, wherever it is drawn.
//
// Two rules live here once, because two surfaces draw an item's icon and two
// copies of either would drift the first time one was touched: resolve the
// stored glyph and fall back to the built-in one, and report a save that did
// not land.
//
// A HOOK, not a component, and it owns no GESTURE. What a caller needs is the
// resolved glyph and the callbacks that let the COLOUR panel edit it — the icon
// and its colour are one popup, a preview in the colour being dragged and a
// button that swaps the body for the set. How the popup is REACHED belongs to
// the surface: a Screens card opens it from the colour swatch (icon-tint.tsx),
// and the console rail opens it by right-clicking the glyph, which the rail
// implements itself because its rows are <button> elements and there is nothing
// else there to right-click.
//
// Keyed the same way icon COLOURS are — display id, tool path, or view id — so a
// glyph chosen in one surface shows in every surface that draws the same thing.

import type { LucideIcon } from "lucide-react";
import { invoke } from "../lib/api";
import { errorMessage } from "@main/services/errors";
import { toast } from "./ui";
import type { IconEditing } from "./ui/color-field";
import { resolveIcon } from "./icon-set";
import { useStageState } from "../main/use-stage-state";

/**
 * Store a chosen glyph, and say so if it does not land.
 *
 * Four call sites over two surfaces, and every one of them closed the picker on
 * the click: a rejected save changed nothing, said nothing, and left an
 * unhandled rejection behind. The convention is two files away —
 * calendar-sources.tsx and checklist-sources.tsx both report theirs.
 *
 * @param glyph the icon's stored name, or "" to go back to the built-in one.
 */
export function saveIcon(key: string, glyph: string): void {
  void invoke("icons:setIcon", { key, glyph }).catch((e: unknown) =>
    toast.error(`Could not change the icon: ${errorMessage(e)}`),
  );
}

export interface EditableIconParts {
  /** The icon to draw: the operator's choice, else the caller's own. */
  glyph: LucideIcon;
  /** Hand to a ColorField, which owns the one panel that edits both. */
  iconEditing: IconEditing;
}

export function useEditableIcon(
  /** Display id, tool path or view id — the key this glyph is stored under. */
  itemKey: string,
  /** The item's built-in icon, used until the operator picks another. */
  fallback: LucideIcon,
): EditableIconParts {
  const { state } = useStageState();
  const chosen = state?.iconGlyphs?.[itemKey] ?? null;
  // resolveIcon answers null for a name this build does not know, which is what
  // stops a set trimmed in a later release leaving a hole where an icon was.
  const glyph = resolveIcon(chosen) ?? fallback;

  return {
    glyph,
    iconEditing: {
      glyph,
      current: chosen,
      onPick: (name) => saveIcon(itemKey, name),
      onClear: () => saveIcon(itemKey, ""),
    },
  };
}
