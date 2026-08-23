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
  "resi:status",
  "youtube:status",
  "update:status",
  "osc:feedback",
  "companion:signals",
  "people:count",
  // The 24h signage horizon. STATE, not an event: it only changes when the
  // config does, so a subscriber that missed the burst would sit black until
  // someone edited a schedule.
  "signage:plan",
  "displays:presence",
] as const;

export const HYDRATED_SET: ReadonlySet<string> = new Set<string>(HYDRATED_CHANNELS);
