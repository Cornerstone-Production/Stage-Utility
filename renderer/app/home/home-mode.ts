// Which Home an operator gets.
//
// A dashboard that looks the same on a Tuesday afternoon and mid-service is
// reporting rather than participating, so Home has two states and this decides
// between them. Split out from the components so the decision is testable
// without rendering either.

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
 * @param pcoLive The live payload, or null.
 * @param secondsToStart Seconds until the service begins, for `preservice`.
 *   Null when unknown — treated as too far out, because guessing "live" puts
 *   the wrong page in front of someone all week.
 */
export function homeMode(
  pcoLive: PcoLiveDTO | null,
  secondsToStart: number | null = null,
): HomeMode {
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
