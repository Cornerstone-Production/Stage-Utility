// pvp-object.tsx — the ProVideoPlayer layer list, at wall scale.
//
// Its own file, like osc-button.tsx: it has a filter, three different empty
// states and a per-row composition, which is more than a switch arm should hold.
//
// It shows NO PICTURE, and there is no setting that would. PVP exposes no
// thumbnail, preview or frame endpoint — all 80 documented paths were enumerated
// — so "what is on screen" is answerable here only as a name, a state and a time.

import { useLayoutEffect, useRef, useState } from "react";

import { PvpLayerRow } from "./pvp-layer-row";
import { noSuchLayer, pvpUnavailableReason } from "./pvp-progress";
import type { LayoutObjectConfig } from "@main/types/stage";
import { hasContent, type PvpLayerDTO, type PvpStatusDTO } from "@main/types/pvp";

type Config = Extract<LayoutObjectConfig, { type: "pvp-layers" }>;

/**
 * Which layers this object draws.
 *
 * PURE and exported so the filter is testable without React. "with-content" is
 * decided by `state`, which parseWorkspace derived from the PRESENCE of
 * playingMedia — never from isPlaying, and never from playingItem.
 */
export function visibleLayers(layers: readonly PvpLayerDTO[], c: Config): PvpLayerDTO[] {
  if (c.show === "all") return [...layers];
  if (c.show === "one") {
    const want = (c.layerName ?? "").trim().toLowerCase();
    // An unconfigured "one" shows nothing rather than everything: silently
    // showing all eleven would look like the filter had been ignored.
    if (!want) return [];
    return layers.filter((l) => l.name.trim().toLowerCase() === want);
  }
  return layers.filter(hasContent);
}

/**
 * Why this object draws nothing, in the operator's words.
 *
 * PURE and exported so the three cases are pinned by a test rather than read off
 * the screen. Three different nothings, said differently: "—" for all of them
 * would make an unreachable PVP look identical to an idle one, and an operator
 * would go looking for a fault in the wrong machine.
 */
export function emptyReason(status: PvpStatusDTO | null, c: Config): string {
  // The first two rungs are pvp-now's too, and the reasoning for them — a null
  // status is "no snapshot yet", not "PVP is down" — lives beside them in
  // pvp-progress.ts.
  const unavailable = pvpUnavailableReason(status);
  if (unavailable !== null) return unavailable;
  if (c.show === "one") {
    // The untrimmed name, as it was: the sentence quotes back what the operator
    // typed into the layout, not a tidied version of it.
    return (c.layerName ?? "").trim() ? noSuchLayer(c.layerName ?? "") : "No layer chosen";
  }
  return "Nothing on screen";
}

/**
 * How many rows are clipped off the bottom of the box.
 *
 * A wall tile cannot scroll, so a list longer than its box is clipped — and the
 * browser sweep found that clipping is SILENT: eleven layers in a 257x159 tile
 * drew five and dropped six with nothing to say so, and the default
 * "with-content" filter did the same at nine layers in a normal tile. An
 * operator reading five rows has no way to know four are missing, which is worse
 * than a short list, because it is a list that looks complete.
 *
 * Same shape as useFitScale in layout-renderer.tsx: measure after layout, and
 * re-measure on resize. EVERY row is rendered and the box clips them, so this
 * measurement always sees the whole list — slicing the list to what fits would
 * feed the next measurement its own output and settle on whatever it happened to
 * render first.
 *
 * It counts rows whose bottom falls outside the box rather than dividing
 * heights, because rows are not all the same height: one carrying a progress
 * rule is half again the height of one that is not.
 */
function useClippedRows(container: React.RefObject<HTMLDivElement | null>, rowShape: string): number {
  const [clipped, setClipped] = useState(0);
  useLayoutEffect(() => {
    const el = container.current;
    if (!el) return;
    const measure = () => {
      const avail = el.clientHeight;
      if (avail <= 1) return;
      let n = 0;
      for (const child of Array.from(el.children)) {
        const c = child as HTMLElement;
        // The overlay counts nothing, least of all itself.
        if (c.dataset.pvpMore !== undefined) continue;
        if (c.offsetTop + c.offsetHeight > avail + 1) n++;
      }
      setClipped((prev) => (prev === n ? prev : n));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
    // rowShape, not a row COUNT. Row heights vary — a plain row is one line, a
    // rolling clip with the progress rule under it is more — so four layers
    // gaining content, or the rule being switched on, re-flows the stack without
    // changing how many rows there are. Keyed on the count, the observer would never
    // fire (the container is a fixed box inside the layout, so it does not
    // resize with its content) and the chip would go stale in both directions:
    // silent clipping again, or a "+4 more" that outlived what it counted.
  }, [container, rowShape]);
  return clipped;
}

export function PvpObject({ config, status, now, skewMs, H }: {
  config: Config;
  status: PvpStatusDTO | null;
  now: number;
  skewMs: number;
  /** The canvas height in layout pixels, for the row gap. */
  H: number;
}) {
  const rows = visibleLayers(status?.layers ?? [], config);
  const showProgress = config.showProgress ?? false;
  const ref = useRef<HTMLDivElement | null>(null);
  // Everything that changes a row's HEIGHT, not just how many rows there are.
  //
  // `showProgress` IS IN HERE, and it belongs to the class of bug this signature
  // was written for: turning the bar on adds a rule to every rolling row, which
  // reflows the stack without changing how many rows there are. Left out, the
  // "+N more" chip would keep counting the pre-toggle layout until the next real
  // cue change — a count that outlived what it counted, which is the same
  // silent-clipping failure with an extra step.
  const clipped = useClippedRows(
    ref,
    `${showProgress}|` +
      rows.map((l) => `${l.uuid}:${l.state}:${l.durationSec ?? ""}:${l.hidden}${l.muted}${l.opacity}`).join("|"),
  );

  if (rows.length === 0) {
    if (config.hideWhenEmpty ?? false) return null;
    return <span className="text-fg-subtle opacity-60">{emptyReason(status, config)}</span>;
  }

  return (
    <div
      ref={ref}
      className="relative flex flex-col w-full h-full overflow-hidden min-w-0"
      // A fraction of the CANVAS height, the way charger-battery spaces its bays
      // and the way every length in a layout is expressed — so one object reads
      // the same on a phone card and on a 1080p wall without a second set of
      // numbers.
      style={{ gap: `${0.012 * H}px` }}
    >
      {rows.map((l) => (
        <PvpLayerRow
          key={l.uuid}
          layer={l}
          sampledAt={status?.sampledAt ?? null}
          now={now}
          skewMs={skewMs}
          showProgress={showProgress}
        />
      ))}
      {clipped > 0 && (
        /* Pinned over the bottom edge rather than appended, so it cannot itself
           be the thing that gets clipped. */
        <span
          data-pvp-more
          className="absolute bottom-0 right-0 px-1 rounded-sm bg-bg/85 text-[0.8em] text-fg-subtle leading-tight"
        >
          +{clipped} more
        </span>
      )}
    </div>
  );
}
