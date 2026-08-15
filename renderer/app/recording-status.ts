// Recording and SPL, judged once.
//
// Home's live panel and the context bar's recording item both need the same
// answer to "are we getting this?", and they render it differently — a stat tile
// and a compact strip. Shared LOGIC, separate rendering: a second copy of the
// connected-but-stopped judgement is a second place for the same bug.

/** Is anything actually recording, and what should it say?
 *
 *  Two recorders, either of which counts. They are reported TOGETHER because the
 *  question mid-service is "are we getting this?", not "what is OBS doing" - and
 *  a panel that showed only one would read as reassurance while the other sat
 *  stopped. Disconnected is not the same as not recording, and says so. */
export function recordingStat(
  obs: { connected: boolean; recording: boolean; recordTimecode: string | null } | null,
  reaper: { connected: boolean; recording: boolean } | null,
): { value: string; sub: string; tone?: "danger" | "live" } {
  const wired = [obs?.connected && "OBS", reaper?.connected && "REAPER"].filter(Boolean) as string[];
  if (wired.length === 0) return { value: "—", sub: "no recorder connected" };

  const rolling = [obs?.recording && "OBS", reaper?.recording && "REAPER"].filter(Boolean) as string[];
  if (rolling.length === 0) {
    // Connected but not rolling, mid-service, is worth noticing.
    return { value: "stopped", sub: `${wired.join(" + ")} connected`, tone: "danger" };
  }
  return {
    value: obs?.recordTimecode ?? "recording",
    sub: rolling.join(" + "),
    tone: "live",
  };
}

/** The loudest current SPL reading across every meter, which is the number
 *  anyone glancing at Home actually wants. Prefers Smaart's A-weighted slow
 *  metric and falls back to whatever the meter reports, since the metric names
 *  come from Smaart verbatim and vary by configuration. */
export function loudestSpl(spl: { connected: boolean; meters: Record<string, { metrics: Record<string, number> }> } | null): { value: string; sub: string } {
  if (!spl?.connected) return { value: "—", sub: "Smaart offline" };
  let best: number | null = null;
  let bestName = "";
  for (const [key, meter] of Object.entries(spl.meters ?? {})) {
    const entries = Object.entries(meter.metrics ?? {});
    if (!entries.length) continue;
    const preferred = entries.find(([k]) => /SPL\s*A/i.test(k)) ?? entries[0];
    if (best == null || preferred[1] > best) {
      best = preferred[1];
      bestName = key.split("::").pop() ?? key;
    }
  }
  if (best == null) return { value: "—", sub: "no readings yet" };
  return { value: `${Math.round(best)} dB`, sub: bestName };
}
