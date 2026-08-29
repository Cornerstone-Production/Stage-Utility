# Stage View: Resolve, Then Render

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decide what a screen should show in one pure, tested function, and let the component render that decision — with no behaviour change.

**Architecture:** `StageView` currently interleaves three unrelated kinds of decision across 14 returns and nine derived values. A pure `resolveScreen()` produces a tagged union; the component becomes one `switch` over it. Every state becomes testable without a DOM, which today none of them are.

**Tech Stack:** TypeScript, React 19, `node:test` + `@testing-library/react` with the repo's `installDom()` harness.

---

## Why this is worth doing, and the part that is still dangerous

`renderer/main/stage-view.tsx` is the component **every wall display in the building renders**. It is 694 lines; `StageView` itself is ~340 of them with **14 returns**.

The view-kind dispatch was already converted to an exhaustive `switch`, so a missing kind is a compile error rather than a silent mic-slots grid. That fixed the worst of it. Three problems remain.

**1. A silent default that the exhaustive switch cannot catch.**

```ts
const kind: ViewKind = previewView?.kind ?? state.resolvedByOutput?.[displayId]?.kind ?? "slots";
```

`?? "slots"` means a screen whose routing failed to resolve renders **mic slots**. That is the same class of failure the switch was added to prevent, one level upstream — and the switch cannot help, because `kind` is a valid `ViewKind` by construction. The type checker sees nothing wrong.

**2. Three kinds of decision are braided together.** Lifecycle (loading, error, no state), output state (preview, blackout, unrouted, locked), and view kind are interleaved with the nine derived values they depend on. You cannot read one without tracking the other two, and a guard added in the wrong place changes behaviour for a blacked-out or unrouted screen silently.

**3. None of it is testable.** Twelve or so distinct outcomes, and the only way to verify any of them is to open a browser. Every guard interaction in this file has been verified by hand, for its whole life.

**What this plan does NOT do:** it is not a rewrite. The presentational components (`KioskTopBar`, `KioskLoading`, `KioskUnrouted`, `KioskError`, `KioskFrame`, `KioskEmpty`, `KioskNotConfigured`) are cohesive and stay exactly as they are. Only the decision moves.

## Global Constraints

- Branch `refactor/stage-view-resolver` off `beta`. Every change is a PR; **never** push to `beta`/`main`, never `gh pr merge`.
- **NO BEHAVIOUR CHANGE** in Tasks 1-2. Every input that produces a given screen today must produce the same screen after. Task 3 changes exactly one behaviour, deliberately and visibly.
- No new npm dependencies. No emojis. **NO Claude attribution footer on any commit.**
- Public repo: no credentials, real service-type ids, LAN addresses, church names or customer ids.
- Any new `catch` rethrows or returns the failure.
- Every guard proven red in the session that writes it. This repo has shipped nine tests that passed on the exact defect they were written for; every one was caught by someone reintroducing the bug and watching.
- Run before every commit: `npx tsc --noEmit -p tsconfig.json`, `npx eslint main/ renderer/`, `npm test`, `npm run build`.

---

## Task 1: The resolver, pure and tested, wired to nothing

Land the decision function with tests BEFORE any component consumes it. If the extraction is wrong, that is a failing test rather than a wrong screen.

**Files:**
- Create: `renderer/main/stage-screen.ts`, `renderer/main/stage-screen.test.ts`

**Interfaces produced:**
```ts
export type StageScreen =
  | { k: "loading" }
  | { k: "error"; message: string }
  | { k: "blackout" }
  | { k: "unrouted"; displayName: string | null; locked: boolean }
  | { k: "not-configured"; displayName: string | null; locked: boolean }
  | { k: "empty"; displayName: string | null; locked: boolean }
  | { k: "view"; kind: ViewKind; view: View | null; displayId: string;
      displayName: string | null; locked: boolean; isPreview: boolean };

export interface ScreenInput {
  state: StageState | null;
  isLoading: boolean;
  error: string | null;
  displayId: string;
  previewViewId: string | null;
}

export function resolveScreen(input: ScreenInput): StageScreen;
```

- [ ] **Step 1: Read the current component first, in full**

Read `renderer/main/stage-view.tsx` from the top of `StageView` to the end of the switch. Write down, in your report, every path in order: which condition, which screen, and which derived values it depends on. **You cannot extract logic you have not enumerated.** The nine derived values are `previewView`, `multiDisplay`, `currentDisplay`, `kind`, `displayName`, `resolved`, `outputLocked`, `isUnrouted`, and `activeView` (computed twice, inside two different arms — check whether the two agree).

