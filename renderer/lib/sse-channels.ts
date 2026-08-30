// The SSE channels the server re-sends on every connect, as a snapshot of
// current state ("the hello burst").
//
// Its own module because BOTH the page and the shared SSE worker need it, and the
// worker cannot import api.ts: that module touches `document` and `localStorage`
// at module scope, neither of which exists in a worker, and it also references
// the worker itself — so importing it there would be circular as well as broken.

/**
 * Channels whose last payload is worth caching and replaying to a subscriber that
 * mounted after the burst went past.
 *
 * These are STATE, not events: "the current plan", "the current SPL", "is OBS
 * recording". A subscriber that misses one shows nothing until the value happens
 * to change, which on a quiet channel can be many minutes — a countdown that is
 * simply blank on a display someone just opened.
 */
// `update:notice` is deliberately NOT here. It is an EVENT — "a new version
// appeared" — and replaying it on every connect would toast on every page load,
// which is the hounding the once-per-version rule exists to prevent. The fact
// that survives is stored server-side as `announcedTag`, not replayed.
export const HYDRATED_CHANNELS = [
  "server:hello",
  "stage:state-changed",
  "pco:live",
  "propresenter:status",
  "propresenter:instances",
  "spl:metrics",
  "spl:history",
  "attendance:history",
  "service-timeline:history",
  "baptism:state",
  "obs:status",
  "reaper:status",
  // PVP broadcasts only when a layer changes, and a workspace holding one still
  // between services changes nothing for hours — so a display opened in that
  // window would show dashes indefinitely without a hydrate.
  "pvp:status",
  // Scores are STATE, not events. A display opened mid-game must show the score
  // it is already at, not sit blank until somebody happens to score again.
  "scores:status",
  "resi:status",
  "youtube:status",
  "update:status",
  "osc:feedback",
  "companion:signals",
  "people:count",
  "displays:presence",
  // The month grid. Bookings change a couple of times a week, so a display that
  // subscribed after the burst would show an empty calendar for days.
  "calendar:grid",
  // Wireless telemetry. A pack in a drawer reports the same numbers for days, so
  // "broadcast on change" leaves a late subscriber blank indefinitely — exactly
  // the case this list exists for.
  "wireless:channels",
] as const;

export const HYDRATED_SET: ReadonlySet<string> = new Set<string>(HYDRATED_CHANNELS);
