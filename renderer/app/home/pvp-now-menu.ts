// The right-click rows a ProVideoPlayer "now" card adds beyond its toggles: the
// Layout submenu, and the Label submenu while the layout is Compact.
//
// Out of home-route's cardMenu so the real rows are testable: the menu closure
// needs the whole route mounted, and these two decisions — what is ticked, and
// when Label is offered at all — are the ones worth pinning.

import type { LayoutObject, PvpNowLayout } from "@main/types/views";

import type { ContextMenuItem } from "../../components/ui/context-menu";
import { pvpNowRowStates } from "../../main/pvp-now-config";
import { sourceOptions } from "../recording-status";
import { PICK_OPTIONS, pickedValue, withToggle } from "./card-toggles";

/**
 * The Layout submenu (Full / Compact / Countdown only) and, while the layout is
 * Compact, the Label submenu. Nothing for a card that carries neither setting.
 *
 * Layout is ticked from the layout the card is DRAWING — a card saved with the
 * old Compact switch on is ticked Compact. Label is offered only for Compact, the
 * one layout whose caption borrows a name: a picker for a layout the card is not
 * drawing is a setting for something the operator cannot see.
 *
 * `write` receives the changed card; the caller saves it and closes the menu.
 */
export function pvpNowMenuItems(card: LayoutObject, write: (next: LayoutObject) => void): ContextMenuItem[] {
  const items: ContextMenuItem[] = [];
  const layout = pickedValue(card, "layout");
  const layoutMap = PICK_OPTIONS.layout;
  if (layout != null && layoutMap) {
    items.push({
      label: "Layout",
      items: sourceOptions(layoutMap, "Full").map((o) => ({
        label: o.label,
        checked: layout === o.value,
        onSelect: () => write(withToggle(card, "layout", o.value)),
      })),
    });
  }
  const nowLabel = pickedValue(card, "nowLabel");
  const labelMap = PICK_OPTIONS.nowLabel;
  if (nowLabel != null && labelMap && layout != null && !pvpNowRowStates(layout as PvpNowLayout).label) {
    items.push({
      label: "Label",
      items: sourceOptions(labelMap, "Cue").map((o) => ({
        label: o.label,
        checked: nowLabel === o.value,
        onSelect: () => write(withToggle(card, "nowLabel", o.value)),
      })),
    });
  }
  return items;
}
