# PCO Calendar View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A monthly calendar of Planning Center events, as a first-class View — routable to any screen and embeddable in a producer multiview tile.

**Architecture:** A new `/calendar/v2` client beside the existing `/services/v2` one; a pure server-side day-bucketing pass because the renderer has no access to the app time zone; an eighth `ViewKind` wired through the nine files that name the set; and a month grid whose density problem is solved by filtering rather than by truncation.

**Tech Stack:** TypeScript, React 19, Tailwind v4, `node:test` + `@testing-library/react` with the repo's `installDom()` harness.

## What was verified live, and what it settles

Every claim below came back from the real org's API during planning. Do not re-derive them, and do not "fix" code that follows them.

| Verified | Consequence |
|---|---|
| `GET /calendar/v2/event_instances` with `where[starts_at][lte]=<gridEnd>&where[ends_at][gte]=<gridStart>` returns the correct overlap set | One request per grid window. A `starts_at` RANGE is a bug — it drops multi-day events already in progress on day one. |
| `where[calendar_ids]=<id>` filters server-side | Calendar choice is a query parameter, not a client-side sift. |
| `include=tags` returns tags with REAL HEX colours (`#F9D266`) | The Calendar's own `color` is an enum of names; the TAG colour is the usable one. |
| Every event in the sample is tagged — zero untagged | Tag filtering is reliable at this org. |
| `published_starts_at` is a real ISO instant, and is sometimes `null` | Use `published_starts_at ?? starts_at`. A plan that assumes it is always present renders blanks. |
| `kind` is `"standard"` for events, vans, rooms and childcare alike | **`kind` is useless here. Do not filter on it.** |
| All-day events arrive as `05:00Z` (local midnight, CDT) | Day bucketing MUST use the app time zone. A UTC host puts every all-day event on the wrong day. |
| Two calendars: `Cornerstone Church`, `FLC`. FLC events also appear on the church calendar | Calendar filtering alone does NOT remove the noise. Tags do. |
| 91 instances / 14 days unfiltered; 13 on the busiest day; **3** filtered to one department tag | Filtering solves density. Truncation is the fallback, not the strategy. |

**Explicitly out of scope, by the owner's decision:** a booking-vs-event toggle. The data cannot support it — resource bookings inherit the tag of whoever reserved them (`CR - Van` is tagged `Groups` while its parent `Cornerstone Recovery` is `Pastoral`), so no rule separates them. Do not infer one from names.

## Global Constraints

- Branch `feat/calendar-view` off `beta`. Every change is a PR; **never** push to `beta`/`main`, never `gh pr merge`.
- **No new npm dependencies.** No date library — the repo has `main/services/app-timezone.ts` and that is the only sanctioned source of wall-clock truth.
- No emojis. **NO Claude attribution footer on any commit** — no `Co-Authored-By: Claude`, no `Claude-Session:` trailer.
- Public repo: **no real calendar ids, tag names, event names, church names, credentials, service-type ids or LAN addresses** in code, tests, fixtures or docs. The ids and names in this plan are context for you; fixtures must be invented.
- Every persisted store declares `"config"` or `"runtime"` and a new config store joins `CONFIG_FILES` in the same change.
- Any new `catch` rethrows or returns the failure. A `catch` that only logs is a defect.
- Every guard proven red **in the session that writes it**: reintroduce the bug, watch it fail, restore, say so in the commit. This repo has shipped eight guards that passed on the exact defect they were written for; every one was caught by someone breaking the code, never by reading it.
- Prefer a check the type system enforces over one that reads source text.
- Run before every commit: `npx tsc --noEmit -p tsconfig.json`, `npx eslint main/ renderer/`, `npm test`, `npm run build`.
- Kill a test server **by port** (`lsof -ti tcp:8799 | xargs -r kill -9`), never `pkill -f` on an env-var prefix.

---

## Task 1: A calendar client

**Files:**
- Create: `main/services/pco-calendar-service.ts`, `main/services/pco-calendar-service.test.ts`
- Create: `main/types/calendar.ts`

**Interfaces produced:**
```ts
export interface CalendarEventDTO {
  id: string;
  name: string;
  /** published_starts_at ?? starts_at — see the verification table. */
  startsAt: string;
  endsAt: string;
  allDay: boolean;
  location: string | null;
  churchCenterUrl: string | null;
  tags: { id: string; name: string; color: string | null }[];
}
export interface CalendarSourceDTO { id: string; name: string }
export interface CalendarTagDTO { id: string; name: string; color: string | null; groupName: string }
```
- `listEventInstances(appId, secret, opts: { fromIso: string; toIso: string; calendarIds: readonly string[]; tagIds: readonly string[] }): Promise<CalendarEventDTO[]>`
- `listCalendars(appId, secret): Promise<CalendarSourceDTO[]>`
- `listCalendarTags(appId, secret): Promise<CalendarTagDTO[]>`

