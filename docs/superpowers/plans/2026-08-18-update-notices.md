# Update Notices Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A toast when an update is available, a dot on Advanced while it is, and a dialog with grouped release notes after a successful update — each shown once.

**Architecture:** A runtime store records what has been announced and what was just installed. The updater snapshots the notes before applying, because after the restart the live status describes the next update. Availability becomes one shared predicate rather than a third copy of an expression.

**Tech Stack:** TypeScript, node:test, React 19, the existing `update:status` SSE channel, `DataStore`.

**Spec:** `docs/superpowers/specs/2026-08-18-update-notices-design.md`
**Mockup:** https://claude.ai/code/artifact/8d84782a-dd78-46e9-b788-589580c7f7d5

## Global Constraints

- No emojis anywhere.
- `update-notices.json` is classified **runtime** in its `DataStore` constructor and imported by `main/services/stores.ts`, or it silently misses the registry.
- A new `catch` rethrows or returns the failure. One that only logs is a defect.
- Every guard proven by reintroducing its bug, in-session, said so in the commit.
- Nothing may open a socket from a service whose job is data — that hung CI once already.
- Run the full gate before each commit and read the output.

## File Structure

| File | Responsibility |
|---|---|
| `main/services/update/release-notes.ts` | Pure: parse a release body into `{ section, lines }[]`. |
| `main/services/update-notices-store.ts` | Runtime store: `announcedTag`, `justUpdated`. |
| `main/services/update/availability.ts` | Pure: `isUpdateAvailable(status)`, one definition. |
| `main/services/updater.ts` | Snapshot notes before applying; record `justUpdated` after. |
| `main/services/routes/system-routes.ts` | `GET /api/update/notices`, `POST /api/update/notices/dismiss`. |
| `renderer/app/update-notices.tsx` | The toast trigger and the post-update dialog. |
| `renderer/app/rail.tsx` | The dot; move off the one-shot fetch onto the live query. |

---

### Task 1: Parse notes into sections

**Files:**
- Create: `main/services/update/release-notes.ts`, `release-notes.test.ts`
- Modify: `main/services/update/release-check.ts`

**Interfaces:**
- Produces: `parseReleaseSections(body: string, cap?: number): { section: string; lines: string[] }[]`

Today `changeLinesFrom()` (`release-check.ts:126`) keeps bullets under
`## New|Fixed|Changed|Improved|Breaking` and flattens them, discarding which
section each came from. This keeps the section and raises the cap.

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseReleaseSections } from "./release-notes.js";

describe("release notes, by section", () => {
  test("keeps each bullet under the heading it came from", () => {
    const out = parseReleaseSections(`
## New
- Export a layout
- Find a server by name

## Fixed
- Duplicating a console no longer makes a display
`);
    assert.deepEqual(out, [
      { section: "New", lines: ["Export a layout", "Find a server by name"] },
      { section: "Fixed", lines: ["Duplicating a console no longer makes a display"] },
    ]);
  });

  test("Breaking is kept as its own section, not folded in", () => {
    // A breaking change reading as one bullet among twenty is the failure this
    // whole grouping exists to prevent.
    const out = parseReleaseSections("## Breaking\n- Slugs are now required\n");
    assert.deepEqual(out.map((s) => s.section), ["Breaking"]);
  });

  test("markdown emphasis and backticks are stripped from a line", () => {
    const out = parseReleaseSections("## New\n- **Bold** and `code`\n");
    assert.deepEqual(out[0].lines, ["Bold and code"]);
  });

  test("a body with no recognised sections yields nothing, not one blob", () => {
    // Better an empty dialog body than a heading over unrelated prose.
    assert.deepEqual(parseReleaseSections("Some prose.\n- a bullet\n"), []);
  });

  test("the cap bounds total lines, not lines per section", () => {
    const body = "## New\n" + Array.from({ length: 40 }, (_, i) => `- n${i}`).join("\n");
    const out = parseReleaseSections(body, 10);
    assert.equal(out.reduce((n, s) => n + s.lines.length, 0), 10);
  });

  test("an empty section is dropped rather than shown as a bare heading", () => {
    assert.deepEqual(parseReleaseSections("## New\n\n## Fixed\n- one\n").map((s) => s.section), ["Fixed"]);
  });
});
```

- [ ] **Step 2: Run it, watch it fail** — `Cannot find module './release-notes.js'`.

- [ ] **Step 3: Implement**, then have `changeLinesFrom()` delegate: it flattens
  `parseReleaseSections(body)` so the existing `status.changelog` is unchanged
  and there is one parser, not two.

- [ ] **Step 4: Run the tests.** Existing release-check tests must still pass —
  that is what proves the flattening is equivalent.

- [ ] **Step 5: Commit.**

---

### Task 2: The runtime store, and one definition of "available"

**Files:**
- Create: `main/services/update-notices-store.ts`, `main/services/update/availability.ts`, tests
- Modify: `main/services/stores.ts`, `renderer/settings/sections/advanced-section.tsx`

**Interfaces:**
- Produces: `updateNoticesStore` (`DataStore<UpdateNotices>`, `"runtime"`), and
  `isUpdateAvailable(status: UpdateStatus): boolean`, `availableCount(status): number`.

- [ ] **Step 1: Write the failing tests**

```ts
test("the store is classified runtime, not config", async () => {
  // An observation, not the operator's work: restoring last month's snapshot
  // must not re-announce a version or suppress one.
  const { configFilenames, runtimeFilenames } = await import("./store-registry.js");
  assert.ok(runtimeFilenames().includes("update-notices.json"));
  assert.ok(!configFilenames().includes("update-notices.json"));
});

