// editable-icon.tsx — an icon the operator can change, wherever it is drawn.
//
// Right-click opens the picker. The rule lives here once because two surfaces
// draw an item's icon — the Screens cards and the console rail — and two copies
// of "resolve the stored glyph, fall back to the built-in one, open a picker on
// right-click" would drift the first time either was touched.
//
// A HOOK, not a component: what a caller needs is the resolved glyph and the
// handful of callbacks that let the COLOUR panel edit it too. The icon and its
// colour are one popup — a preview in the colour being dragged, and a button
// that swaps the body for the set — so there is nothing left for a second
// component to render.
//
// Keyed the same way icon COLOURS are — display id, tool path, or view id — so a
// glyph chosen in one surface shows in every surface that draws the same thing.

import type { LucideIcon } from "lucide-react";
import { invoke } from "../lib/api";
import type { IconEditing } from "./ui/color-field";
import { resolveIcon } from "./icon-set";
import { useStageState } from "../main/use-stage-state";

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
      onPick: (name) => void invoke("icons:setIcon", { key: itemKey, glyph: name }),
      onClear: () => void invoke("icons:setIcon", { key: itemKey, glyph: "" }),
    },
  };
}
