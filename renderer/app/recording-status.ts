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



/**
 * What a recording INDICATOR shows — the same three states, in the same shape,
 * as `streamIndicator`.
 *
 * They sit side by side on Home and on a wall, and they were answering in two
 * different vocabularies: a recorder said "—" with a line of prose underneath
 * while a platform beside it said "OFF AIR". Reported as the recorders not
 * matching, which they did not.
 *
 * Grey for a recorder that is not rolling, for the reason the streaming widgets
 * are grey: it is the state the page sits in all week, and a red word that is
 * always there stops meaning anything long before the morning it matters.
 */
export function recordIndicator(
  list: readonly Recorder[],
): { value: string; sub: string | null; state: "offline" | "idle" | "live" } {
  const wired = list.filter((r) => r.connected);
  if (wired.length === 0) {
    return {
      value: "Offline",
      sub: list.length === 1 ? `${list[0].name} not connected` : null,
      state: "offline",
    };
  }
  const rolling = wired.filter((r) => r.recording);
  if (rolling.length === 0) {
    return { value: "Standby", sub: wired.map((r) => r.name).join(" + "), state: "idle" };
  }
  return {
    value: "Recording",
    // The timecode goes underneath, where the elapsed time goes on a stream:
    // welded onto the state word it makes the string long enough to shrink the
    // word it was qualifying.
    sub: rolling.find((r) => r.timecode)?.timecode ?? rolling.map((r) => r.name).join(" + "),
    state: "live",
  };
}

/**
 * One thing that can be streaming.
 *
 * The twin of `Recorder`, and deliberately the same shape of idea: a LIST, so
 * "are we live?" is one question about every platform at once and adding a
 * third is one entry in `streamers()` rather than a new argument threaded
 * through every surface that asks.
 */
export interface Streamer {
  /** How it is named to the operator: "Resi", "YouTube", "OBS". */
  name: string;
  /** The link to the platform. Not the same as being live. */
  connected: boolean;
  live: boolean;
  /** ISO start, or null when the platform will not say since when. */
  startedAt?: string | null;
}

/**
 * Every platform the app can see streaming, from the live state.
 *
 * THE place a new streaming integration is added. OBS is here because it
 * already reports `streaming` alongside `recording` — the same connection that
 * tells us it is recording tells us it is live, and leaving that out would mean
 * the app knew and did not say.
 */
export function streamers(
  resi: { connected: boolean; live: boolean; startedAt: string | null } | null,
  youtube: { connected: boolean; live: boolean; startedAt: string | null } | null,
  obs: { connected: boolean; streaming: boolean } | null,
): Streamer[] {
  return [
    { name: "Resi", connected: !!resi?.connected, live: !!resi?.live, startedAt: resi?.startedAt ?? null },
    { name: "YouTube", connected: !!youtube?.connected, live: !!youtube?.live, startedAt: youtube?.startedAt ?? null },
    // OBS has no start time for its stream — obs-websocket reports the output
    // is active, not when it began — so elapsed comes from whoever else is live,
    // or is absent.
    { name: "OBS", connected: !!obs?.connected, live: !!obs?.streaming, startedAt: null },
  ];
}

/** "HH:MM:SS" (or "MM:SS" under an hour) since `startedAt`. */
export function elapsedSince(startedAt: string | null | undefined, now: number): string | null {
  if (!startedAt) return null;
  const t = Date.parse(startedAt);
  if (!Number.isFinite(t)) return null;
  // A start in the future is a clock disagreement between us and the platform,
  // not a negative duration. Show it as just-started rather than "-0:03".
  const sec = Math.max(0, Math.floor((now - t) / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const ss = String(sec % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/**
 * Are we live, and what should it say?
 *
 * The streaming twin of `recordingStat`, and it makes the same distinction:
 * connected-but-not-live is its own state, reported rather than folded into
 * "no". Mid-service "Resi is reachable and is NOT streaming" is the single most
 * useful thing this can tell you, and it is the one a boolean would lose.
 *
 * `now` is passed in because elapsed is computed here rather than reported by
 * the platform — a caller that ticks a clock already has one, and a function
 * that reads the clock itself cannot be tested.
 */
export function streamingStat(
  list: readonly Streamer[],
  now: number,
): { value: string; sub: string; tone?: "danger" | "live" } {
  const wired = list.filter((s) => s.connected);
  if (wired.length === 0) return { value: "—", sub: "no streaming platform connected" };

  const live = wired.filter((s) => s.live);
  if (live.length === 0) {
    // Connected and not live. Amber rather than red: outside a service this is
    // simply the truth, and the surfaces decide whether the moment makes it
    // worth shouting about.
    return { value: "OFFLINE", sub: `${wired.map((s) => s.name).join(" + ")} connected`, tone: "danger" };
  }
  // The longest-running start, so two platforms that went live a minute apart
  // report the stream rather than the most recent button press.
  const starts = live.map((s) => s.startedAt).filter((x): x is string => !!x).map((x) => Date.parse(x)).filter(Number.isFinite);
  const since = starts.length ? new Date(Math.min(...starts)).toISOString() : null;
  return {
    value: elapsedSince(since, now) ?? "LIVE",
    sub: live.map((s) => s.name).join(" + "),
    tone: "live",
  };
}

/**
 * What a streaming INDICATOR shows — the wall/widget answer, not the dashboard's.
 *
 * Deliberately the same three states, in the same words, that obs-status and
 * reaper-status have always shown: offline dimmed, an idle word, and the active
 * word with the ticking number underneath. Those two are usually sitting right
 * beside these on the same wall, and a widget that answered the same kind of
 * question in a different shape read as a different app.
 *
 * The STATE is returned rather than a colour: the mapping belongs to the widget,
 * but which of the three we are in is a judgement, and judgements get tested.
 * Off air is its own state and not a shade of offline — "Resi is reachable and
 * is not streaming" is the single most useful thing this can say mid-service.
 */
export function streamIndicator(
  list: readonly Streamer[],
  now: number,
  opts: { showElapsed?: boolean } = {},
): { value: string; sub: string | null; state: "offline" | "idle" | "live" } {
  const st = streamingStat(list, now);
  // No tone is streamingStat's "nothing is even connected". That is a platform
  // nobody has set up, not a stream that dropped.
  if (!st.tone) return { value: "Offline", sub: null, state: "offline" };
  if (st.tone !== "live") return { value: "Off air", sub: null, state: "idle" };
  // Live: the word, with the elapsed time as the sub-line. streamingStat's value
  // IS the elapsed reading, or "LIVE" when the platform will not say since when.
  const elapsed = st.value === "LIVE" ? null : st.value;
  return {
    value: "Live",
    sub: opts.showElapsed === false ? null : elapsed,
    state: "live",
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
