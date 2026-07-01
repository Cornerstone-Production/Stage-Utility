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
  charge: null,
  iemCharge: null,
  label: null,
  iemLabel: null,
};

function deviceStatusToSlotDevice(ds: DeviceStatus): SlotDevice {
  // An offline/manual device (a networkless PSM/mic) is EXPECTED to be offline —
  // render its name as a calm label (status "none"), not a red error like a real
  // device that dropped off the network.
  const manual = ds.deviceType === "manual";
  if (!ds.online) {
    return {
      status: manual ? "none" : "error",
      rf: null,
      battery: null,
      freq: manual ? null : ds.frequencyLabel,
      audioLevel: null,
      charge: null,
      iemCharge: null,
      label: manual ? ds.name : null,
      iemLabel: null,
    };
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
    charge: ds.battery,
    iemCharge: null,
    label: null,
    iemLabel: null,
  };
}

// Resolve the IEM/PSM pack battery for a slot's optional second device binding.
// IEM packs are a vocalist thing, so this only resolves for vocal slots; other
// roles never get a second bar even if an iemBinding lingers. Independent of the
// primary mic; only shows while that device is online.
// Resolve the IEM's second bar (live battery) AND a static label for an offline/
// manual IEM. A live pack shows its battery %; an offline/manual pack (or a
// per-slot label override) shows a headphones-icon label with no bar.
function resolveIem(
  slot: Slot,
  deviceStatuses: Map<string, DeviceStatus>,
  isVocal: boolean,
): { battery: number | null; label: string | null } {
  if (!isVocal || !slot.iemBinding) return { battery: null, label: null };
  const override = slot.iemLabel?.trim() || null;
  const ds = deviceStatuses.get(slot.iemBinding.channelId);
  if (ds && ds.online) return { battery: ds.battery, label: null };
  const manualName = ds && ds.deviceType === "manual" ? (ds.name ?? null) : null;
  return { battery: null, label: override ?? manualName };
}

// A slot counts as a vocalist when its (configured or matched) position is a
// "Vocals" role — "Vocals", "Vocals (BGVs)", "Lead Vocal", etc.
function isVocalPosition(name: string | null | undefined): boolean {
  return normalizePosition(name).includes("vocal");
}

// Resolve the charge-bar level for a slot from its configured source. Defaults
// to the bound mic's battery (current behavior); "charger" reads a chosen SBC
// bay (independent of any bound mic); "off" hides the charge bar.
function resolveCharge(
  slot: Slot,
  device: SlotDevice,
  deviceStatuses: Map<string, DeviceStatus>,
): number | null {
  const src = slot.chargeSource ?? "mic";
  if (src === "off") return null;
  if (src === "charger") {
    if (!slot.chargeBayId) return null;
    const bay = deviceStatuses.get(slot.chargeBayId);
    return bay && bay.online ? bay.battery : null;
  }
  return device.battery; // "mic"
}

// Normalize a PCO team-position name so sub-variants group with their base:
// a trailing parenthetical is dropped, e.g. "Vocals (BGVs)" → "vocals". This
// lets a BGV (or any "Vocals (…)" role) fill the shared "Vocals" note slots.
function normalizePosition(name: string | null | undefined): string {
  return (name ?? "").replace(/\s*\([^)]*\)\s*$/, "").trim().toLowerCase();
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
    // Match on the normalized position so sub-variants group with their base
    // (e.g. "Vocals (BGVs)" → "Vocals"), disambiguated by notes.
    const pos = normalizePosition(link.teamPositionName);
    const prefix = link.notesStartsWith?.trim().toLowerCase() ?? null;

    const byPosition = members.filter(
      (m) => normalizePosition(m.teamPositionName) === pos,
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
    // Spacers + empty slots: no display name, no photo, no PCO lookup.
    if (slot.link.kind === "spacer" || slot.link.kind === "empty") {
      return { ...slot, displayName: null, photoUrl: null, device: EMPTY_DEVICE };
    }

    // Static slots keep their label and color; no PCO lookup.
    if (slot.link.kind === "static") {
      let device = EMPTY_DEVICE;
      if (slot.deviceBinding) {
        const ds = deviceStatuses.get(slot.deviceBinding.channelId);
        if (ds) device = deviceStatusToSlotDevice(ds);
      }
      const iem = resolveIem(slot, deviceStatuses, false);
      const deviceLabel = slot.deviceLabel?.trim() || null;
      device = {
        ...device,
        charge: resolveCharge(slot, device, deviceStatuses),
        iemCharge: iem.battery,
        label: device.label !== null ? (deviceLabel ?? device.label) : null,
        iemLabel: iem.label,
      };
      return { ...slot, device };
    }

    // PCO-linked slots.
    const member = matchMember(slot, members);
    let device = EMPTY_DEVICE;
    if (slot.deviceBinding) {
      const ds = deviceStatuses.get(slot.deviceBinding.channelId);
      if (ds) device = deviceStatusToSlotDevice(ds);
    }
    // Vocalist if the slot is configured as a Vocals position, or the matched
    // member's position is a vocal role (covers person-matched vocalists too).
    const isVocal =
      (slot.link.kind === "pco" &&
        slot.link.matchBy === "position" &&
        isVocalPosition(slot.link.teamPositionName)) ||
      isVocalPosition(member?.teamPositionName);
    const iem = resolveIem(slot, deviceStatuses, isVocal);
    const deviceLabel = slot.deviceLabel?.trim() || null;
    device = {
      ...device,
      charge: resolveCharge(slot, device, deviceStatuses),
      iemCharge: iem.battery,
      label: deviceLabel ?? device.label,
      iemLabel: iem.label,
    };

    return {
      ...slot,
      displayName: member?.name ?? null,
      photoUrl: member?.photoUrl ?? null,
      device,
    };
  });
}
