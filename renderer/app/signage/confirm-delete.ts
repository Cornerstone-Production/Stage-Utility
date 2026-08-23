// confirm-delete.ts — "are you sure", once.
//
// Five copies of the same four lines across the signage sections, each spelling
// out the same title shape, the same confirm label and the same `destructive`
// flag. What differs between them is only the MESSAGE — what deleting this
// particular thing costs — which is the part worth writing by hand every time.
//
// This is the repo's own rule applied to itself: if the same shape exists in
// three places, remove the duplication rather than fixing it three times.

import { confirm } from "../../components/ui/confirm-dialog";

/**
 * Ask before deleting a named thing.
 *
 * `message` says what it COSTS, not what the operator is about to do — they can
 * see that. "Screens it was driving fall through to whatever is next" is the
 * useful sentence; "this cannot be undone" is not.
 */
export function confirmDelete(name: string, message: string): Promise<boolean> {
  return confirm({
    title: `Delete ${name}?`,
    message,
    confirmLabel: "Delete",
    destructive: true,
  });
}