- [ ] **Step 2: Write the failing tests, one per path you enumerated**

Create `renderer/main/stage-screen.test.ts`. These are pure — no DOM, no harness. Build a minimal `StageState` fixture locally, or reuse `DEFAULT_STAGE_STATE` from `renderer/main/test-render-ctx.ts` if it fits.

Cover, at minimum:
```ts
describe("lifecycle comes first", () => {
  it("loading beats everything, including a blackout", () => {});
  it("an error beats a missing state", () => {});
  it("a missing state is an error, not an empty screen", () => {});
});

describe("output state", () => {
  it("BLACKOUT beats the routed view", () => {
    // Toggling blackout off must restore the view instantly, so blackout is a
    // state, not a property of the view.
  });
  it("a PREVIEW ignores blackout", () => {
    // The settings live preview renders a view regardless of output routing.
  });
  it("an output with no view routed is unrouted, not empty", () => {});
  it("carries the lock through, and never locks a preview", () => {});
  it("names the display only when there is more than one", () => {
    // Today displayName is null on a single-display install. Preserve that.
  });
});

describe("the view kind", () => {
  it("prefers the preview's kind over the routed one", () => {});
  it("takes the routed view's kind when not previewing", () => {});
  it("resolves the View object the arm will need", () => {
    // activeView is computed inside two arms today. Resolve it once here and
    // confirm both old computations agree — if they do not, that is a finding,
    // not something to smooth over.
  });
});
```

Add a test per path you enumerated in Step 1 that is not already covered above.

- [ ] **Step 3: Run them, watch them fail, implement, watch them pass**

Implement `resolveScreen` by **moving** the logic, not rewriting it. Where the current code is subtle, carry the comment with it — several of those comments record real bugs (the `displays` shim, the preview-vs-blackout precedence, why a lock never applies in the preview iframe).

For now, preserve `?? "slots"` exactly as it is. Task 3 changes it; changing it here would mix a refactor with a behaviour change and you would not know which one broke something.

- [ ] **Step 4: Prove the tests bite**

Pick two paths and invert their conditions one at a time — swap the blackout and unrouted checks, then make `displayName` unconditional. Each must fail a named test. Restore and re-run. Report both names.

- [ ] **Step 5: Commit**

```
feat(stage): decide what a screen shows in one pure function

StageView interleaves lifecycle, output state and view kind across 14 returns
and nine derived values, so none of the twelve outcomes can be verified
without opening a browser -- which is how every guard interaction in this file
has been checked for its whole life.

resolveScreen is that decision, pure and tested. Nothing consumes it yet: if
the extraction is wrong, this is a failing test rather than a wrong screen in
an auditorium.

Behaviour is moved, not rewritten. `?? "slots"` is preserved verbatim here and
addressed separately.
```

---

## Task 2: The component renders the decision

**Files:**
- Modify: `renderer/main/stage-view.tsx`
- Create: `renderer/main/stage-view-paths.test.tsx`

- [ ] **Step 1: Write the behaviour-parity test FIRST**

Before touching the component, create `renderer/main/stage-view-paths.test.tsx` and assert what each screen renders TODAY. Use the harness in `renderer/main/embedded-view.test.tsx` (`installDom()`, `EventSource`/`fetch` stubs, `act()`, flushing promises before teardown). Use `makeRenderCtx` where a render context is needed; **do not** reintroduce an `as never` cast.

One test per outcome: loading, error, no state, blackout, unrouted, locked, preview, each of the seven view kinds, and the not-configured and empty screens beneath `slots`.

Run it against the UNCHANGED component and confirm it passes. That is your parity baseline — if these tests only pass after the refactor, they are describing the new code rather than protecting the old.

- [ ] **Step 2: Replace the chain with one switch over the resolver**

`StageView` keeps its hooks and effects. Everything from the first `if (isLoading)` to the end of the kind switch becomes:

```tsx
const screen = resolveScreen({ state, isLoading, error, displayId, previewViewId });
switch (screen.k) {
  case "loading": return <KioskLoading />;
  // ... one arm per state
  case "view": return renderView(screen);
  default: { const _never: never = screen; void _never; return null; }
}
```

Keep the view-kind switch — move it into a `renderView` helper taking the resolved `{ k: "view" }` value. Two exhaustive switches, one over screen state and one over kind, each with a `never` default.

**The hooks must not move below a conditional return.** React requires stable hook order; a hook that ends up after an early return is a violation that will not always fail loudly. Verify the hook order is unchanged.

- [ ] **Step 3: Run the parity tests**

They must pass **unchanged**. If a parity test needs editing to pass, that is a behaviour change — stop and report it rather than editing the test. That is the entire safety mechanism of this task.