test("available follows tagBased", () => {
  assert.equal(isUpdateAvailable({ tagBased: true, releasesBehind: 2, behindUserFacing: 0 } as UpdateStatus), true);
  assert.equal(isUpdateAvailable({ tagBased: false, releasesBehind: 0, behindUserFacing: 3 } as UpdateStatus), true);
  assert.equal(isUpdateAvailable({ tagBased: true, releasesBehind: 0, behindUserFacing: 9 } as UpdateStatus), false);
});
```

- [ ] **Step 2: Implement**, import the store in `stores.ts`, and replace the
  expression in `advanced-section.tsx` with `isUpdateAvailable`.

- [ ] **Step 3: Prove the classification guard** — flip the constructor argument
  to `"config"` and watch the registry test go red. Restore.

- [ ] **Step 4: Commit.**

---

### Task 3: Snapshot the notes before applying

**Files:**
- Modify: `main/services/updater.ts`
- Test: `main/services/update-notices.test.ts`

The crux: after the restart `status.changelog` describes the **next** pending
update, so the notes must be captured before `launch()` spawns the child.

- [ ] **Step 1: Write the failing test** — call the capture with a status whose
  `targetTag` is `v1.12.0`, assert the store holds that version, the version it
  came from, and the parsed sections. Then simulate a restart by re-reading the
  store from disk and assert it survives.

- [ ] **Step 2: Implement.** In `applyUpdate()`, before `launch()`, write
  `justUpdated` with `version: targetTag`, `fromVersion: this.status.version`,
  and the sections. Failure to write must not block the update — a box that
  cannot record a notice must still be able to install — so it is caught and
  logged, and that is the one place a log-only catch is correct because there is
  no caller left to tell.

- [ ] **Step 3: Verify against a real server** on a copied data dir: read
  `update-notices.json` after triggering the write and confirm the content, then
  restart the server and confirm it is still there.

- [ ] **Step 4: Commit.**

---

### Task 4: Announce only on delivery

**Files:**
- Modify: `main/services/updater.ts` or `stage-controller.ts` (wherever the
  broadcast lives), `main/services/routes/system-routes.ts`
- Test: `main/services/update-notices.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
test("an update found with nobody connected is not announced", () => {
  // Marking at detection means a 3am release is announced to an empty room and
  // never seen. This is the whole point of delivery-time marking.
  channelHasSubscribers = () => false;
  announceIfNew(statusWith("v1.12.0"));
  assert.equal(store.announcedTag, null);
});

