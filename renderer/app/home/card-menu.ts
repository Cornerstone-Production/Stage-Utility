// The right-click menu of a Home card, as a pure builder.
//
// Lived inside HomeRoute as a closure over its save and menu state, which is why
// nothing could assert the ORDER of its rows or what a click on one writes: the
// only way in was to mount the whole page. Everything it needs from the page is
// the `deps` below, so a test passes plain functions and reads back exactly what
// the operator would see and what a click would save.

import type { HomeCardSize, HomeVisibility, LayoutObject } from "@main/types/views";
import type { ContextMenuItem } from "../../components/ui/context-menu";
import { LAYOUT_OBJECTS } from "../../main/layout-objects";
import { gameOptions } from "../../main/scores-object";
import { displayType } from "../../main/timer-config";
import { preferredSplMetric } from "../../settings/sections/overview-data";
import { metricOptions, meterOptions, sourceOptions, type SplMeters } from "../recording-status";
import { PICK_OPTIONS, pickedValue, togglesFor, withToggle } from "./card-toggles";
import { pvpNowMenuItems } from "./pvp-now-menu";
import { SIZES, SIZE_ORDER, WHEN_LABELS, removeCard, replaceCard, setWhen, sizeOf, whenOf } from "./home-cards";
import { resizeCard } from "./home-placement";

/** What the menu reads from, and writes through, the page that opened it. */
export interface CardMenuDeps {
  /** The followed teams, for a scores card's Game submenu. */
  scoresFavourites: Parameters<typeof gameOptions>[0];
  /** Live Smaart state, for the SPL card's Meter and Metric submenus. */
  spl: SplMeters;
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
  // A retired timer is named as the Timer it opens as.
  const label = LAYOUT_OBJECTS[displayType(card.config) as keyof typeof LAYOUT_OBJECTS]?.label ?? type;
  const toggles = togglesFor(card);
  const items: ContextMenuItem[] = [];
  // A choice writes one setting of the card and closes the menu.
  const choose = (key: Parameters<typeof withToggle>[1], value: Parameters<typeof withToggle>[2]) => () => {
    save((objs) => replaceCard(objs, withToggle(card, key, value)));
    close();
  };

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
        onSelect: choose("game", o.value),
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
        onSelect: choose(key, o.value),
      })),
    });
  }
  // The PVP "now" card's Layout choice, and its Label while Compact — see
  // pvpNowMenuItems.
  items.push(
    ...pvpNowMenuItems(card, (next) => {
      save((objs) => replaceCard(objs, next));
      close();
    }),
  );
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
          onSelect: choose("splMetric", k),
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
        onSelect: choose("meterId", o.value),
      })),
    });
    // Which Smaart metric the SPL card reads, right under which meter. The
    // Automatic row names the metric it resolves to this second; every other row
    // is a metric the meter in view reports, with its live value, so the choice is
    // made looking at the numbers. Rebuilt with every SPL push, like the rest of
    // the menu. `home-spl` only: see PICKS.metricKey for why the wall object is
    // not offered the same menu.
    const metric = pickedValue(card, "metricKey");
    if (metric != null && type === "home-spl") {
      const model = metricOptions(spl, meter, metric);
      const pick = (next: string) => choose("metricKey", next);
      const rows: ContextMenuItem[] = [
        { label: "Automatic", checked: metric === "", meta: model.automatic ?? undefined, onSelect: pick("") },
      ];
      if (model.options.length) {
        rows.push({ separator: true }, { heading: true, label: `From ${model.from}` });
        for (const o of model.options) {
          rows.push({
            // A pinned metric the meter stopped reporting stays listed and ticked,
            // so the menu is not blank while the card reads "not reporting".
            label: o.value == null ? `${o.metric} (not reporting)` : o.metric,
            checked: metric === o.metric,
            meta: o.value == null ? undefined : o.value.toFixed(1),
            onSelect: pick(o.metric),
          });
        }
      }
      items.push({ label: "Metric", items: rows });
    }
  }

  if (items.length) items.push({ separator: true });

  items.push({
    label: "Size",
    items: SIZE_ORDER.map((s) => ({
      label: SIZES[s].label,
      checked: sizeOf(card) === s,
      onSelect: () => {
        // The same resize as the edit-mode chips: a placed card pushes what it
        // grows onto downward rather than storing both on one cell.
        save((objs) => resizeCard(objs, card.id, s as HomeCardSize));
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
