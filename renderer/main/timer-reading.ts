// timer-reading.ts — what a Timer says, as plain data.
//
// The caption, the value, the sub-line and the colour, decided from the config
// and the live inputs, with no React: the wall draws the result through Readout
// and Home through Stat, and a test can pin every state without a render.
//
// Three sources, each carried over from the widget it replaced — the service
// clock from `countdown-timer` and `home-live-status`, the ProPresenter timer
// from `pp-timer`, the baptism readouts from `baptism-timer` — so a converted
// widget draws what it always drew. timer-reading.test.tsx holds each to that.

import { segmentElapsedMs } from "@main/services/baptism-elapsed";
import type { TimerConfig } from "./timer-config";
import { timerSource } from "./timer-config";
import { computePcoTimer, fmtDuration } from "./pco-timer";
import { fmtClock, summarizeBaptism } from "./use-baptism-state";

/** The colour a time earns. `over` is red, `warn` amber; the surface decides
 *  which tokens those are (the wall's display palette, Home's semantic ones). */
export type TimerTone = "over" | "warn";

export interface TimerReading {
  /** Draw nothing: Hide when idle, and there is nothing to show. */
  hidden: boolean;
  /** The caption row, or null for none. */
  caption: string | null;
  value: string;
  sub: string | null;
  tone: TimerTone | null;
  /** The source did not answer: the value is a dash and the sub-line says so. */
  unanswered: boolean;
}

export interface TimerInputs {
  /** The server's clock, ms. */
  now: number;
  pcoLive: PcoLiveDTO | null;
  /** Whether pco:live has answered yet. */
  pcoLiveKnown: boolean;
  /** The ProPresenter instance this timer reads, already resolved from its
   *  `propresenterInstanceId`: undefined when that instance has not loaded. */
  propresenter: ProPresenterStatusDTO | null | undefined;
  propresenterKnown: boolean;
  /** Whether ProPresenter is set up at all. A machine without it has nothing to be
   *  "not answering". */
  propresenterConfigured: boolean;
  baptism: BaptismState | null;
  baptismKnown: boolean;
}

export const PROPRESENTER_UNANSWERED = "ProPresenter isn’t answering";

/**
 * The seconds in ProPresenter's own timer text, or null when it is not a time.
 *
 * The text is all the API gives (see propresenter-service.ts): "00:03:00",
 * "-00:00:02", "00:21:43", and a precision that is not pinned, so a fractional
 * second ("00:00:01.00") is read too. Hours are optional ("03:00").
 */
export function parseProTimerSeconds(text: string | null | undefined): number | null {
  const m = /^\s*(-?)(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)\s*$/.exec(text ?? "");
  if (!m) return null;
  const secs = Number(m[2] ?? 0) * 3600 + Number(m[3]) * 60 + Number(m[4]);
  return m[1] ? -secs : secs;
}

/**
 * The caption as the operator set it. Unset is the fallback, which only the
 * service has (the live item's name, data rather than a default string); an
 * empty or null caption is a deliberate "no caption". A new Timer is created with
 * its source's caption written into its config, so the renderer defaults none.
 */
function captionOf(config: TimerConfig, fallback: string | null = null): string | null {
  const c = config.caption === undefined ? fallback : config.caption;
  return c ? c : null;
}

/** Hide-when-idle and nothing to show. Quiet reads never claim anything. */
const HIDE: TimerReading = { hidden: true, caption: null, value: "", sub: null, tone: null, unanswered: false };

/** The dash: a source with nothing to say, or not heard from yet. */
const dash = (caption: string | null, unanswered: boolean, sub: string | null = null): TimerReading => ({
  hidden: false,
  caption,
  value: "\u2014",
  sub,
  tone: null,
  unanswered,
});

/** The settings every source reads the same way, normalised once. */
interface Common {
  hide: boolean;
  showSub: boolean;
}

