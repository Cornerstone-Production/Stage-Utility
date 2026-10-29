// A board's slots as a screen would draw them: names, photos and live telemetry
// filled in for the layout being edited.
//
// The structure (which card is where, in which column) is always the DRAFT's, so
// a move shows at once. The people and devices come from the server's resolver,
// debounced, and are laid over the draft by slot id; a card the resolver has not
// answered for yet (one just added) draws as the draft is.

import { useEffect, useMemo, useState } from "react";

import { invoke as ipc } from "../../lib/api";
import { useResyncOn } from "../../lib/use-resync-on";

/** How long to wait after the last edit before asking the server. */
const DEBOUNCE_MS = 250;

export interface BoardPreview {
  /** The draft, with the resolved people and devices laid over it. */
  slots: Slot[];
  /** Which week's people filled it, for the line under the preview. */
  resolution: SlotsPreviewDTO | null;
  /** The resolved row for a slot id, for the inspector's "this plan". */
  resolved: ReadonlyMap<string, Slot>;
}

export function useBoardPreview(slots: Slot[], target: SlotsPreviewTarget | null): BoardPreview {
  const [resolution, setResolution] = useState<SlotsPreviewDTO | null>(null);
  const serviceTypeId = target?.serviceTypeId ?? null;
  const planId = target?.planId ?? null;

  // Cleared the moment the target moves, during render: left in place, the
  // previous week's people stayed on the cards until the new answer landed.
  useResyncOn([serviceTypeId, planId], () => setResolution(null));

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => {
      ipc<SlotsPreviewDTO>("views:resolveSlots", {
        slots: slots.map((s, i) => ({ ...s, order: i })),
        target: serviceTypeId ? { serviceTypeId, planId } : undefined,
      })
        .then((r) => {
          // The switcher can be stepped faster than one round trip; the cleanup
          // below has already flipped this flag for the target that was left.
          if (!cancelled) setResolution(r);
        })
        .catch((err) => console.error("[mic-slots] preview", err));
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [slots, serviceTypeId, planId]);

  return useMemo(() => {
    const resolved = new Map((resolution?.slots ?? []).map((s) => [s.id, s]));
    const merged = slots.map((s) => {
      const r = resolved.get(s.id);
      if (!r) return s;
      // The draft owns structure; the resolver owns who and what is live.
      return { ...r, order: s.order, stackWithPrevious: s.stackWithPrevious, widthIn: s.widthIn, link: s.link, channel: s.channel };
    });
    return { slots: merged, resolution, resolved };
  }, [slots, resolution]);
}
