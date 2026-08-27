// canvas-row-fit.ts — how the editor's canvas row behaves in the column above it.
//
// The row holds the canvas and the side panel. It sits in a flex COLUMN whose
// height the console shell caps at the window, and the class it carries decides
// what flexbox does when that column runs out of room.
//
// Nothing is selected, or something that is not an inline slots-grid: the row
// takes the leftover height, so the side panel can use the full window and
// scroll inside itself.
//
// An INLINE slots-grid is selected: the InlineSlotsEditor mounts below the row
// with roughly 1950px of content, so the column overflows by more than the
// window is tall. Flexbox pays for an overflowing column by shrinking its
// items, and the row's `min-h-0` — which the other case needs, so the side
// panel can scroll inside it — removes the floor that would otherwise stop it.
// Left shrinkable, the row collapses to ZERO height while the canvas cell
// inside keeps the explicit pixel height it was measured to, and the canvas
// draws 475px tall out of a 0px-tall row, on top of the slots editor.
//
// Measured in a real browser at 1440x900, console route, an inline slots-grid
// selected -- row 0px tall, canvas overflowing it by 463px and covering the
// editor below; with the row told not to shrink, row 475px, slots editor pushed
// to its proper place, overlap gone. It was reported as the mic-slots object
// rendering behind everything, and only ever when that object was the selected
// one -- selecting anything else made `inlineGrid` null, the row went back to
// `flex-1`, and the page looked normal again.

/**
 * The flex class for the editor's canvas row.
 *
 * `inlineGridSelected` is whether the current selection is a single inline
 * slots-grid object — the case that mounts the InlineSlotsEditor beneath the
 * row and overflows the column.
 */
export function canvasRowFlexClass(inlineGridSelected: boolean): string {
  // Not `""`. An unset shrink is shrink:1, which is the bug.
  return inlineGridSelected ? "shrink-0" : "flex-1";
}
