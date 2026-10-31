// button-press-sheet.tsx — "what this tile presses", for a Button on Home.
//
// Home has no inspector, so a Button on it was never bindable. The card menu's
// Presses…, and a tap on an unset tile, open this sheet: the same Label and the
// same three choices as the layout inspector, drawn by the same component
// (editor/button-presses.tsx), so the two cannot drift.
//
// Companion and App action write the tile's own command the moment a pick is made,
// owned by this tile on view `"home"`; Save then stores the tile's new config on
// Home. Cancel stores nothing about the TILE, but it does not take back a command
// already written: the tile then presses what it pressed before, and the command made
// for the abandoned pick stays, owned by the tile, and is rewritten in place by the
// next pick (it is looked up by its owner). Save waits for any write still running, so
// the tile is never stored without the command it was just given.

import { useRef, useState } from "react";

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
  cards,
  onSave,
  onClose,
}: {
  card: LayoutObject;
  /** Every card on Home as it stands now, for a Button copied and not yet saved. */
  cards: readonly LayoutObject[];
  /** The card with its new config, for Home to store. */
  onSave: (next: LayoutObject) => void;
  onClose: () => void;
}) {
  const [draft, setDraftState] = useState<CueButtonConfig>(() => buttonConfigOf(card) ?? { type: "cue-button", cue: "" });
  // Read by Save after it has waited for a write, which binds the draft from a promise: the ref is
  // current at once, where the state is only current after the next render.
  const draftNow = useRef(draft);
  const setDraft = (next: CueButtonConfig) => {
    draftNow.current = next;
    setDraftState(next);
  };
  const settle = useRef<(() => Promise<void>) | null>(null);
  const [saving, setSaving] = useState(false);
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
              onChange={(e) => setDraft({ ...draftNow.current, label: e.target.value })}
            />
          </label>
          <ButtonPresses
            owner={{ viewId: HOME_VIEW_ID, objectId: card.id }}
            where="Home"
            c={draft}
            cues={cues}
            onConfig={(next) => setDraft(next as CueButtonConfig)}
            settleRef={settle}
            draftObjects={cards}
          />
        </div>
        <DialogFooter>
          <Button variant="transparent" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="filled"
            disabled={saving}
            onClick={async () => {
              setSaving(true);
              await settle.current?.();
              onSave({ ...card, config: draftNow.current });
            }}
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </DialogRoot>
  );
}
