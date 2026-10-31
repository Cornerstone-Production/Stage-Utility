// button-press-sheet.tsx — "what this tile presses", for a Button on Home.
//
// Home has no inspector, so a Button on it was never bindable. The card menu's
// Presses…, and a tap on an unset tile, open this sheet: the same Label and the
// same three choices as the layout inspector, drawn by the same component
// (editor/button-presses.tsx), so the two cannot drift.
//
// Companion and App action write the tile's own command the moment a pick is made,
// owned by this tile on view `"home"`; Save then stores the tile's new config on
// Home. Cancel leaves the tile as it was, and a command already written is found
// again by the next pick, because it is looked up by its owner.

import { useState } from "react";

import { HOME_VIEW_ID } from "@main/services/home-view";
import type { LayoutObject, LayoutObjectConfig } from "@main/types/views";

import { Button, DialogContent, DialogFooter, DialogHeader, DialogRoot, DialogTitle, Input } from "../../components/ui";
import { ButtonPresses, type CueButtonConfig } from "../../editor/button-presses";
import { useCueLive } from "../../main/use-cue-live";

/** The Button config of a card, or null when it is not a Button. */
export function buttonConfigOf(card: LayoutObject): CueButtonConfig | null {
  const c = card.config as LayoutObjectConfig;
  return c.type === "cue-button" ? c : null;
}

export function ButtonPressSheet({
  card,
  onSave,
  onClose,
}: {
  card: LayoutObject;
  /** The card with its new config, for Home to store. */
  onSave: (next: LayoutObject) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<CueButtonConfig>(() => buttonConfigOf(card) ?? { type: "cue-button", cue: "" });
  const cues = useCueLive(true);
  return (
    <DialogRoot open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[85vh] max-w-md flex-col overflow-y-auto">
        <DialogHeader>
          <DialogTitle>What this tile presses</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3.5">
          <label className="flex flex-col gap-1.5">
            <span className="text-caption1 font-medium text-fg-muted">Label</span>
            <Input
              aria-label="Label"
              value={draft.label ?? ""}
              placeholder="Uses the name of what it presses"
              onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))}
            />
          </label>
          <ButtonPresses
            owner={{ viewId: HOME_VIEW_ID, objectId: card.id }}
            where="Home"
            c={draft}
            cues={cues}
            onConfig={(next) => setDraft(next as CueButtonConfig)}
          />
        </div>
        <DialogFooter>
          <Button variant="transparent" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="filled" onClick={() => onSave({ ...card, config: draft })}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </DialogRoot>
  );
}
