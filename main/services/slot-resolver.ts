// Pure function: merges saved slots + PCO team members + device status.
// No I/O — takes data already fetched and returns resolved Slot[].

import { clamp } from "./clamp.js";
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


/**
 * Coerce a provider's audio level to the documented 0–1 contract.
 *
 * Providers disagree: Shure normalises against its own dB range (Axient −60..0,
 * ULXD −50..0), while the Sennheiser paths pass the device's raw value straight
 * through. So the field arrived as 0–1 from some receivers and as dBFS from
 * others, and the one place that renders it printed `Math.round(v)` followed by
 * "dB" — which could only ever say "0 dB" or "1 dB" for a Shure rig.
 *
 * Normalising here rather than in each provider keeps one definition of the unit,
 * and means a receiver added later cannot quietly reintroduce the mismatch.
 */
export function normaliseAudioLevel(v: number | null | undefined): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  if (v >= 0 && v <= 1) return v; // already normalised
  if (v < 0) return clamp((v + 60) / 60, 0, 1); // dBFS-ish, −60..0
  if (v <= 100) return v / 100; // percentage
  return null; // nothing sensible to make of it
}

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
    audioLevel: normaliseAudioLevel(ds.audioLevel),
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

/** True when a name ends in a "(…)" sub-variant, e.g. "Audio (MON)". */
const hasVariant = (name: string): boolean => /\([^)]*\)$/.test(name);

/**
 * What a CONFIGURED slot position matches on.
 *
 * A base name ("Vocals") is deliberately broad: it matches every sub-variant, so
 * one slot can cover a range and the note picks the person. A name that already
 * NAMES a variant ("Audio (MON)") is not broad — it means that variant.
 *
 * Both used to collapse to the base, so "Audio (MON)" and "Audio (FOH)" were the
 * same query and a MON slot took whichever audio engineer PCO listed first.
 * Adding the FOH slot appeared to fix it only because the two then competed for
 * distinct people and happened to land the right way round.
 */
function positionKey(name: string | null | undefined): string {
  const t = (name ?? "").trim().toLowerCase();
  return hasVariant(t) ? t : normalizePosition(t);
}

/** Does `memberPosition` satisfy a slot configured for `configured`? */
function positionMatches(configured: string | null | undefined, memberPosition: string | null | undefined): boolean {
  const key = positionKey(configured);
  if (!key) return false;
  // An explicitly-named variant is exact; a base name covers its sub-variants.
  return hasVariant(key)
    ? key === (memberPosition ?? "").trim().toLowerCase()
    : normalizePosition(memberPosition) === key;
}

/** Canonical identity of a positions range. Two slots compete for people only when
 *  these are equal — same (position, note) pairs, order-insensitive. Notes are part
 *  of the identity, so "Vocals note 1" and "Vocals note 2" never compete. */