- [ ] **Step 1: Read the existing client first**

`main/services/pco-service.ts` is the `/services/v2` client. Read it before writing anything, and carry over — do not reinvent — its concurrency limiter, its tiered cache with `cacheGet`/`cacheSet`, its `PcoAuthError` handling, its `scrub()` on every log line, and the `sameOrigin`/offset rules that make following a `links.next` structurally safe.

`PCO_BASE` there is a `/services/v2` constant. Your base is `https://api.planningcenteronline.com/calendar/v2`. Decide deliberately whether to share the request plumbing by extracting it or to keep two clients, and say which you chose and why in your report. Duplicating the retry/backoff/limiter logic is the wrong answer; so is a refactor that destabilises the live-service path on the eve of a Sunday.

- [ ] **Step 2: Write the failing test**

Create `main/services/pco-calendar-service.test.ts`. Stub the requester the way `main/services/pco-plan-notes.test.ts` does (read it first — it swaps `svc.request` and restores it on exit). Invent fixture names; do not use real ones.

```ts
describe("the window query", () => {
  it("asks for OVERLAP, not a start range", () => {
    // A `starts_at` range drops a multi-day event already running on day one
    // of the grid — the retreat that started Thursday vanishes from a grid
    // beginning Saturday. Both clauses, ANDed.
    // assert the url contains where[starts_at][lte]=<to> AND where[ends_at][gte]=<from>
  });

  it("passes explicit ISO instants, never bare dates", () => {
    // A bare date is interpreted in PCO's org zone, which is not necessarily
    // the app's zone, and the error is a silent one-day shift.
  });

  it("filters calendars and tags server-side when asked", () => {
    // where[calendar_ids] and where[tag_ids]. Verified to work.
  });

  it("asks for NO calendar filter when none is chosen", () => {
    // Empty must not become `where[calendar_ids]=` — an empty filter value is
    // not the same request as no filter.
  });
});

describe("mapping an instance", () => {
  it("prefers published_starts_at when present", () => { /* ... */ });

  it("FALLS BACK to starts_at when published is null", () => {
    // Verified live: published_* is null on real events. Assuming it is always
    // present renders a blank row.
  });

  it("carries a tag's real hex colour through", () => { /* ... */ });

  it("keeps an event with no tags rather than dropping it", () => {
    // Filtering is the operator's job; the client does not editorialise.
  });
});
```

- [ ] **Step 3: Run it, watch it fail, implement, watch it pass**

Run `npx tsx --test main/services/pco-calendar-service.test.ts` before and after.

- [ ] **Step 4: Prove the overlap guard**

Change the query to a `starts_at` range (`gte`/`lte` both on `starts_at`). Run the test file. The overlap test must fail. Restore, re-run green, and report the exact failing test name.

- [ ] **Step 5: Commit**

```
feat(pco): a calendar client

Reads /calendar/v2 event instances over a window, filtered by calendar and
tag server-side.

The query asks for OVERLAP -- starts_at <= windowEnd AND ends_at >=
windowStart -- not a starts_at range. A range drops a multi-day event already
in progress on day one of a grid, which is the failure nobody notices because
the event is simply absent.

published_starts_at is a real instant but is sometimes null, so the mapper
falls back to starts_at.

Proven red: a starts_at range fails the overlap guard.
```

---

## Task 2: Day bucketing, server-side, in the app time zone

The renderer has no access to `app-timezone.ts` — deliberately, it is server-only. All-day events arrive as local midnight expressed in UTC (`05:00Z` for CDT). If the client buckets by UTC date, every all-day event lands on the wrong day, and a UTC-clocked host gets it wrong for timed events after 19:00 local too.

**Files:**
- Create: `main/services/calendar-grid.ts`, `main/services/calendar-grid.test.ts`

**Interfaces produced:**
```ts
export interface CalendarDay { date: string; /* YYYY-MM-DD, local */ events: CalendarEventDTO[]; }
export interface CalendarGrid { monthLabel: string; days: CalendarDay[]; /* always 42, six weeks */ }
export function buildGrid(events: readonly CalendarEventDTO[], monthAnchorIso: string, zone: string): CalendarGrid;
export function gridWindow(monthAnchorIso: string, zone: string): { fromIso: string; toIso: string };
```

- [ ] **Step 1: Write the failing test**