test("connecting a client then announces it exactly once", () => {
  channelHasSubscribers = () => true;
  announceIfNew(statusWith("v1.12.0"));
  announceIfNew(statusWith("v1.12.0"));
  assert.equal(sent.filter((m) => m.channel === "update:notice").length, 1);
});
```

`channelHasSubscribers` already exists in `main/services/broadcaster.ts`.

- [ ] **Step 2: Implement.** A new broadcast channel `update:notice` carrying
  `{ tag, version }`; `announcedTag` is written only when the broadcast had a
  subscriber. Add the channel to `renderer/lib/sse-channels.ts`.

- [ ] **Step 3: Prove the guard** — mark at detection instead of delivery and
  watch the first test go red.

- [ ] **Step 4: Commit.**

---

### Task 5: The routes

**Files:**
- Modify: `main/services/routes/system-routes.ts`, `renderer/lib/api.ts`

- [ ] `GET /api/update/notices` returns `{ justUpdated }`.
- [ ] `POST /api/update/notices/dismiss` clears `justUpdated` and returns `{ ok: true }`.
- [ ] Channels `update:notices` and `update:dismissNotice`. Do **not** add a
      channel before its caller exists — the channel guard refuses one with no
      caller, which is correct.
- [ ] Drive both with curl against a real server, including dismiss actually
      clearing the file on disk.
- [ ] Commit.

---

### Task 6: The toast and the dialog

**Files:**
- Create: `renderer/app/update-notices.tsx`
- Modify: `renderer/app/shell.tsx`, `renderer/lib/api.ts`

- [ ] **Step 1: Build it.** One component mounted in the shell, so it works on
      every page rather than only on Advanced. It subscribes to `update:notice`
      and toasts `Stage Utility <version> is available — Advanced to install`.
      It fetches `update:notices` on mount and renders the dialog when
      `justUpdated` is set.
- [ ] **Step 2: The dialog.** Version in the title, `From <x>` beneath, sections
      as headings with their lines. With no sections it shows the title alone —
      an empty dialog reads as broken. One Dismiss button, which calls the
      dismiss channel and closes.
- [ ] **Step 3: Drive it in a browser.** Seed `update-notices.json` on a copied
      data dir with a `justUpdated` containing all three sections; confirm the
      dialog renders them grouped, Dismiss clears the file, and a reload does
      **not** bring it back.
- [ ] **Step 4: Confirm a reload without dismissing DOES bring it back** — that
      is the difference between recording it server-side and not.
- [ ] **Step 5: Commit.**

---

### Task 7: The dot, and the rail's stale fetch

**Files:**
- Modify: `renderer/app/rail.tsx`, `renderer/components/ui/sidebar.tsx`

- [ ] **Step 1: Move the rail onto the live query.** It currently does a one-shot
      `invoke<UpdateStatus>("update:status")` on mount, so both the dot and the
      version label it already shows would be stale until reload. Use
      `useUpdateStatus()`.
- [ ] **Step 2: Render the dot** as a child of the Advanced `SidebarListItem`,
      which already renders `{children}`. Position it absolutely in the collapsed
      rail, where the label is `sr-only` and the dot is the only visible signal.
- [ ] **Step 3: The accessible name.** The row must read "Advanced, update
      available" — the dot is decoration and carries none of the meaning.
- [ ] **Step 4: Drive it in a browser**, expanded and collapsed, with the dot
      appearing and disappearing as availability changes.
- [ ] **Step 5: Commit.**

---

### Task 8: Documentation

- [ ] Update `docs/ops/updates-and-logs.md`: what you are told and when, that a
      notice is announced once and only when somebody is connected, and that the
      release dialog waits for a dismissal.
- [ ] Commit.

## Self-review

**Spec coverage.** Sections preserved and cap raised → Task 1. Runtime store and
one availability predicate → Task 2. Notes snapshotted before applying →
Task 3. Announce only on delivery → Task 4. Routes and dismissal → Task 5.
Toast, dialog, empty-notes case → Task 6. Dot in both rail states, plus the
stale-fetch fix → Task 7.

**Known gap accepted:** the git-checkout update path builds `changelog` from
commit subjects, which have no sections. Those installs get one unlabelled group
rather than headings — the packaged path is where release bodies exist. Called
out rather than pretended away.

**Type consistency.** `parseReleaseSections` returns the same
`{ section, lines }[]` shape stored in `justUpdated.notes` and rendered in
Task 6. `isUpdateAvailable` from Task 2 is used by Tasks 4 and 7 and by
`advanced-section.tsx`.