function positionSignature(positions: SlotPositionMatch[]): string {
  return JSON.stringify(
    positions
      .map((p) => [positionKey(p.name), (p.notesStartsWith ?? "").trim().toLowerCase()] as const)
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
/**
 * The configured positions this person is ACTUALLY scheduled for.
 *
 * A slot may accept a range — "EG Ghost or EG Shadow" — but the cell should name
 * only what the person on it is really doing. Showing the whole range told a guitarist
 * scheduled on EG Ghost that they were also on EG Shadow.
 *
 * Someone scheduled twice appears as two team memberships sharing a person id, so a
 * genuine double (vocals AND acoustic) still lists both.
 */
function heldPositions(
  positions: SlotPositionMatch[],
  member: TeamMemberDTO,
  members: TeamMemberDTO[],
): string[] {
  const key = claimKey(member);
  const held = members.filter((m) => claimKey(m) === key).map((m) => m.teamPositionName);
  const named = positions.filter((p) => p.name && p.name.trim());
  // An entry with no position name matches on notes alone, so it names nothing.
  // Uses the same rule as matching, so a label is only shown when the person
  // really holds that position — a "(MON)" label never appears for the FOH tech.
  const shown = named.filter((p) => held.some((h) => positionMatches(p.name, h)));
  if (shown.length > 0) return shown.map((p) => p.name as string);
  // Matched on a note rather than a position, or PCO calls it something the slot
  // does not list. Name what PCO actually says over a configured label the person
  // is not on — the whole point here is to stop the cell claiming the wrong job.
  return member.teamPositionName ? [member.teamPositionName] : [];
}

function matchByPositions(
  positions: SlotPositionMatch[],
  members: TeamMemberDTO[],
  taken: Set<string>,
): TeamMemberDTO | null {
  for (const entry of positions) {
    const wantPos = entry.name && entry.name.trim() ? entry.name : null;
    const prefix = entry.notesStartsWith?.trim().toLowerCase() || null;

    // Neither constraint = a misconfigured entry. Skip it rather than claim the
    // first person on the team.
    if (wantPos === null && prefix === null) continue;

    // A base name groups sub-variants under it ("Vocals" takes "Vocals (BGVs)"),
    // disambiguated by notes; a name that already states a variant means that one.
    const pool = (
      wantPos === null ? members : members.filter((m) => positionMatches(wantPos, m.teamPositionName))
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


/**
 * Vertical resolution to ask PCO for — unchanged from what this always requested,
 * so nothing gets softer than it is today.
 *
 * There is no single ceiling to raise it to: originals are whatever each person
 * uploaded, measured here from 364×364 up to 1000×1000, with a couple that are not
 * even square (716×1000, 1000×750). PCO will happily serve any geometry asked of
 * it, upscaling past the original — so a bigger number costs bytes for everyone and
 * only buys detail for whoever uploaded something larger. 1000 is where real
 * originals top out in practice; if that changes, this is the one knob.
 */
const AVATAR_MAX_PX = 1000;

/** Widest a single column's photo can usefully be, as a fraction of its height.
 *  A 16:9 display split into C columns gives each roughly (16/C)/(9 × 0.87) — the
 *  0.87 being the share of the card the photo occupies above the name plate. The
 *  2.2 rounds that up so a column is never under-served. */
const COLUMN_ASPECT_BUDGET = 2.2;

/** Roughly how much of a slot's height the name/RF card takes. It is sized by the
 *  card's width, so it is a fixed cost per slot — which is why a stacked slot keeps
 *  less than its 1/depth share of the photo. ~110px of a ~1027px card, measured. */
const INFO_CARD_FRACTION = 0.12;

/**
 * Does the caller know the SHAPE of the box that will draw this photo?
 *
 * A standalone slots display does: it is a row of tall columns, and the crop
 * below is modelled on exactly that. Nothing else does. An inline slots-grid on
 * a custom layout is whatever size the operator dragged it to, and a slots View
 * embedded in a dashboard tile is whatever the tile is.
 *
 * PCO's crop is centred and irreversible, so a guess costs pixels that cannot
 * come back. Two goes at guessing:
 *
 *   - crop to the column shape, and a 14-slot grid asked for 0.16 while drawing
 *     0.50 -- 51% of the face's width destroyed before download.
 *   - crop to a floor wide enough for a face (0.35), and a LANDSCAPE cell drew
 *     that portrait strip letterboxed inside it, black bars either side.
 *
 * The second is what "the photos look horrible" was. Both are the same mistake:
 * choosing a crop on the server for a box only the browser can see.
 *
 * So a caller that does not know the shape asks for the whole image and crops
 * nothing. `object-fit: cover` then does all of it, in the one place the real
 * box is known. The display keeps its crop -- its box genuinely IS that shape,
 * so the browser would crop to the same pixels anyway, and the bytes saved are
 * real (4.5 MB -> 1.33 MB per load, measured in 3edc79c).
 */
export type AvatarFit =
  /** The box is a display column of the modelled shape: crop to it. */
  | "column"
  /** The shape is unknown: send the whole image, let the browser crop. */
  | "whole";

/** Columns a view renders: stacked slots share one, so they do not each get a
 *  column's width. Mirrors the grouping the kiosk does with `stackWithPrevious`. */
function columnCount(slots: Slot[]): number {
  const n = slots.filter((s) => !s.stackWithPrevious).length;
  return Math.max(1, n);
}

/**
 * How many slots share each slot's column, by slot index.
 *
 * A stacked column splits its height between its slots, so each one is drawn
 * roughly `depth` times shorter than a full-height slot — and needs a crop that
 * short. Grouping mirrors what the kiosk does with `stackWithPrevious`.
 */
function stackDepths(slots: Slot[]): number[] {
  const columns: number[][] = [];
  slots.forEach((slot, i) => {
    if (slot.stackWithPrevious && columns.length > 0) columns[columns.length - 1].push(i);
    else columns.push([i]);
  });
  const depths = new Array<number>(slots.length).fill(1);
  for (const col of columns) for (const i of col) depths[i] = col.length;
  return depths;
}

/**
 * Ask PCO for the crop this slot will actually display, rather than a square.
 *
 * Slots are tall and narrow, and the kiosk draws them with `object-fit: cover` —
 * so a square source is scaled to fill the height and then cropped hard
 * horizontally. In a 13-slot view roughly 85% of every downloaded image was thrown
 * away, and the fixed 1000px request was itself an upscale of a 960px original.
 * Matching the geometry to the column keeps exactly the pixels that get drawn:
 * ~183 KB per photo instead of ~1093 KB, with nothing visibly different.
 *
 * HEIGHT MATTERS TOO. This asked for a full-height crop for every slot, including
 * the ones in a stacked column that are drawn half as tall. `object-fit: cover`
 * then scaled the too-tall image to the slot's WIDTH and cropped away the excess
 * height — with `object-position: top`, that left a stacked slot showing the top
 * 45% of the photo. Foreheads. Dividing the height by the stack depth asks for the
 * shape that will actually be drawn, and downloads less of it.
 */
export function fitAvatarToColumn(
  url: string | null,
  columns: number,
  stackDepth = 1,
  /** See AvatarFit. Defaults to the display's column crop. */
  fit: AvatarFit = "column",
): string | null {
  if (!url) return null;
  // The whole image, scaled to fit inside the ceiling rather than cropped to it.
  // No `%23`: that is the crop flag, and its absence is what makes PCO return a
  // fit-inside image (see 3edc79c, which fixed the decode bug that had been
  // stripping it by accident).
  if (fit === "whole") {
    const geometry = `${AVATAR_MAX_PX}x${AVATAR_MAX_PX}`;
    return /[?&]g=\d+x\d+(%23|#)?/.test(url)
      ? url.replace(/([?&]g=)\d+x\d+(%23|#)?/, `$1${geometry}`)
      : url + (url.includes("?") ? "&" : "?") + `g=${geometry}`;
  }
  // Not simply height/depth: the info card under the photo is sized by the card's
  // WIDTH, so it costs the same pixels in a half-height slot as a full one. A slot
  // in a 2-stack therefore keeps well under half the photo height, not half.
  // Measured on a real display: full photo 915px, stacked 396px — 0.433, where a
  // naive 1/depth would say 0.5. Modelling the card as a fixed fraction of the slot
  // reproduces that: (1/depth - card) / (1 - card).
  const depth = Math.max(1, stackDepth);
  const share = (1 / depth - INFO_CARD_FRACTION) / (1 - INFO_CARD_FRACTION);
  // A floor keeps a deep stack from asking for a letterbox sliver.
  const height = Math.max(240, Math.round(AVATAR_MAX_PX * Math.max(0, share)));
  const width = Math.min(
    AVATAR_MAX_PX,
    Math.max(
      120, // absurd column count: still legible, whatever the arithmetic says
      Math.ceil((AVATAR_MAX_PX * COLUMN_ASPECT_BUDGET) / columns),
    ),
  );
  const geometry = `${width}x${height}%23`;
  return /[?&]g=\d+x\d+(%23|#)?/.test(url)
    ? url.replace(/([?&]g=)\d+x\d+(%23|#)?/, `$1${geometry}`)
    : url + (url.includes("?") ? "&" : "?") + `g=${geometry}`;
}

export function resolveSlots(
  slots: Slot[],
  members: TeamMemberDTO[],
  deviceStatuses: Map<string, DeviceStatus>,
  /** See AvatarFit: whether the caller knows the shape of the box that will
   *  draw these photos. A display does; nothing else does. */
  avatarFit: AvatarFit = "column",
): Slot[] {
  // How wide each column will be drawn, which sets the avatar crop below.
  const columns = columnCount(slots);
  // Per-slot, because a stacked slot is drawn shorter and needs a shorter crop.
  const depths = stackDepths(slots);

  // Claimed people, keyed by positions-signature. Slots with the same signature
  // compete for distinct people; slots with different signatures are independent,
  // so a player with two devices still appears in both of their slots. Board order
  // is the array order the caller passes.
  const claimed = new Map<string, Set<string>>();

  return slots.map((slot, slotIndex): Slot => {
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
    // The positions to print on the cell — what this person actually holds, not the
    // whole range the slot was configured to accept.
    let shownPositions: string[] | undefined;
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
      if (member) {
        taken.add(claimKey(member));
        shownPositions = heldPositions(link.positions, member, members);
      }
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
      photoUrl: fitAvatarToColumn(member?.photoUrl ?? null, columns, depths[slotIndex] ?? 1, avatarFit),
      shownPositions,
      device,
    };
  });
}
