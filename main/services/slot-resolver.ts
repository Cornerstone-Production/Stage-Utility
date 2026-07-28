// Pure function: merges saved slots + PCO team members + device status.
// No I/O — takes data already fetched and returns resolved Slot[].

import type { Slot, SlotDevice, SlotPositionMatch, TeamMemberDTO } from "../types/stage.js";
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
  if (!ds.online) {
    return { status: "error", rf: null, battery: null, freq: ds.frequencyLabel, audioLevel: null, charge: null, iemCharge: null, label: null, iemLabel: null };
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

// Resolve the IEM/PSM pack battery for a slot's optional second (live) device
// binding. Any slot may carry an IEM (vocalist, musician, etc.); independent of
// the primary mic; only shows while that device is online. (Offline IEM labels
// are separate — see slot.iemLabel.)
function resolveIem(slot: Slot, deviceStatuses: Map<string, DeviceStatus>): number | null {
  if (!slot.iemBinding) return null;
  const ds = deviceStatuses.get(slot.iemBinding.channelId);
  return ds && ds.online ? ds.battery : null;
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

/** Canonical identity of a positions range. Two slots compete for people only when
 *  these are equal — same (position, note) pairs, order-insensitive. Notes are part
 *  of the identity, so "Vocals note 1" and "Vocals note 2" never compete. */
function positionSignature(positions: SlotPositionMatch[]): string {
  return JSON.stringify(
    positions
      .map((p) => [normalizePosition(p.name), (p.notesStartsWith ?? "").trim().toLowerCase()] as const)
      .sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0]))),
  );
}

/** Claim key for a team member. Person-level where PCO gives us a person id, so
 *  someone scheduled in two positions still only fills one of a set of identical
 *  slots; falls back to the team-member row id when it doesn't. */
function claimKey(m: TeamMemberDTO): string {
  return m.personId ?? m.id;
}

/** First unclaimed person matching any entry, entries tried in configured order.
 *  `taken` holds people already claimed by slots with the SAME signature. */
function matchByPositions(
  positions: SlotPositionMatch[],
  members: TeamMemberDTO[],
  taken: Set<string>,
): TeamMemberDTO | null {
  for (const entry of positions) {
    const wantPos = entry.name && entry.name.trim() ? normalizePosition(entry.name) : null;
    const prefix = entry.notesStartsWith?.trim().toLowerCase() || null;

    // Neither constraint = a misconfigured entry. Skip it rather than claim the
    // first person on the team.
    if (wantPos === null && prefix === null) continue;

    // Match on the normalized position so sub-variants group with their base
    // (e.g. "Vocals (BGVs)" → "Vocals"), disambiguated by notes.
    const pool = (
      wantPos === null ? members : members.filter((m) => normalizePosition(m.teamPositionName) === wantPos)
    ).filter((m) => !taken.has(claimKey(m)));

    if (prefix) {
      // A notes prefix pins this entry to a specific person (e.g. "1".."10" for
      // vocals, "HS"/"HH" for Teaching Pastor). Require an actual notes match — do
      // NOT fall back to an arbitrary person in the position, or every unmatched
      // slot would duplicate the first member and appear to ignore the note (e.g.
      // the HH slot showing the HS pastor).
      const matches = pool.filter(
        (m) => m.notes != null && m.notes.trim().toLowerCase().startsWith(prefix),
      );
      // Prefer an exact note match so "1" doesn't grab "10"; else the first prefix
      // match (handles notes like "1 - lead vocal").
      const hit = matches.find((m) => m.notes!.trim().toLowerCase() === prefix) ?? matches[0];
      if (hit) return hit;
      continue;
    }

    if (pool[0]) return pool[0];
  }
  return null;
}

export function resolveSlots(
  slots: Slot[],
  members: TeamMemberDTO[],
  deviceStatuses: Map<string, DeviceStatus>,
): Slot[] {
  // Claimed people, keyed by positions-signature. Slots with the same signature
  // compete for distinct people; slots with different signatures are independent,
  // so a player with two devices still appears in both of their slots. Board order
  // is the array order the caller passes.
  const claimed = new Map<string, Set<string>>();

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
      device = {
        ...device,
        charge: resolveCharge(slot, device, deviceStatuses),
        iemCharge: resolveIem(slot, deviceStatuses),
        // Per-slot offline labels ("" = Offline picked but unlabeled → still a pill).
        label: slot.deviceLabel ?? null,
        iemLabel: slot.iemLabel ?? null,
      };
      return { ...slot, device };
    }

    // PCO-linked slots.
    const { link } = slot;
    let member: TeamMemberDTO | null = null;
    if (link.kind === "pco" && link.matchBy === "person") {
      member = members.find((m) => m.personId === link.personId) ?? null;
    } else if (link.kind === "pco" && link.matchBy === "position") {
      const sig = positionSignature(link.positions);
      let taken = claimed.get(sig);
      if (!taken) {
        taken = new Set<string>();
        claimed.set(sig, taken);
      }
      member = matchByPositions(link.positions, members, taken);
      if (member) taken.add(claimKey(member));
    }

    let device = EMPTY_DEVICE;
    if (slot.deviceBinding) {
      const ds = deviceStatuses.get(slot.deviceBinding.channelId);
      if (ds) device = deviceStatusToSlotDevice(ds);
    }
    device = {
      ...device,
      charge: resolveCharge(slot, device, deviceStatuses),
      iemCharge: resolveIem(slot, deviceStatuses),
      // Per-slot offline labels ("" = Offline picked but unlabeled → still a pill).
      label: slot.deviceLabel ?? null,
      iemLabel: slot.iemLabel ?? null,
    };

    return {
      ...slot,
      displayName: member?.name ?? null,
      photoUrl: member?.photoUrl ?? null,
      device,
    };
  });
}
