// Pure function: merges saved slots + PCO team members + device status.
// No I/O — takes data already fetched and returns resolved Slot[].

import type { Slot, SlotDevice, TeamMemberDTO } from "../types/stage.js";
import type { DeviceStatus } from "../types/devices.js";

const EMPTY_DEVICE: SlotDevice = {
  status: "none",
  rf: null,
  battery: null,
  freq: null,
  audioLevel: null,
};

function deviceStatusToSlotDevice(ds: DeviceStatus): SlotDevice {
  if (!ds.online) {
    return { status: "error", rf: null, battery: null, freq: ds.frequencyLabel, audioLevel: null };
  }
  let status: SlotDevice["status"] = "ok";
  if (ds.rfBars !== null && ds.rfBars <= 1) status = "warn";
  if (ds.battery !== null && ds.battery <= 20) status = "warn";
  if (ds.battery !== null && ds.battery <= 5) status = "error";
  return {
    status,
    rf: ds.rfBars,
    battery: ds.battery,
    freq: ds.frequencyLabel,
    audioLevel: ds.audioLevel,
  };
}

function matchMember(
  slot: Slot,
  members: TeamMemberDTO[],
): TeamMemberDTO | null {
  const { link } = slot;
  if (link.kind !== "pco") return null;

  if (link.matchBy === "person") {
    return members.find((m) => m.personId === link.personId) ?? null;
  }

  if (link.matchBy === "position") {
    // Case-insensitive position name match.
    const pos = link.teamPositionName.toLowerCase();
    const prefix = link.notesStartsWith?.toLowerCase() ?? null;

    const byPosition = members.filter(
      (m) => (m.teamPositionName ?? "").toLowerCase() === pos,
    );

    if (prefix && byPosition.length > 0) {
      // Further filter by notes prefix (case-insensitive).
      // First char = number 1-10 for vocals; first two chars = HH/HS for Teaching Pastor.
      const withNotes = byPosition.filter(
        (m) => m.notes != null && m.notes.toLowerCase().startsWith(prefix),
      );
      // Fall back to any position match if no notes match (graceful degradation).
      return (withNotes[0] ?? byPosition[0]) ?? null;
    }

    return byPosition[0] ?? null;
  }

  return null;
}

export function resolveSlots(
  slots: Slot[],
  members: TeamMemberDTO[],
  deviceStatuses: Map<string, DeviceStatus>,
): Slot[] {
  return slots.map((slot): Slot => {
    // Empty slots: no display name, no photo, no PCO lookup.
    if (slot.link.kind === "empty") {
      return { ...slot, displayName: null, photoUrl: null, device: EMPTY_DEVICE };
    }

    // Static slots keep their label and color; no PCO lookup.
    if (slot.link.kind === "static") {
      let device = EMPTY_DEVICE;
      if (slot.deviceBinding) {
        const ds = deviceStatuses.get(slot.deviceBinding.channelId);
        if (ds) device = deviceStatusToSlotDevice(ds);
      }
      return { ...slot, device };
    }

    // PCO-linked slots.
    const member = matchMember(slot, members);
    let device = EMPTY_DEVICE;
    if (slot.deviceBinding) {
      const ds = deviceStatuses.get(slot.deviceBinding.channelId);
      if (ds) device = deviceStatusToSlotDevice(ds);
    }

    return {
      ...slot,
      displayName: member?.name ?? null,
      photoUrl: member?.photoUrl ?? null,
      device,
    };
  });
}
