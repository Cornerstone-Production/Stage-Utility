// Recording and SPL, judged once.
//
// Home's live panel and the context bar's recording item both need the same
// answer to "are we getting this?", and they render it differently — a stat tile
// and a compact strip. Shared LOGIC, separate rendering: a second copy of the
// connected-but-stopped judgement is a second place for the same bug.

/**
 * One thing that can be recording.
 *
 * A LIST, not two arguments. "Are we getting this?" is a question about every
 * recorder at once, and the answer must not need a new parameter each time
 * another integration learns to record — adding one is now a single entry in
 * `recorders()` below, and every surface that asks the question updates with it.
 */
export interface Recorder {
  /** How it is named to the operator: "OBS", "REAPER". */
  name: string;
  connected: boolean;
  recording: boolean;
  /** Elapsed time, when the recorder reports one. */
  timecode?: string | null;
}

/**
 * Every recorder the app knows about, from the live state.
 *
 * THE place a new recording integration is added. One entry here and the Home
 * widget, the context bar and anything else asking the question all cover it.
 */
export function recorders(
  obs: { connected: boolean; recording: boolean; recordTimecode: string | null } | null,
  reaper: { connected: boolean; recording: boolean; positionString?: string | null } | null,
): Recorder[] {
  return [
    { name: "OBS", connected: !!obs?.connected, recording: !!obs?.recording, timecode: obs?.recordTimecode ?? null },
    // REAPER reports the transport position rather than a record timer, and while
    // it is rolling that IS how far into the take you are. Same source the REAPER
    // status object's `showPosition` uses, so the two cannot disagree.
    { name: "REAPER", connected: !!reaper?.connected, recording: !!reaper?.recording, timecode: reaper?.positionString ?? null },
  ];
}

/** Is anything actually recording, and what should it say?
 *
 *  Every recorder counts. They are reported TOGETHER because the question
 *  mid-service is "are we getting this?", not "what is OBS doing" - and a panel
 *  that showed only one would read as reassurance while the other sat stopped.
 *  Disconnected is not the same as not recording, and says so. */
export function recordingStat(
  list: readonly Recorder[],
): { value: string; sub: string; tone?: "danger" | "live" } {
  const wired = list.filter((r) => r.connected);
  if (wired.length === 0) return { value: "—", sub: "no recorder connected" };

  const rolling = wired.filter((r) => r.recording);
  if (rolling.length === 0) {
    // Connected but not rolling, mid-service, is worth noticing.
    return { value: "STOPPED", sub: `${wired.map((r) => r.name).join(" + ")} connected`, tone: "danger" };
  }
  return {
    // A timecode from whichever rolling recorder reports one; the word otherwise.
    value: rolling.find((r) => r.timecode)?.timecode ?? "RECORDING",
    sub: rolling.map((r) => r.name).join(" + "),
    tone: "live",
  };
}

/**
 * One named recorder, on its own.
 *
 * The word first and in colour — "recording" green, "stopped" red — because
 * mid-service the answer is a state, not a duration, and a timecode reads as
 * fine at a glance whether or not it is moving. The elapsed time goes underneath
 * where it belongs: confirmation, not the headline.
 */
export function recorderStat(r: Recorder | undefined): { value: string; sub: string; tone?: "danger" | "live" } {
  if (!r) return { value: "—", sub: "not set up" };
  if (!r.connected) return { value: "—", sub: `${r.name} not connected` };
  if (!r.recording) return { value: "STOPPED", sub: `${r.name} connected`, tone: "danger" };
  return { value: "RECORDING", sub: r.timecode ?? "no position reported", tone: "live" };
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
