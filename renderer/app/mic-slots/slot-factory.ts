// New slots and spacers for the Mic slots page.

import { isSpacer } from "./board-model";

const EMPTY_DEVICE: SlotDevice = {
  status: "none",
  rf: null,
  battery: null,
  freq: null,
  audioLevel: null,
  charge: null,
  iemCharge: null,
  label: null,
  iemLabel: null,
};

export function freshSlotId(): string {
  return `slot-${crypto.randomUUID().slice(0, 12)}`;
}

/** The next channel number on a board: one past the highest numeric one, so
 *  deleting and moving slots never leaves two cards on the same number. */
export function nextChannel(slots: readonly Slot[]): string {
  const max = slots.reduce((m, s) => {
    const n = Number.parseInt(s.channel, 10);
    return Number.isFinite(n) ? Math.max(m, n) : m;
  }, 0);
  return String(max + 1).padStart(2, "0");
}

/** A slot that fills by position and names nobody yet. */
export function newSlot(board: readonly Slot[]): Slot {
  return {
    id: freshSlotId(),
    channel: nextChannel(board),
    order: board.length,
    link: { kind: "pco", matchBy: "position", positions: [] },
    deviceBinding: null,
    displayName: null,
    photoUrl: null,
    device: { ...EMPTY_DEVICE },
  };
}

/** A gap between charger banks. */
export function newSpacer(board: readonly Slot[]): Slot {
  return {
    id: freshSlotId(),
    channel: "",
    order: board.length,
    link: { kind: "spacer" },
    widthIn: 2,
    deviceBinding: null,
    displayName: null,
    photoUrl: null,
    device: { ...EMPTY_DEVICE },
  };
}

/**
 * A copy for the inspector's Duplicate: the same arrangement of who fills it, so
 * the "shares people with" note appears and each fills with a different person.
 * The hardware is NOT copied. Two cards bound to one receiver is never what a
 * duplicate is for, and it would be the first thing to undo.
 */
export function duplicateOf(slot: Slot, board: readonly Slot[]): Slot {
  if (isSpacer(slot)) return { ...newSpacer(board), widthIn: slot.widthIn ?? 2 };
  return {
    ...slot,
    id: freshSlotId(),
    channel: nextChannel(board),
    deviceBinding: null,
    deviceLabel: null,
    iemBinding: null,
    iemLabel: null,
    chargeBayId: null,
    chargeSource: slot.chargeSource === "charger" ? "mic" : slot.chargeSource,
    stackWithPrevious: undefined,
    displayName: null,
    photoUrl: null,
    device: { ...EMPTY_DEVICE },
  };
}