function service(config: TimerConfig, i: TimerInputs, { hide }: Common): TimerReading {
  const t = computePcoTimer(i.pcoLive, i.now);
  if (!i.pcoLiveKnown) {
    // Not heard from yet: the plain dash and no sentence, the house rule for a
    // wall that has just loaded (wall-status-unknown.test.tsx). Planning Center
    // has no signal for "down" (a failed read and "nothing live" both arrive as
    // null), so there is no service sentence to show once it has answered either.
    return hide ? HIDE : dash(captionOf(config, "Service"), true);
  }
  if (!t && hide) return HIDE;
  const next = i.pcoLive?.nextItemTitle;
  const redOnOverrun = config.redOnOverrun ?? true;
  let tone: TimerTone | null = null;
  if (t) {
    if (t.over) tone = redOnOverrun ? "over" : null;
    // A live item with no length counts UP, so its seconds are elapsed rather
    // than remaining: "near the end" has no meaning there.
    else if (!t.countUp && config.warnSeconds != null && t.seconds <= config.warnSeconds) tone = "warn";
  }
  return {
    hidden: false,
    caption: captionOf(config, t?.label ?? "Service"),
    value: t ? fmtDuration(t.seconds) : "\u2014",
    // The next item IS the service's sub-line, with one switch of its own. Not
    // gated on showLabel as well: the inspector no longer offers that switch for
    // the service, and a layout saved with it off would tick Show the next item
    // and draw nothing.
    sub: (config.nextItem ?? false) && next ? `Next \u00b7 ${next}` : null,
    tone,
    unanswered: false,
  };
}

function propresenter(config: TimerConfig, i: TimerInputs, { hide, showSub }: Common): TimerReading {
  const pro = i.propresenter;
  const caption = captionOf(config);
  if (!i.propresenterKnown) {
    // Not heard from yet: the plain dash, no sentence, hidden under Hide when
    // idle. Only a ProPresenter that has ANSWERED, and said it is not connected,
    // earns the sentence below.
    return hide ? HIDE : dash(caption, true);
  }
  // Known to be down. Hide when idle wins: a widget set to draw nothing when
  // there is nothing to show does not announce an outage.
  if (pro?.connected === false) {
    if (hide) return HIDE;
    // Not set up is not down: a machine with no ProPresenter reads the plain dash.
    return dash(caption, i.propresenterConfigured, i.propresenterConfigured && showSub ? PROPRESENTER_UNANSWERED : null);
  }
  const timers = pro?.timers ?? [];
  const timer = config.timerName ? timers.find((t) => t.name === config.timerName) : timers[0];
  if (!timer) return hide ? HIDE : dash(caption, false);
  // Red only on the states that say the time is up; anything else stays neutral.
  const state = (timer.state ?? "").toLowerCase();
  const over = state.includes("over") || state.includes("expire");
  const seconds = parseProTimerSeconds(timer.time);
  let tone: TimerTone | null = null;
  if (over) tone = (config.redOnOverrun ?? true) ? "over" : null;
  else if (config.warnSeconds != null && seconds != null && seconds >= 0 && seconds <= config.warnSeconds) tone = "warn";
  return {
    hidden: false,
    caption,
    value: timer.time,
    // The timer's NAME, under the value: inline it pushed the number off centre.
    sub: showSub ? timer.name : null,
    tone,
    unanswered: false,
  };
}

/** The value and the word under it for one baptism readout, before the caption
 *  and the label switch are applied. */
