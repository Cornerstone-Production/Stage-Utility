// Shared PCO Services Live timer logic for the dashboard + stage display.
//
// "Full Item Length" mode: count DOWN from the current item's length. When an item
// has no set length (lengthSec null), there's nothing to count down to, so show
// ELAPSED (count up from when it went live) — never a bogus "0 − elapsed" negative.

export interface PcoTimer {
  /** A service is live and an item is current. */
  live: boolean;
  /** "down" = remaining on a fixed-length item; "up" = elapsed (no fixed length). */
  mode: "down" | "up";
  /** Remaining seconds (mode "down", may be negative = over) or elapsed (mode "up"). */
  seconds: number;
  /** True when counting down and past zero. */
  over: boolean;
  itemTitle: string | null;
  /** The item's total length in seconds, when known (mode "down"). */
  totalSec: number | null;
}

/** Compute the live timer. Returns null when no service is live. */
export function computePcoTimer(
  pcoLive: PcoLiveDTO | null,
  now: number,
  skewMs: number,
): PcoTimer | null {
  if (!pcoLive?.isLive || !pcoLive.liveStartAt) return null;
  const serverNow = now + skewMs;
  const elapsed = (serverNow - Date.parse(pcoLive.liveStartAt)) / 1000;

  if (pcoLive.lengthSec != null) {
    const remaining = pcoLive.lengthSec - elapsed;
    return {
      live: true,
      mode: "down",
      seconds: remaining,
      over: remaining < 0,
      itemTitle: pcoLive.itemTitle,
      totalSec: pcoLive.lengthSec,
    };
  }

  return {
    live: true,
    mode: "up",
    seconds: Math.max(0, elapsed),
    over: false,
    itemTitle: pcoLive.itemTitle,
    totalSec: null,
  };
}

// mm:ss (or h:mm:ss past an hour); negative = over time, shown with a leading "−".
export function fmtDuration(totalSec: number): string {
  const neg = totalSec < 0;
  const s = Math.abs(Math.round(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const body =
    h > 0
      ? `${h}:${mm}:${String(sec).padStart(2, "0")}`
      : `${mm}:${String(sec).padStart(2, "0")}`;
  return neg ? `−${body}` : body;
}
