// The right-click menu of a Home card, as a pure builder.
//
// Lived inside HomeRoute as a closure over its save and menu state, which is why
// nothing could assert the ORDER of its rows or what a click on one writes: the
// only way in was to mount the whole page. Everything it needs from the page is
// the `deps` below, so a test passes plain functions and reads back exactly what
// the operator would see and what a click would save.

import type { LayoutObject } from "@main/types/views";
import type { ContextMenuItem } from "../../components/ui/context-menu";
import { LAYOUT_OBJECTS } from "../../main/layout-objects";
import { gameOptions } from "../../main/scores-object";
import { preferredSplMetric } from "../../settings/sections/overview-data";
import { meterOptions, sourceOptions } from "../recording-status";
import { PICK_OPTIONS, pickedValue, togglesFor, withToggle } from "./card-toggles";
import { SIZES, SIZE_ORDER, WHEN_LABELS, removeCard, replaceCard, setSize, setWhen, sizeOf, whenOf } from "./home-cards";
import type { HomeCardSize, HomeVisibility } from "@main/types/views";

/** What the menu reads from, and writes through, the page that opened it. */
export interface CardMenuDeps {
  /** The followed teams, for a scores card's Game submenu. */
  scoresFavourites: Parameters<typeof gameOptions>[0];
  /** Live Smaart state, for the SPL card's Meter and Metric submenus. */
  spl: Parameters<typeof meterOptions>[0];
  /** History's per-service summaries, for Recent services' Metric submenu. */
  splSummary: SplServiceSummary[] | undefined;
  /** Apply a change to the card list and persist it. */
  save: (update: (objs: readonly LayoutObject[]) => LayoutObject[]) => void;
  /** Close the menu. A checkable row leaves it open; a choice closes it. */
  close: () => void;
}

/**
 * The right-click menu for one card.
 *
 * Available WITHOUT entering edit mode, which is the point of it: reaching for
 * seconds on the clock should not mean putting the whole page into an editing
 * state first. Rebuilt on every open so the ticks show the current values.
 *
 * The settings themselves are derived — see card-toggles.
 */
export function buildCardMenu(card: LayoutObject, deps: CardMenuDeps): ContextMenuItem[] {
  const { scoresFavourites, spl, splSummary, save, close } = deps;
  const type = (card.config as { type: string }).type;
  const label = LAYOUT_OBJECTS[type as keyof typeof LAYOUT_OBJECTS]?.label ?? type;
  const toggles = togglesFor(card);
  const items: ContextMenuItem[] = [];

  for (const t of toggles) {
    items.push({
      label: t.label,
      checked: t.checked,
      // A checkable item leaves the menu open, so this fires repeatedly. It is
      // safe to: `card` is the one this render read from the live list, and
      // the next render rebuilds the whole menu from the saved result.
      onSelect: () => save((objs) => replaceCard(objs, withToggle(card, t.key, t.next))),
    });
  }
  // The scores card's "which game", the same choice and the same options the
  // layout inspector offers the wall object. A submenu rather than a row of
  // ticks because the list is as long as the operator's favourites, and it
  // sits with the toggles because it is a setting of the WIDGET, not of the
  // card's place on the page like Size and Show below.
  const pinned = pickedValue(card, "game");
  if (pinned != null) {
    items.push({
      label: "Game",
      items: gameOptions(scoresFavourites).map((o) => ({
        label: o.label,
        checked: pinned === o.value,
        onSelect: () => {
          save((objs) => replaceCard(objs, withToggle(card, "game", o.value)));
          close();
        },
      })),
    });
  }
  // The picks whose options are the app's own vocabulary rather than something
  // fetched: which recorder the Recording card answers for, which platform the
  // Streaming card watches. ONE block for both, driven by PICK_OPTIONS, because
  // a second hand-written submenu is how the two would drift apart.
  for (const [key, label, anyLabel] of [
    ["recorder", "Recorder", "Every recorder"],
    ["platform", "Platform", "Every platform"],
  ] as const) {
    const current = pickedValue(card, key);
    const map = PICK_OPTIONS[key];
    if (current == null || !map) continue;
    items.push({
      label,
      items: sourceOptions(map, anyLabel).map((o) => ({
        label: o.label,
        checked: current === o.value,
        onSelect: () => {
          save((objs) => replaceCard(objs, withToggle(card, key, o.value)));
          close();
        },
      })),
    });
  }
  // Which name the compact PVP "now" caption borrows. Offered only while
  // Compact is ON, the same reason the SPL metric picker below is gated on
  // its own switch — a Label picker for a mode the card is not drawing is a
  // setting for something the operator cannot see.
  const nowLabel = pickedValue(card, "nowLabel");
  if (nowLabel != null && (card.config as { compact?: boolean }).compact) {
    const map = PICK_OPTIONS.nowLabel;
    if (map) {
      items.push({
        label: "Label",
        items: sourceOptions(map, "Cue").map((o) => ({
          label: o.label,
          checked: nowLabel === o.value,
          onSelect: () => {
            save((objs) => replaceCard(objs, withToggle(card, "nowLabel", o.value)));
            close();
          },
        })),
      });
    }
  }
  // Which metric the Recent services card's trend line plots. Offered only
  // while the line is ON — a metric picker above a switch that is off is a
  // setting for something the operator cannot see.
  const splMetric = pickedValue(card, "splMetric");
  if (splMetric != null && (card.config as { showSpl?: boolean }).showSpl) {
    const keys = [...new Set((splSummary ?? []).flatMap((r) => Object.keys(r.metrics)))].sort();
    const chosen = splMetric || (preferredSplMetric(keys) ?? "");
    if (keys.length > 0) {
      items.push({
        label: "Metric",
        items: keys.map((k) => ({
          label: k,
          checked: chosen === k,
          onSelect: () => {
            save((objs) => replaceCard(objs, withToggle(card, "splMetric", k)));
            close();
          },
        })),
      });
    }
  }
  // The SPL card's "which meter", beside the scores card's "which game" and
  // for the same reason: a setting of the WIDGET, from a list this page has to
  // fetch. The default reads the loudest meter, so an operator who never opens
  // this menu is on exactly the behaviour the card has always had.
  const meter = pickedValue(card, "meterId");
  if (meter != null) {
    items.push({
      label: "Meter",
      items: meterOptions(spl, meter).map((o) => ({
        label: o.label,
        checked: meter === o.value,
        onSelect: () => {
          save((objs) => replaceCard(objs, withToggle(card, "meterId", o.value)));
          close();
        },
      })),
    });
  }

  if (items.length) items.push({ separator: true });

  items.push({
    label: "Size",
    items: SIZE_ORDER.map((s) => ({
      label: SIZES[s].label,
      checked: sizeOf(card) === s,
      onSelect: () => {
        save((objs) => setSize(objs, card.id, s as HomeCardSize));
        close();
      },
    })),
  });
  items.push({
    label: "Show",
    items: (Object.keys(WHEN_LABELS) as HomeVisibility[]).map((w) => ({
      label: WHEN_LABELS[w],
      checked: whenOf(card) === w,
      onSelect: () => {
        save((objs) => setWhen(objs, card.id, w));
        close();
      },
    })),
  });
  items.push({ separator: true });
  items.push({
    label: `Remove ${label}`,
    danger: true,
    onSelect: () => save((objs) => removeCard(objs, card.id)),
  });
  return items;
}
