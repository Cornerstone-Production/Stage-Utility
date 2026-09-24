// channel-color.ts — Stable per-channel color + label for transcript lines, so
// the full-screen captions view, the compact dashboard/stage strips, the layout
// object and the Transcription colors panel all agree on who's speaking and
// what color represents them.
//
// ProdCom DOES send a color per channel (`GET /api/v1/channels`, verified
// against 2.3.2 — an earlier version of this file's own comment claimed it did
// not) — but it reuses them: on the real box five channels share one hex and
// six share another. So resolveChannelColor() below is the one place every
// caption's color is decided, and ProdCom's color is only ONE of three inputs,
// used only when the operator has opted into it.

const CHANNEL_COLORS = ["#e6e6ea", "#7fe3c4", "#f0c060", "#9db8ff", "#f0a0c0", "#b9e08a"];

/** Deterministic color for a channel id (same channel → same color everywhere).
 *  The DEFAULT — distinct per channel, unlike ProdCom's own repeated colors. */
export function channelColor(channel: string | null): string {
  if (!channel) return CHANNEL_COLORS[0];
  let h = 0;
  for (let i = 0; i < channel.length; i++) h = (h * 31 + channel.charCodeAt(i)) >>> 0;
  return CHANNEL_COLORS[h % CHANNEL_COLORS.length];
}

/**
 * THE shared color decision. Every caption color in the app — the full
 * transcription view, the compact dashboard/stage strips, the transcript-strip
 * layout object, and the Transcription colors panel's own swatches — resolves
 * through this, so there is exactly one place to get it right and one place
 * that changes when the rule does.
 *
 * Priority, and why: a CUSTOM pick (`customColors`, keyed by channel label) is
 * the operator overriding something specific and always wins. Failing that,
 * ProdCom's OWN color is used only when `followProdcom` is on — off by default,
 * because ProdCom repeats colors across channels and the distinct auto color
 * is more useful until the operator asks for ProdCom's own palette. Failing
 * both, the deterministic AUTO color never fails — it needs nothing from
 * either side.
 */
export function resolveChannelColor(params: {
  /** ProdCom's channel id, for the deterministic auto color. */
  channel: string | null;
  /** Key into `customColors` — the channel's current display label. */
  label: string | null;
  /** ProdCom's own color for this channel, if it sent one. */
  prodcomColor: string | null;
  /** The operator's "Follow ProdCom's channel colors" setting. */
  followProdcom: boolean;
  /** User-assigned colors keyed by channel label (Settings). */
  customColors?: Record<string, string> | null;
}): string {
  const { channel, label, prodcomColor, followProdcom, customColors } = params;
  if (label && customColors?.[label]) return customColors[label];
  if (followProdcom && prodcomColor) return prodcomColor;
  return channelColor(channel);
}

/** Color for a transcript line — resolveChannelColor() with a line's own
 *  fields as the channel/label/ProdCom-color inputs. */
export function lineColor(
  line: { color?: string | null; channel: string | null; channelName?: string | null },
  overrides?: Record<string, string> | null,
  followProdcom = false,
): string {
  return resolveChannelColor({
    channel: line.channel,
    label: line.channelName ?? line.channel ?? null,
    prodcomColor: line.color ?? null,
    followProdcom,
    customColors: overrides,
  });
}

/** Human label for a line's speaker/channel, or null when unknown. */
export function channelLabel(line: { channelName: string | null; channel: string | null }): string | null {
  return line.channelName ?? line.channel ?? null;
}

/** One channel worth showing: a label, the ProdCom id behind it (for the
 *  deterministic auto color and for re-resolving its own color), and
 *  ProdCom's own color for it, if known. */
export interface ChannelRow {
  label: string;
  channelId: string | null;
  prodcomColor: string | null;
}

/**
 * Every channel worth showing: every channel ProdCom's own list has, plus any
 * channel that has SPOKEN but is missing from that list (seen before this
 * connection's channel list loaded), plus any channel with a SAVED custom
 * color that is in neither (e.g. renamed or removed in ProdCom since).
 *
 * ProdCom's list is the base specifically so a channel that has never spoken —
 * most of a 17-channel box on any given Sunday — still gets a row. Keyed by
 * LABEL, matching how captionChannelColors itself is keyed, so a rename in
 * ProdCom does not silently orphan a saved pick's row from the channel it was
 * ever meant to color.
 *
 * Shared by the Transcription colors panel and the layout editor's
 * transcript-strip channel picker — both need "every channel that could ever
 * need a decision made about it", not just the ones ProdCom happens to be
 * reporting live right now.
 */
export function mergeChannels(
  channels: ProdcomChannelDTO[],
  lines: TranscriptLineDTO[],
  saved: Record<string, string>,
): ChannelRow[] {
  const rows = new Map<string, ChannelRow>();
  for (const c of channels) {
    const label = c.name ?? c.id;
    if (label) rows.set(label, { label, channelId: c.id, prodcomColor: c.color });
  }
  for (const l of lines) {
    const label = l.channelName ?? l.channel;
    if (label && !rows.has(label)) rows.set(label, { label, channelId: l.channel, prodcomColor: l.color ?? null });
  }
  for (const label of Object.keys(saved)) {
    if (!rows.has(label)) rows.set(label, { label, channelId: null, prodcomColor: null });
  }
  return [...rows.values()].sort((a, b) => a.label.localeCompare(b.label));
}
