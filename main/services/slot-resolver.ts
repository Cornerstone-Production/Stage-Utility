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
    const prefix = link.notesStartsWith?.trim().toLowerCase() ?? null;

    const byPosition = members.filter(
      (m) => (m.teamPositionName ?? "").toLowerCase() === pos,
    );

    if (prefix) {
      // A notes prefix pins this slot to a specific person within the position
      // (e.g. "1".."10" for vocals, "HS"/"HH" for Teaching Pastor). Require an
      // actual notes match — do NOT fall back to an arbitrary person in the
      // position, or every unmatched slot would duplicate the first member and
      // appear to ignore the note (e.g. the HH slot showing the HS pastor).
      const matches = byPosition.filter(
        (m) => m.notes != null && m.notes.trim().toLowerCase().startsWith(prefix),
      );
      // Prefer an exact note match so "1" doesn't grab "10"; else the first
      // prefix match (handles notes like "1 - lead vocal").
      const exact = matches.find((m) => m.notes!.trim().toLowerCase() === prefix);
      return exact ?? matches[0] ?? null;
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
