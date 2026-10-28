// Recording and SPL, judged once.
//
// Home's live panel and the context bar's recording item both need the same
// answer to "are we getting this?", and they render it differently — a stat tile
// and a compact strip. Shared LOGIC, separate rendering: a second copy of the
// connected-but-stopped judgement is a second place for the same bug.

import { obsRecordTimecode, type RecordAnchor } from "@main/services/obs-record-clock";
import { externKeyed } from "@main/types/extern-keyed";

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
 *
 * `serverNow` is passed in because OBS's record clock is INTERPOLATED rather than
 * pushed — the server sends an anchor twice a minute instead of a formatted
 * string every second, and this reads it forward. Same argument `streamingStat`
 * makes for taking `now`: a caller that ticks a clock already has one, and a
 * function that reads the clock itself cannot be tested.
 */
export function recorders(
  obs: RecordAnchor & { connected: boolean } | null,
  reaper: { connected: boolean; recording: boolean; positionString?: string | null } | null,
  serverNow: number,
): Recorder[] {
  return [
    { name: "OBS", connected: !!obs?.connected, recording: !!obs?.recording, timecode: obsRecordTimecode(obs, serverNow) },
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
      // Always a third line, so a card that is offline is the same height as the
      // one beside it that is recording. Where there is one recorder it can say
      // which; where there are two it cannot, and says what it does know.
      sub: list.length === 1 ? `${list[0].name} not connected` : "no recorder connected",
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
/** How each platform is named to the operator. A union rather than a string so a
 *  table keyed by it (the layout renderer's "has it answered yet") fails to
 *  compile when a platform is renamed or added, instead of reading as unanswered
 *  for ever. */
export type StreamerName = "Resi" | "YouTube" | "OBS";

export interface Streamer {
  name: StreamerName;
  /** The link to the platform. Not the same as being live. */
  connected: boolean;
  live: boolean;
  /** ISO start, or null when the platform will not say since when. */
  startedAt?: string | null;
  /** People watching right now, where the platform reports one. Only YouTube
   *  does, and only on the API-key path — see YouTubeStatusDTO.viewers. */
  viewers?: number | null;
  /** ISO moment this was scheduled to begin, or null. Only YouTube reports one.
   *  Read through `lateBySec`, never compared by hand. */
  scheduledStartAt?: string | null;
}

/**
 * How many seconds past its scheduled start something is, or null.
 *
 * Null means "not an alarm", which is four different things: nothing is
 * scheduled, it is already live, the scheduled time has not arrived, or it is
 * so far past that this is history rather than news.
 *
 * COMPUTED ON THE CLIENT, from a fixed timestamp the server pushed once. The
 * server could work out "late" itself, but the number grows every second, so it
 * would be a frame a second to every browser — which is the bug the OBS record
 * clock was just fixed for, and the reason `scheduledStartAt` is a moment
 * rather than a countdown.
 */
export function lateBySec(s: Pick<Streamer, "live" | "scheduledStartAt">, now: number): number | null {
  if (s.live || !s.scheduledStartAt) return null;
  const at = Date.parse(s.scheduledStartAt);
  if (!Number.isFinite(at)) return null;
  const lateMs = now - at;
  // A MINUTE of grace. A stream that goes out forty seconds after its scheduled
  // time is not a problem anyone needs telling about, and a widget that flashes
  // red at every start is one nobody reads by the third Sunday.
  //
  // And an upper bound, because an upcoming broadcast that was never started
  // keeps its scheduled time for as long as it sits on the channel — without
  // one, a broadcast cancelled in March leaves the widget red until somebody
  // deletes it. Two hours is past the end of any service this is raised for.
  if (lateMs < 60_000 || lateMs > 2 * 60 * 60_000) return null;
  return Math.floor(lateMs / 1000);
}

/**
 * Every platform the app can see streaming, from the live state.
 *
 * THE place a new streaming integration is added. OBS is here because it
 * already reports `streaming` alongside `recording` — the same connection that
 * tells us it is recording tells us it is live, and leaving that out would mean
 * the app knew and did not say.
 */
/**
 * The streamer a `platform` value names, or null for "every platform at once".
 *
 * Config stores lowercase ("resi"); `streamers()` names them as an operator reads
 * them ("Resi"), and the card uses that name both to filter and as its label. One
 * table, because the conversion now happens on two surfaces.
 *
 * TOTAL, not a ternary. The wall object did this inline as
 * `platform === "resi" ? "Resi" : "YouTube"`, so any third platform silently
 * rendered as YouTube — a card labelled YouTube reporting something else.
 * A lookup that returns undefined for an unknown value cannot do that.
 */
export const STREAMER_FOR: Readonly<Record<string, StreamerName | null>> = externKeyed({
  any: null,
  resi: "Resi",
  youtube: "YouTube",
  obs: "OBS",
});

/** The recorder a `recorder` value names, or null for "every recorder at once".
 *  Same shape and same reasoning as STREAMER_FOR. */
export const RECORDER_FOR: Readonly<Record<string, string | null>> = externKeyed({
  any: null,
  obs: "OBS",
  reaper: "REAPER",
});

/** The options a "which one" submenu offers, built from a mapping above. `anyLabel`
 *  is what the every-source choice is called on that card. */
export function sourceOptions(
  map: Readonly<Record<string, string | null>>,
  anyLabel: string,
): { value: string; label: string }[] {
  return Object.entries(map).map(([value, name]) => ({ value, label: name ?? anyLabel }));
}

export function streamers(
  resi: { connected: boolean; live: boolean; startedAt: string | null } | null,
  youtube: YouTubeStatusDTO | null,
  obs: { connected: boolean; streaming: boolean } | null,
): Streamer[] {
  return [
    { name: "Resi", connected: !!resi?.connected, live: !!resi?.live, startedAt: resi?.startedAt ?? null },
    {
      name: "YouTube",
      connected: !!youtube?.connected,
      live: !!youtube?.live,
      startedAt: youtube?.startedAt ?? null,
      viewers: youtube?.viewers ?? null,
      scheduledStartAt: youtube?.scheduledStartAt ?? null,
    },
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
 *
 * Off air is its own state and not a shade of offline — "Resi is reachable and
 * is not streaming" is the single most useful thing this can say mid-service.
 *
 * LATE is off air with a reason, and the fourth state exists because those two
 * want opposite treatment. The note on the context bar's streaming item is that
 * off air must stay quiet: it is what the bar sits in all week, and a red word
 * that is always there stops meaning anything long before the morning it
 * matters. Late is the morning it matters — a broadcast was scheduled, the time
 * has passed and nothing is going out — and it is the one off-air moment that
 * has earned the colour. Only YouTube can report it; see `lateBySec`.
 *
 * The sub-line is always supplied, and the WALL widgets drop it for the two
 * quiet states: a wall wants one word, and Home wants the third line saying
 * which platform is or is not connected. One judgement, two presentations.
 */
export function streamIndicator(
  list: readonly Streamer[],
  now: number,
  opts: { showElapsed?: boolean; name?: string | null } = {},
): { value: string; sub: string | null; state: "offline" | "idle" | "late" | "live" } {
  const st = streamingStat(list, now);
  const named = opts.name;
  // No tone is streamingStat's "nothing is even connected". That is a platform
  // nobody has set up, not a stream that dropped.
  if (!st.tone) {
    return {
      value: "Offline",
      sub: named ? `${named} not connected` : "no streaming platform connected",
      state: "offline",
    };
  }
  if (st.tone !== "live") {
    // The most overdue of whatever is connected. Where two platforms are both
    // waiting on the same service, the one that should have started first is
    // the one worth reporting.
    const late = list
      .filter((s) => s.connected)
      .map((s) => lateBySec(s, now))
      .filter((x): x is number => x != null)
      .sort((a, b) => b - a)[0];
    if (late != null) {
      return { value: "Off air", sub: `${formatDuration(late)} late`, state: "late" };
    }
    return { value: "Off air", sub: named ? `${named} connected` : st.sub, state: "idle" };
  }
  // Live: the word, with the elapsed time as the sub-line. streamingStat's value
  // IS the elapsed reading, or "LIVE" when the platform will not say since when.
  const elapsed = st.value === "LIVE" ? null : st.value;
  // The audience rides the same line. It is not "elapsed", but it is the same
  // running reading, and a wall widget has exactly one slot for one — a second
  // line is paid for out of the size of the word above it, which is the fix
  // that made every status tile too small once already.
  const watching = list.find((s) => s.live && s.viewers != null)?.viewers;
  const reading = [elapsed, watching == null ? null : `${watching} watching`].filter(Boolean).join(" · ");
  return {
    value: "Live",
    sub: opts.showElapsed === false || !reading ? null : reading,
    state: "live",
  };
}

/** "H:MM:SS" past an hour, else "M:SS". The shape `elapsedSince` returns, from
 *  a count of seconds rather than a start time. */
export function formatDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const ss = String(sec % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/**
 * The `meterId` value meaning "whichever meter is loudest right now".
 *
 * A named sentinel rather than null, so the menu can tick it like any other
 * choice and a saved card says out loud which behaviour it wants. Absent still
 * means the same thing — every card saved before the setting existed.
 */
export const LOUDEST_METER = "loudest";

export type SplMeters = {
  connected: boolean;
  meters: Record<string, { deviceName?: string; channelName?: string; metrics: Record<string, number> }>;
} | null;

/**
 * The metric the card reads off a meter when nobody picked one: A-weighted when
 * the meter reports one, else whatever it reports first. Null for a meter with
 * no metrics at all.
 *
 * THE one definition of "Automatic". The card, the loudest-meter comparison and
 * the Metric submenu's "Automatic" row all go through it, so the row can never
 * name a metric the card is not showing.
 */
export function autoSplMetric(metrics: Record<string, number> | undefined): string | null {
  const keys = Object.keys(metrics ?? {});
  if (!keys.length) return null;
  return keys.find((k) => /SPL\s*A/i.test(k)) ?? keys[0];
}

/** A metric name and its value, as read off one meter. */
type SplReading = { metric: string; value: number };

/**
 * What this card reads off ONE meter: the metric it resolved to and its value.
 *
 * With `metric` unset that is `autoSplMetric`. With one pinned, it is exactly
 * that metric or null — NEVER another one. Smaart names its metrics and a
 * reconfiguration can drop one; falling back to the A-weighted number would put a
 * real figure about a different quantity under a caption naming the one the
 * operator asked for.
 *
 * hasOwn says out loud that the pinned key must be the meter's own: it comes off
 * a saved card, and "constructor" is `in` every parsed object. The number check
 * below is what actually rejects such a key, so the two agree.
 */
function splReading(
  meter: { metrics: Record<string, number> },
  metric?: string,
): SplReading | null {
  const metrics = meter.metrics ?? {};
  const key = metric ? (Object.hasOwn(metrics, metric) ? metric : null) : autoSplMetric(metrics);
  if (key == null) return null;
  const value = metrics[key];
  return typeof value === "number" ? { metric: key, value } : null;
}

/** A meter key ("device::channel") as the card labels it. */
function meterName(key: string): string {
  return key.split("::").pop() ?? key;
}

/**
 * The loudest meter, judged on `metric` when one is pinned and on each meter's
 * own automatic metric otherwise.
 *
 * Shared by the card and the Metric submenu so the menu lists the keys of the
 * very meter the card is reading.
 */
function loudestReading(spl: SplMeters, metric?: string): (SplReading & { meterKey: string }) | null {
  let best: (SplReading & { meterKey: string }) | null = null;
  for (const [meterKey, meter] of Object.entries(spl?.meters ?? {})) {
    const reading = splReading(meter, metric);
    if (reading == null) continue;
    if (best == null || reading.value > best.value) best = { meterKey, ...reading };
  }
  return best;
}

/**
 * The card's "no reading" answer. `reportsAnything` says whether the meter(s) in
 * question reported any metric at all: if they did, the pinned one is what is
 * missing and the caption names it; if not, nothing has arrived yet.
 */
function noReading(metric: string | undefined, reportsAnything: boolean): { value: string; sub: string } {
  return { value: "\u2014", sub: metric && reportsAnything ? `${metric} not reporting` : "no readings yet" };
}

/** "<metric> · <meter>", the caption under the number. */
function splCaption(metric: string, meterKey: string): string {
  return `${metric} \u00b7 ${meterName(meterKey)}`;
}

/**
 * The loudest current SPL reading across every meter, which is the number
 * anyone glancing at Home actually wants.
 *
 * `metric` pins which Smaart metric is compared and shown; unset means each
 * meter's automatic one. A pinned metric that NO meter reports reads "—" and
 * names it, rather than quietly showing something else.
 */
export function loudestSpl(spl: SplMeters, metric?: string): { value: string; sub: string } {
  if (!spl?.connected) return { value: "\u2014", sub: "Smaart offline" };
  const best = loudestReading(spl, metric);
  if (best == null) {
    return noReading(metric, Object.values(spl.meters ?? {}).some((m) => autoSplMetric(m.metrics) != null));
  }
  return { value: `${Math.round(best.value)} dB`, sub: splCaption(best.metric, best.meterKey) };
}

/** A meter as the Meter submenu and the Metric submenu's heading name it. */
function meterLabel(id: string, m: { deviceName?: string; channelName?: string }): string {
  return m.channelName || m.deviceName || id;
}

/**
 * The "Meter" submenu's options: the default, then every meter Smaart reports.
 *
 * `pinned` is passed so a meter that has GONE AWAY still appears, labelled as
 * not reporting. Dropping it would leave the submenu with nothing ticked and no
 * way to tell what the card is pinned to — the operator would see a menu that
 * looks unset while the card reads "not reporting", and have to guess.
 */
export function meterOptions(
  spl: { meters: Record<string, { deviceName?: string; channelName?: string }> } | null,
  pinned: string,
): { value: string; label: string }[] {
  const out = [{ value: LOUDEST_METER, label: "Loudest meter" }];
  for (const [id, m] of Object.entries(spl?.meters ?? {})) {
    out.push({ value: id, label: meterLabel(id, m) });
  }
  if (pinned !== LOUDEST_METER && !out.some((o) => o.value === pinned)) {
    out.push({ value: pinned, label: `${meterName(pinned)} (not reporting)` });
  }
  return out;
}

/**
 * One named meter, in the same shape `loudestSpl` returns.
 *
 * A pinned meter that has gone missing says so rather than falling back to the
 * loudest. The operator asked for THAT channel; quietly showing a different one
 * would read as the channel being fine, which is the opposite of the truth when
 * Smaart has restarted and dropped it.
 */
export function pinnedSpl(spl: SplMeters, meterId: string, metric?: string): { value: string; sub: string } {
  if (!spl?.connected) return { value: "\u2014", sub: "Smaart offline" };
  const meter = spl.meters?.[meterId];
  if (!meter) return { value: "\u2014", sub: `${meterName(meterId)} not reporting` };
  const reading = splReading(meter, metric);
  if (reading == null) return noReading(metric, autoSplMetric(meter.metrics) != null);
  return { value: `${Math.round(reading.value)} dB`, sub: splCaption(reading.metric, meterId) };
}

/** One row of the Metric submenu. `value` is null for a pinned metric the meter
 *  no longer reports. */
export interface SplMetricOption {
  metric: string;
  value: number | null;
}

/**
 * The Metric submenu's content, for the card pinned to `meterId` and `metric`
 * ("" is Automatic).
 *
 * `automatic` is the metric Automatic resolves to right now, for the row's
 * right-hand hint. `from` names the meter the rows come from and `options` are
 * every metric that meter reports, in Smaart's order, each with its live value.
 *
 * For the loudest-meter default the rows come from the meter the card is
 * currently reading (judged on the pinned metric, as the card judges it), so the
 * list always describes the number on screen. A pinned metric the meter has
 * stopped reporting is still listed, with a null value — the Meter submenu does
 * the same for a vanished meter, and for the same reason: dropping it leaves a
 * menu with nothing ticked while the card reads "not reporting".
 */
export function metricOptions(
  spl: SplMeters,
  meterId: string,
  metric: string,
): { automatic: string | null; from: string; options: SplMetricOption[] } {
  // Offline Smaart keeps its last meters; the card reads "Smaart offline", so the
  // menu must not list a stale meter's numbers as if they were live.
  const live = spl?.connected ? spl : null;
  let from: string;
  let metrics: Record<string, number>;
  // What picking Automatic would show: the unpinned loudest meter's own automatic
  // metric, NOT the automatic metric of the meter the pinned metric is loudest on.
  let automatic: string | null;
  if (meterId === LOUDEST_METER) {
    from = "Loudest meter";
    // The rows follow the meter the card is reading. If NO meter reports the
    // pinned metric the card reads a dash and the menu still wants a meter to list,
    // so use the automatic loudest.
    const best = loudestReading(live, metric || undefined) ?? loudestReading(live);
    metrics = (best && live?.meters[best.meterKey]?.metrics) || {};
    automatic = loudestReading(live)?.metric ?? null;
  } else {
    const m = live?.meters?.[meterId];
    from = m ? meterLabel(meterId, m) : `${meterName(meterId)} (not reporting)`;
    metrics = m?.metrics ?? {};
    automatic = autoSplMetric(metrics);
  }
  const options: SplMetricOption[] = Object.entries(metrics).map(([k, v]) => ({ metric: k, value: v }));
  if (metric && !options.some((o) => o.metric === metric)) options.push({ metric, value: null });
  return { automatic, from, options };
}
