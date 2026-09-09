// The preview follows the plan switcher.
//
// The preview iframe beside a slots editor runs the real kiosk renderers against
// the SERVER's state, which is always the plan the screens are following. That
// is right until the switcher moves the editor: stepping to next Sunday then
// edited one board while looking at a picture of another, and the rows drawn had
// this week's people in them.
//
// So the rows are resolved here — for the board being EDITED, against that
// board's roster — and pushed into the iframe, whenever the editor is anywhere
// other than the live plan with nothing unsaved. On the live plan and clean the
// hook returns null and the iframe shows the kiosk, exactly as before.
//
// The caption is not decoration. "No names" has three causes that look identical
// in the rows — a default board has no week, a plan can have nobody scheduled
// yet, and Planning Center can be unreachable — and an operator has to be able
// to tell which one they are looking at before they judge the board.

import { useEffect, useState } from "react";

import { invoke as ipc } from "../../lib/api";
import { useResyncOn } from "../../lib/use-resync-on";
import { useEditingTarget } from "./editing-target";

/** How long to wait after the last keystroke before asking the server. */
const DEBOUNCE_MS = 250;

/**
 * Rows for the preview, and whose roster filled them. Null means "show the
 * kiosk" — the editor is on the live plan with nothing unsaved.
 */
export type PreviewResolution = SlotsPreviewDTO | null;

/**
 * Resolve `slots` for the board the editor is pointed at.
 *
 * `dirty` is not the only trigger. The editor being off the live plan is the
 * other: a clean editor on next Sunday still needs its own rows, because the
 * server's own state is this Sunday's.
 */
export function useSlotsPreview(slots: Slot[], dirty: boolean): PreviewResolution {
  const editing = useEditingTarget();
  const { serviceTypeId, planId } = editing.target;
  // The live-vs-editing question is answered in ONE place — the same store the
  // switcher's badge reads — so the caption and the badge can never disagree.
  //
  // `serviceTypeId` has to be there for an off-live target to mean anything: the
  // switcher's native select carries a "Plan…" placeholder whose value decodes to
  // a target with no service type at all, and asking the server to preview that
  // spends a round trip to be told what the iframe is already showing.
  const wanted = dirty || (!editing.onLive && !!serviceTypeId);

  const [resolved, setResolved] = useState<SlotsPreviewDTO | null>(null);

  // Cleared the moment the target moves, during render. Left in place, the
  // previous week's resolved rows stayed in the iframe until the new answer
  // landed — a preview confidently showing the board the operator just left.
  useResyncOn([wanted, serviceTypeId, planId], () => setResolved(null));

  useEffect(() => {
    if (!wanted) return;
    let cancelled = false;
    const t = setTimeout(() => {
      ipc<SlotsPreviewDTO>("views:resolveSlots", {
        slots: slots.map((s, i) => ({ ...s, order: i })),
        // Omitted only when there is no service type at all, which is the
        // server's own "there is no board here".
        target: serviceTypeId ? { serviceTypeId, planId } : undefined,
      })
        .then((r) => {
          // The switcher can be stepped twice faster than one round trip. The
          // cleanup below has already flipped this flag for the target that was
          // abandoned, so its answer is dropped rather than painted over the new
          // one.
          if (!cancelled) setResolved(r);
        })
        .catch((err) => console.error("[settings:slotsPreview]", err));
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [wanted, slots, serviceTypeId, planId]);

  return wanted ? resolved : null;
}

/** How many of a board's PCO-linked positions the roster actually filled. */
export function positionsFilled(slots: Slot[]): { filled: number; total: number } {
  const pco = slots.filter((s) => s.link.kind === "pco");
  return { filled: pco.filter((s) => !!s.displayName).length, total: pco.length };
}

/**
 * The one line over the preview, or null when there is nothing to say.
 *
 * Nothing is said while the editor is live: the preview is the kiosk, which is
 * what the page has always shown, and a caption on every screen editor forever
 * is noise.
 *
 * `title` carries the server's reason for an unreachable roster — the sentence
 * an operator needs at 9am is which of the three empty boards this is, and why.
 */
export function previewNote(
  resolution: PreviewResolution,
  planLabel: string,
  serviceTypeName: string | null,
): { text: string; title?: string } | null {
  if (!resolution || resolution.roster === "live") return null;
  if (resolution.roster === "none") {
    const type = serviceTypeName ?? "service type";
    return { text: `Previewing the ${type} default — positions only, no plan` };
  }
  if (resolution.roster === "unavailable") {
    return {
      text: `Previewing ${planLabel} — Planning Center could not be read, so rows show positions only`,
      title: resolution.reason,
    };
  }
  const { filled, total } = positionsFilled(resolution.slots);
  return { text: `Previewing ${planLabel} · ${filled} of ${total} positions filled` };
}

/**
 * The caption itself, in the amber the switcher's `editing` badge uses — the
 * same colour means the same thing in both places: you are not looking at what
 * the screens are showing.
 */
export function SlotsPreviewNote({
  resolution,
  planLabel,
  serviceTypeName,
}: {
  resolution: PreviewResolution;
  planLabel: string;
  serviceTypeName: string | null;
}) {
  const note = previewNote(resolution, planLabel, serviceTypeName);
  if (!note) return null;
  return (
    <span className="text-caption1 text-amber-11" title={note.title} data-slots-preview-note={resolution?.roster}>
      {note.text}
    </span>
  );
}
