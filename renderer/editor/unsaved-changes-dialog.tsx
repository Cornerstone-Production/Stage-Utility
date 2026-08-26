// "You have unsaved work" — asked in one place, for two different exits.
//
// Leaving EDIT MODE already asked. Navigating away — the rail, a link, the
// browser's own Back button — did not, and silently discarded the layout. Both
// are the same question, so they are the same dialog rather than two that drift
// apart in wording and in which buttons they offer.
//
// Cancel comes first and is the safe default. The destructive option is not the
// one your hand lands on.

import { Button, DialogRoot, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "../components/ui";

export function UnsavedChangesDialog({
  open,
  saving,
  description,
  saveLabel,
  onCancel,
  onDiscard,
  onSave,
}: {
  open: boolean;
  saving: boolean;
  description: string;
  /** "Save & close" when leaving edit mode, "Save & leave" when navigating. */
  saveLabel: string;
  onCancel: () => void;
  onDiscard: () => void;
  onSave: () => void;
}) {
  return (
    <DialogRoot
      open={open}
      // Escape and the close button mean "no, stay" — the same as Cancel. A
      // dismissed dialog must never be read as consent to throw work away.
      onOpenChange={(next: boolean) => { if (!next) onCancel(); }}
    >
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Unsaved changes</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="transparent" size="small" onClick={onCancel} disabled={saving}>
            Keep editing
          </Button>
          <Button variant="transparent" size="small" onClick={onDiscard} disabled={saving}>
            Discard
          </Button>
          <Button variant="accent" size="small" onClick={onSave} disabled={saving}>
            {saving ? "Saving…" : saveLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </DialogRoot>
  );
}