```ts
describe("bucketing happens in the app zone, not UTC", () => {
  it("puts an all-day event on its LOCAL day", () => {
    // Verified live: an all-day event arrives as 05:00Z in a UTC-6 zone. Bucketed
    // by UTC date that is the right day by luck in summer and the wrong day in
    // winter; bucketed by local date it is always right.
  });

  it("puts a late-evening event on the day it happened locally", () => {
    // 2026-08-25T02:30:00Z is the 24th at 21:30 in America/Chicago. A UTC bucket
    // files it under the 25th and the operator sees it on the wrong square.
  });

  it("spans a multi-day event across every day it touches", () => { /* ... */ });

  it("always returns 42 days, so the grid does not reflow between months", () => { /* ... */ });

  it("windows the query to the whole visible grid, not the calendar month", () => {
    // gridWindow must cover the leading and trailing days of adjacent months
    // that the six-week grid shows, or those squares are silently empty.
  });
});
```

- [ ] **Step 2: Run, fail, implement, pass**

Use `main/services/app-timezone.ts` for every wall-clock decision. Do not add a date library and do not use the host clock.

- [ ] **Step 3: Prove the zone guard**

Bucket by UTC date instead of the app zone. The all-day test and the late-evening test must both fail. Restore, re-run, report both names.

- [ ] **Step 4: Commit**

```
feat(calendar): bucket a month grid in the app time zone

The renderer has no access to app-timezone by design, and an all-day event
arrives as local midnight expressed in UTC. Bucketing on the client would put
every all-day event on the wrong day on a UTC-clocked box -- the same class of
failure that once stopped every recorder mid-service.

The window covers the whole visible six-week grid, not the calendar month, or
the leading and trailing squares are silently empty.

Proven red: bucketing by UTC date fails the all-day and late-evening guards.
```

---

## Task 3: The eighth View kind

Adding a kind touches nine files that name the set. Since the multiview work, three of them are compile-checked — `tsc` will name them. The rest will not complain, so this task's value is doing all nine deliberately.

**Files (all nine, verified by `grep -rln '"spl-rundown"'`):**
`main/types/views.ts` · `main/services/routes/context.ts` · `renderer/main/layout-objects.ts` · `renderer/main/stage-view.tsx` · `renderer/main/embedded-view.tsx` · `renderer/settings/sections/new-view-dialog.tsx` · plus the three test files that hold seven-element lists: `renderer/main/embedded-view.test.tsx`, `renderer/main/scriptview-surfaces.test.ts`, `renderer/settings/sections/new-view-dialog.test.ts`

- [ ] **Step 1: Add the kind and let the type checker find the rest**

Add `"calendar"` to `ViewKind` in `main/types/views.ts`. Run `npx tsc --noEmit -p tsconfig.json` and record every file it names. Those are your compile-checked sites; the others you must find by grep.

- [ ] **Step 2: Wire each site**

- `stage-view.tsx` — a real `case "calendar"` inside the switch. The switch is exhaustive with a `never` default; do not weaken it.
- `embedded-view.tsx` — a case so a calendar renders inside a multiview tile. This is the point of the feature being a View at all.
- `layout-objects.ts` — add to `EMBEDDABLE_VIEW_KINDS`.
- `context.ts` — `isDisplayKind`, or a calendar view cannot be created.
- `new-view-dialog.tsx` — the create-view UI, with a label and a one-line description.
- The three test files' hardcoded lists — update the EXACT expected sets. Keep them exact; a floor with slack is how three config stores went missing from every backup.

- [ ] **Step 3: Prove the exhaustiveness still bites**

Comment out the `case "calendar"` arm in `stage-view.tsx`. `tsc` must fail naming it. Restore. Report the error text.

- [ ] **Step 4: Commit**

```
feat(views): a calendar view kind

Nine files name the kind set; three are compile-checked since the multiview
work and named themselves, the other six were found by grep and done in the
same change.

Embeddable from the start -- a calendar that cannot go in a producer tile is
half a feature.
```

---

## Task 4: The month grid

**Files:**
- Create: `renderer/main/calendar-view.tsx`, `renderer/main/calendar-view.test.tsx`
- Modify: the two render sites from Task 3

**Design constraints, from the verified numbers:**
- Filtering is the density strategy: one department tag took a 13-event day to **3**. Build for the filtered case.
- Still build a **"+N more"** affordance for unfiltered days; 13 will not fit and silently clipping is worse than saying so.
- This is an **office display**, read at desk distance — not a stage display read from thirty feet. Type may be smaller and denser than the kiosk norm. Say so in a comment so nobody "fixes" it to stage sizes.
- Tag colour tints an event. Two cautions: some tag colours are near-white (`#E0E0E0` in the real data) and need a contrast floor against the surface; and several are lavender — that is the ORG'S data, not app chrome, so the zero-purple rule does not apply to it. Write that reasoning in a comment or someone will "correct" it.

