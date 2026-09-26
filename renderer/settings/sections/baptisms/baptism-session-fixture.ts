// baptism-session-fixture.ts — the BaptismSession builder past-sessions.test.tsx
// and trends-card.test.tsx both need, so the service/date/title fields that mean
// nothing to either test exist in exactly one place.
//
// `people` is NOT defaulted here: past-sessions.test.tsx's own default has one
// person mid-testimony (baptizeMs 0, to prove Baptized counts real baptisms,
// never people.length) and trends-card.test.tsx's own default has both people
// baptized (to prove averages divide by the right count) — both defaults are
// load-bearing in their own file's zero-override calls, so unifying them would
// silently change what one file's tests are actually asserting. Each file keeps
// its own thin `session(overrides)` wrapper supplying ITS OWN default `people`
// on top of this shared base.
//
// TEST-ONLY: no `.test.` in the filename on purpose, so `npm test`'s glob does
// not pick this up as a (zero-test) suite of its own.

export function baptismSessionFixture(overrides: Partial<BaptismSession> = {}): BaptismSession {
  return {
    id: "bap-1",
    startedAt: "2026-09-20T15:00:00.000Z",
    finishedAt: "2026-09-20T15:17:23.000Z",
    people: [],
    title: "Sunday Gathering",
    serviceTypeId: null,
    planId: null,
    serviceKey: "weekend:plan-1:1100",
    ...overrides,
  };
}