function baptismReadout(
  field: NonNullable<TimerConfig["field"]>,
  state: BaptismState | null,
  known: boolean,
  now: number,
): { value: string; word: string } {
  const sum = summarizeBaptism(state);
  let value = "—";
  let word = "";
  if (field === "live") {
    if (state && state.phase !== "idle") {
      // The operator page's own calculation, so a paused timer on a display shows
      // the held value rather than freezing at whatever it last rendered.
      value = fmtClock(segmentElapsedMs(state, now));
      if (state.phase === "testimony") word = state.mode === "grouped" ? `Testimony ${state.personNumber}` : `Person ${state.personNumber} · testimony`;
      // Armed reads identically to a just-started baptism otherwise (0:00 over
      // "Baptism 1"), the ambiguity the operator panel's own "armed" readout rules out.
      else if (state.armed) word = "armed";
      else word = state.mode === "grouped" ? `Baptism ${state.baptismIndex + 1}` : `Person ${state.personNumber} · baptism`;
    } else {
      value = "0:00";
      word = "ready";
    }
  } else if (field === "count") {
    value = String(sum.count);
    word = "baptized";
  } else if (field === "total") {
    value = fmtClock(sum.totalMs);
    word = "total time";
  } else if (field === "average") {
    value = sum.count ? fmtClock(sum.avgPersonMs) : "—";
    word = "avg per person";
  } else if (field === "last") {
    // NOT the last entry in `people`: in grouped mode every testimony is pushed
    // up front with `baptizeMs: 0`, so that is the last person who TESTIFIED. The
    // last one actually BAPTIZED, same rule as `count`.
    const baptized = state?.people.filter((p) => p.baptizeMs > 0) ?? [];
    const last = baptized[baptized.length - 1];
    value = last ? fmtClock(last.testimonyMs + last.baptizeMs) : "—";
    word = "last person";
  } else if (field === "testimony") {
    // This person's own testimony once banked, not the live segment clock. While
    // it is still running nothing is banked, so it ticks the same value `live`
    // does; once the phase moves on it holds at what was banked.
    if (!state || state.phase === "idle") {
      value = "—";
    } else if (state.phase === "testimony") {
      value = fmtClock(segmentElapsedMs(state, now));
    } else {
      const bankedMs =
        state.mode === "per-person" ? (state.pendingTestimonyMs ?? 0) : (state.people[state.baptismIndex]?.testimonyMs ?? 0);
      value = fmtClock(bankedMs);
    }
    word = "testimony";
  } else if (field === "session") {
    // Wall clock since the session started, never paused; freezes at the finished
    // length once the session ends.
    if (!state?.sessionStartedAt) {
      value = "—";
    } else {
      const started = Date.parse(state.sessionStartedAt);
      const endedMs = state.finishedAt ? Date.parse(state.finishedAt) : now;
      value = Number.isFinite(started) ? fmtClock(Math.max(0, endedMs - started)) : "—";
    }
    word = "session";
  } else if (field === "phase") {
    // Armed reads as its own word: it has no clock running, and "baptism" would
    // claim one does.
    value = !state ? "—" : state.armed ? "armed" : state.phase;
    word = "phase";
  } else if (field === "person") {
    // In grouped mode `personNumber` is the TESTIMONY counter and freezes once the
    // baptism section arms. The person being baptized is `baptismIndex` (0-based)
    // of `people.length`, known only once the testimony pass has filled it.
    // Per-person mode never has a total. Armed says so rather than "1 of 7".
    if (!state || state.phase === "idle") {
      value = "—";
    } else if (state.armed) {
      value = "armed";
    } else if (state.phase === "testimony" || state.mode === "per-person") {
      value = `Person ${state.personNumber}`;
    } else {
      value = `${state.baptismIndex + 1} of ${state.people.length}`;
    }
    word = "person";
  }
  // Not answered yet: every field above reads a null state as a session with
  // nothing in it, which on a wall that just reloaded mid-baptism is a claim about
  // a session that is running. The dash; and `live`'s "ready" is itself the claim.
  if (!known) {
    value = "—";
    if (field === "live") word = "";
  }
  return { value, word };
}

function baptism(config: TimerConfig, i: TimerInputs, { hide, showSub }: Common): TimerReading {
  const idle = i.baptismKnown && (!i.baptism || i.baptism.phase === "idle");
  // Quiet through the first read, as the other sources are.
  if (hide && (!i.baptismKnown || idle)) return HIDE;
  const { value, word } = baptismReadout(config.field ?? "live", i.baptism, i.baptismKnown, i.now);
  return {
    hidden: false,
    caption: captionOf(config),
    value,
    // An empty label is the readout's own word, as the inspector's "(auto)" says;
    // a label of only spaces is a label, and draws a blank line as it always did.
    sub: showSub ? (config.label ? config.label : word) : null,
    tone: null,
    unanswered: !i.baptismKnown,
  };
}

/** What a Timer says right now. */
export function readTimer(config: TimerConfig, inputs: TimerInputs): TimerReading {
  const common: Common = { hide: config.hideWhenIdle ?? false, showSub: config.showLabel ?? true };
  switch (timerSource(config)) {
    case "propresenter":
      return propresenter(config, inputs, common);
    case "baptism":
      return baptism(config, inputs, common);
    default:
      return service(config, inputs, common);
  }
}
