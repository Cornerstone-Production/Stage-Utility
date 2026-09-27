// baptism-state.ts — the BaptismState builder every renderer test that needs
// one otherwise built independently, all 14 fields, per call site. The same
// treatment baptism-session-fixture.ts already gives BaptismSession.
//
// Neutral defaults only — idle, nobody timed yet, no session running. A test
// overrides only the fields it actually cares about; a value a test asserts
// on or depends on stays explicit at that call site rather than hiding inside
// this shared default. `serviceKey` is deliberately NOT defaulted here: it is
// optional on the real type, and half of this builder's callers never touch
// it at all.
//
// TEST-ONLY: no `.test.` in the filename on purpose, so `npm test`'s glob does
// not pick this up as a (zero-test) suite of its own.

export function baptismState(overrides: Partial<BaptismState> = {}): BaptismState {
  return {
    mode: "grouped",
    phase: "idle",
    personNumber: 0,
    baptismIndex: 0,
    segmentStartedAt: null,
    segmentAccumMs: 0,
    armed: false,
    sessionStartedAt: null,
    finishedAt: null,
    people: [],
    pendingTestimonyMs: null,
    serviceTitle: null,
    serviceTypeId: null,
    planId: null,
    ...overrides,
  };
}
