// The line over a Mic slots preview that says which week's people are on it.
//
// The preview resolves the board being EDITED against that plan's roster
// (use-board-preview.ts), and "no names" has three causes that look identical in
// the rows — a default board has no week, a plan can have nobody scheduled yet,
// and Planning Center can be unreachable. An operator has to be able to tell which
// one they are looking at before they judge the board.

import { namedType } from "./slots-target-pill";

/**
 * Rows for the preview, and whose roster filled them. Null means "show the
 * kiosk" — nothing resolved yet.
 */
export type PreviewResolution = SlotsPreviewDTO | null;

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
    // `namedType` and not "the ${name}": some Planning Center type names open
    // with an article, and "the The Gathering default" is a real one.
    return { text: `Previewing ${namedType(serviceTypeName)} default — positions only, no plan` };
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