- [ ] **Step 1: Write the failing test**

```ts
describe("the grid draws what it was given", () => {
  it("renders six weeks, so the layout does not jump between months", () => {});
  it("puts an event on its bucketed day", () => {});
  it("marks today", () => {});
  it("shows +N more rather than silently clipping a busy day", () => {
    // Assert the overflow count is CORRECT, not merely present. A "+3 more" on
    // a day with five hidden is a lie in a smaller font.
  });
  it("HIGHLIGHTS the event happening now", () => {});
  it("highlights only ONE event when several overlap", () => {
    // Overlapping bookings are normal here. Two highlights read as a bug.
  });
  it("highlights nothing when nothing is running", () => {});
  it("keeps a tag colour that would be invisible readable", () => {
    // A near-white tag colour exists in real data.
  });
  it("says so when the window is empty rather than drawing a blank grid", () => {});
});
```

- [ ] **Step 2: Run, fail, implement, pass**

Follow the harness in `renderer/main/embedded-view.test.tsx` — `installDom()`, the `EventSource`/`fetch` stubs, `act()`, flushing promises before teardown. Use `makeRenderCtx` from `renderer/main/test-render-ctx.ts`; **do not** reintroduce an `as never` cast.

"Now" must come from the render context's clock (`ctx.now`, skew-corrected), not `Date.now()` — the repo has one clock and this must use it.

- [ ] **Step 3: Prove two guards**

Remove the current-event highlight → its test fails. Hardcode the overflow count to a constant → the count test fails. Restore both; report both names.

- [ ] **Step 4: Commit**

---

## Task 5: Choosing what appears

**Files:**
- Modify: `main/types/views.ts` (per-view config), `renderer/settings/sections/view-detail.tsx`, `main/services/stage-controller.ts`
- Create: `renderer/settings/sections/calendar-sources.tsx`

Two multi-selects: **calendars** and **tags**, both read live from PCO so a renamed tag appears under its new name. Follow `renderer/settings/sections/checklist-sources.tsx` — it solves the identical problem for plan notes, including keeping a stored name that PCO no longer offers rather than silently dropping the operator's choice.

**Config lives on the VIEW**, not globally: two calendar views on two screens should be able to show different departments. Confirm where a View's per-kind config lives (`scriptViewLayoutId` is the precedent) and follow it.

**Empty means everything** for calendars, because a calendar view with nothing chosen should still show something on first creation. That is the opposite of the checklist's rule, and the difference is deliberate: a checklist that fills itself is noise, an empty calendar is broken. Write the reason down.

- [ ] Steps: failing test → implement → prove red (delete the "stored name PCO no longer offers" handling and watch its test fail) → commit.

---

## Task 6: Docs

- `docs/integrations/planning-center.md` — a Calendar section: which endpoint, that filtering is by calendar and tag, and that the app pins an API version.
- `docs/reference/widgets.md` and `docs/reference/layout-editor.md` — the new kind, and that it is embeddable.
- State plainly that there is **no booking-vs-event distinction**, because PCO does not model one — so the next person does not go looking for the setting.

Docs are concise reference for a stranger on GitHub: no changelog voice, no "this used to".

---

## Self-Review

**Coverage.** Monthly grid (Task 4), every event from the calendar (Task 1), current-event highlight (Task 4), fully routable and embeddable (Task 3). Filtering (Task 5) is not a nice-to-have — the verified numbers make it the difference between usable and not.

**Ordering.** 1 and 2 are pure and server-side and can be built in parallel; 3 is plumbing; 4 needs 3; 5 needs 1. Task 2 must precede 4, because 4 renders what 2 produces.

**The risk worth naming.** Task 1 must decide whether to share `pco-service.ts`'s request plumbing. Extracting it touches the live-service path, which is the most safety-critical code in the app; duplicating it violates the repo's strongest rule. The plan asks the implementer to choose and justify rather than pretending there is an obvious answer — and to prefer the safer route if the extraction looks like it would destabilise the live path.

**Not verified, and flagged rather than assumed.** The API version to pin is being established by separate work on `fix/pco-freshness`; this plan should adopt whatever that lands on rather than choosing a second one. Recurring-event exceptions and cancelled instances were never observed in the sample — if the implementer meets one, it is new information and belongs in the report, not in an assumption.
