// channel-color.ts — Stable per-channel color + label for transcript lines, so
// the full-screen captions view and the compact dashboard/stage strips all agree
// on who's speaking and what color represents them.

const CHANNEL_COLORS = ["#e6e6ea", "#7fe3c4", "#f0c060", "#9db8ff", "#f0a0c0", "#b9e08a"];

/** Deterministic color for a channel id (same channel → same color everywhere). */
export function channelColor(channel: string | null): string {
  if (!channel) return CHANNEL_COLORS[0];
  let h = 0;
  for (let i = 0; i < channel.length; i++) h = (h * 31 + channel.charCodeAt(i)) >>> 0;
  return CHANNEL_COLORS[h % CHANNEL_COLORS.length];
}

/** Color for a transcript line. Priority: a user-assigned color for the channel
 *  label (from Settings) → a ProdCom-provided color → the deterministic per-
 *  channel color. */
export function lineColor(
  line: { color?: string | null; channel: string | null; channelName?: string | null },
  overrides?: Record<string, string> | null,
): string {
  const label = line.channelName ?? line.channel ?? null;
  if (overrides && label && overrides[label]) return overrides[label];
  return line.color ?? channelColor(line.channel);
}

/** Human label for a line's speaker/channel, or null when unknown. */
export function channelLabel(line: { channelName: string | null; channel: string | null }): string | null {
  return line.channelName ?? line.channel ?? null;
}