- [ ] **Step 4: Prove the second switch bites**

Add a temporary member to `StageScreen`. `tsc` must fail naming `stage-view.tsx`. Remove it, re-run clean. Report the error.

- [ ] **Step 5: Drive it**

```bash
npm run build
SCRATCH=$(mktemp -d); STAGE_UTILITY_DATA="$SCRATCH" STAGE_UTILITY_PORT=8799 npx tsx server.ts &
```
In a browser: create a screen, confirm the unrouted screen; route it to a slots view; blackout it and confirm black, un-blackout and confirm instant restore; open a settings live preview and confirm it renders regardless of routing. Kill by port (`lsof -ti tcp:8799 | xargs -r kill -9`), never `pkill -f`.

- [ ] **Step 6: Commit**

```
refactor(stage): render the decision instead of re-deriving it

StageView is now one switch over resolveScreen's result, plus a second
exhaustive switch over the view kind. Fourteen scattered returns become one
arm per state, and the guards that must run first are ordered inside a pure
function rather than by their position in a component body.

No behaviour change: the parity tests were written against the old component
and pass unchanged against the new one.
```

---

## Task 3: Two real bugs, fixed deliberately

Now, and only now, change the behaviour that should change. Both of these were
found by extracting the resolver — neither was visible while the logic was
braided through the component.

### 3a — `displayName` renders a URL slug

On a multi-display install, when a **preview's View has been deleted**,
`displayName` falls through to the literal `preview-<id>` slug. The screen
labels itself with a URL fragment.

Trace it in the resolver, decide what it SHOULD say — the display's real name if
one is reachable, otherwise no name at all rather than a slug — and fix it there.
A test that the slug never reaches a rendered name, proven red by restoring the
fallthrough.

### 3b — The silent slots default

Now, and only now, change the one behaviour that should change.

```ts
const kind: ViewKind = previewView?.kind ?? state.resolvedByOutput?.[displayId]?.kind ?? "slots";
```

A screen whose routing fails to resolve renders **mic slots** — somebody else's roster on a wall, with nothing indicating anything went wrong. It is the same failure the exhaustive switch was added to prevent, one level upstream, and invisible to the type checker because `kind` is a valid `ViewKind` either way.

- [ ] **Step 1: Confirm the reachability finding**

Task 1 established that the ONLY live reach is a **preview of a deleted View** —
a real output hits the `isUnrouted` guard first, so the mic-slots-on-a-wall
scenario cannot happen through normal routing. Confirm that yourself rather than
inheriting it; if a real output CAN reach it, this is a bigger fix than planned
and you should say so before changing anything.

Given the finding holds, this is a **preview-only** defect. That lowers the
stakes but does not remove them: an operator previewing a deleted View sees a
mic-slots grid and no indication anything is wrong. **If the fallback turns out
to be fully dead, delete it** rather than inventing a state for it — that is the
cheaper and more honest outcome.

- [ ] **Step 2: If it IS reachable, make it say so**

Resolve to a distinct state rather than a wrong screen. `{ k: "unresolved" }` rendering a notice — the display name, and that its view could not be resolved — beats a roster nobody asked for. Follow the copy standard set by the unknown-kind arm: say what happened and what to do, and do not blame something that did not fail.

- [ ] **Step 3: Test and prove**

A test that the unresolvable input produces the notice, not slots. Prove it red by restoring `?? "slots"`.

- [ ] **Step 4: Commit**

---

## Task 4: Docs

Only if Task 3 changed a visible behaviour. Update `docs/reference/` where a screen's states are described, and note the new one. Docs are concise reference for a stranger on GitHub — no changelog voice, no "this used to".

---

## Self-Review

**Scope.** Decision extracted, tested, and consumed; one real bug addressed separately from the refactor. The presentational components are untouched — they were never the problem.

**Ordering.** Task 1 lands the resolver with nothing depending on it, so an extraction error is a red test. Task 2's parity tests are written against the OLD component before it changes, which is what makes "no behaviour change" a verified claim rather than an intention. Task 3 comes last so the one deliberate change is not tangled with the refactor.

**The risk, named.** This is the component every wall display renders, and the failure mode is a wrong or dark screen in an auditorium with nobody beside it. The mitigation is that Task 2 changes nothing the parity tests cannot see, and those tests exist before the change. If a parity test has to be edited to pass, the task has failed and must stop.

**What this deliberately does not do.** It does not split the file, move the presentational components, or touch the hooks and effects. Each of those is a separate decision, and bundling them would make the parity claim unverifiable.
