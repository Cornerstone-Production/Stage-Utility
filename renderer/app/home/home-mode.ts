// Which Home an operator gets.
//
// A dashboard that looks the same on a Tuesday afternoon and mid-service is
// reporting rather than participating, so Home has two moods and this decides
// between them. Split out from the components so the decision is testable
// without rendering either.
//
// It can also decline to decide. "unknown" says the live channel has not
// answered yet — a THIRD answer, not a third mood, and the one thing an
// unhydrated Home must never do is pick a mood and correct itself in front of
// the operator.

/**
 * How close to a service "pre-service" starts meaning live.
 *
 * PCO reports `mode: "preservice"` from whenever it knows about the next
 * service, which is routinely DAYS out — on a real install this read
 * "Service starts 1d 15h" on a Thursday and showed the live countdown, hiding
 * the readiness list exactly when it is the useful thing on the page.
 *
 * Two hours is the window in which someone is setting up for a service rather
 * than preparing for one later in the week. Outside it, "what still needs
 * doing" is the question; inside it, the countdown is.
 */
export const PRESERVICE_LIVE_WINDOW_SEC = 2 * 60 * 60;

export type HomeMode = "live" | "idle";

/**
 * A mode, or `"unknown"` — Home has no answer yet.
 *
 * `"unknown"` is NOT a third mood to render. It is the absence of a decision,
 * and the only correct thing to do with it is nothing: `visibleCards` takes a
 * `HomeMode`, so the compiler refuses to filter the grid from one of these
 * until the caller has narrowed it.
 */
export type HomeModeOrUnknown = HomeMode | "unknown";

/**
 * @param liveKnown Whether the pco:live channel has ANSWERED yet — see
 *   `pcoLiveKnown` in use-dashboard-state.ts. Required rather than optional,
 *   and first, because forgetting it is the bug this parameter exists for: a
 *   caller that cannot omit it cannot render a guess.
 *
 *   Home hydrates pco:live on its own channel, independently of the stage state
 *   the page already gates on, so for the first few milliseconds of every visit
 *   there is no payload — indistinguishable, by value alone, from a Tuesday
 *   with no service. Answering "idle" there and correcting a frame later is
 *   what made a batch of rest-of-the-week cards appear on Home mid-service and
 *   then vanish.
 * @param pcoLive The live payload, or null. Once `liveKnown`, null is a real
 *   answer — Planning Center is not configured — and stays idle.
 * @param secondsToStart Seconds until the service begins, for `preservice`.
 *   Null when unknown — treated as too far out, because guessing "live" puts
 *   the wrong page in front of someone all week.
 */
export function homeMode(
  liveKnown: boolean,
  pcoLive: PcoLiveDTO | null,
  secondsToStart: number | null = null,
): HomeModeOrUnknown {
  if (!liveKnown) return "unknown";
  if (!pcoLive) return "idle";
  // `mode: "none"` is the server saying the service ENDED — a payload, not an
  // absence. Treating any payload as live is what leaves a Live pill lit all
  // week; the context bar guards the same mistake one layer down.
  if (pcoLive.mode === "none") return "idle";
  // An item is live: a service is genuinely running.
  if (pcoLive.mode === "item") return "live";
  // Pre-service, and only close to the start.
  if (secondsToStart === null) return "idle";
  return secondsToStart <= PRESERVICE_LIVE_WINDOW_SEC ? "live" : "idle";
}
