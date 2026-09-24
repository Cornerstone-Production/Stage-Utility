// timer-card.test.tsx — the Timer card says so when Finish could not save.
//
// BaptismState.saveErrors gets an entry when the write behind Finish rejects
// (see baptism-save-error.test.ts for the server half). This proves the card
// renders it: a note announced as an alert, naming the reason, saying where
// the session still exists, and carrying its own Dismiss. Without it the
// readout says "Finished" over a session Past sessions will never list.
//
// NOT proved here: how the note LOOKS. jsdom loads no stylesheet, so its colour,
// its border and whether it reads as an error beside the readout cannot be seen
// from a test; that is a check for a real browser.
//
// NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND, for the reason
// baptism-operator-armed.test.tsx gives: node:assert inspecting a live jsdom
// element to build a failure message does not finish in any useful time.

import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";

import { installRenderDom, settle, unmountAndTeardown } from "../../../test-dom.js";

const teardown = installRenderDom();

const { render, cleanup, fireEvent, act } = await import("@testing-library/react");
const React = await import("react");
const { TimerCard } = await import("./timer-card.js");
const { TooltipProvider, ConfirmHost, Toaster } = await import("../../../components/ui/index.js");
const { baptismSessionId } = await import("@main/types/stage");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => cleanup());

/** What the server puts in a saveErrors entry's reason: never a path (see
 *  saveFailureReason). */
const DISK = "ENOSPC: no space left on device";

/** A grouped session just finished: one person testified and was baptized. */
const FINISHED: BaptismState = {
  mode: "grouped",
  phase: "idle",
  personNumber: 1,
  baptismIndex: 0,
  armed: false,
  segmentStartedAt: null,
  segmentAccumMs: 0,
  sessionStartedAt: "2026-09-20T15:00:00.000Z",
  finishedAt: "2026-09-20T15:12:00.000Z",
  people: [{ testimonyMs: 95_000, baptizeMs: 41_000 }],
  pendingTestimonyMs: null,
  serviceTitle: "9am",
  serviceTypeId: "svc-1",
  planId: "plan-1",
  saveErrors: [],
};

/** One saveErrors entry for `sessionStartedAt` (FINISHED's own, by default). */
function failedSave(reason: string, sessionStartedAt = FINISHED.sessionStartedAt!) {
  return [{ sessionId: baptismSessionId(sessionStartedAt), serviceKey: null, reason }];
}

/** BaptismTriggersPanel, inside the card, reads the plan and its bindings; an
 *  empty answer leaves it rendering nothing, which is all this test needs. */
const emptyFetch = (async () =>
  ({ ok: true, status: 200, json: async () => ({}), text: async () => "" })) as unknown as typeof fetch;

async function mount(state: BaptismState): Promise<HTMLElement> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = emptyFetch;
  try {
    const view = render(
      React.createElement(TooltipProvider, null, React.createElement(TimerCard, { state, onFinished: () => {}, onRebuilt: () => {} })),
    );
    await settle();
    return view.container;
  } finally {
    globalThis.fetch = realFetch;
  }
}

const alertText = (root: ParentNode): string | null => {
  const el = root.querySelector('[role="alert"]');
  return el ? (el.textContent ?? "").replace(/\s+/g, " ").trim() : null;
};

test("a finished session whose save failed says it did not save, why, and where it still is", async () => {
  const root = await mount({ ...FINISHED, saveErrors: failedSave(DISK) });
  const text = alertText(root);
  assert.notEqual(text, null, "expected an alert on the card");
  assert.match(text!, /did not save/, "it says plainly that the session did not save");
  assert.ok(text!.includes(DISK), `it names the reason the write gave: ${text}`);
  assert.match(text!, /raw archive/, "it says where the session's presses still are");
});

test("a save that did not fail claims nothing", async () => {
  const root = await mount(FINISHED);
  assert.equal(alertText(root), null, "no alert when saveErrors is empty");
});

/** Mount with a fetch that records every request and stays installed until
 *  `restore` — a click after mount goes through the real invoke() to it. */
async function mountRecording(state: BaptismState): Promise<{ root: HTMLElement; calls: string[]; restore: () => void }> {
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${String(input)}`);
    return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
  }) as unknown as typeof fetch;
  const view = render(
    React.createElement(TooltipProvider, null, React.createElement(TimerCard, { state, onFinished: () => {}, onRebuilt: () => {} })),
  );
  await settle();
  return { root: view.container, calls, restore: () => void (globalThis.fetch = realFetch) };
}

const buttonNamed = (root: ParentNode, label: string) =>
  [...root.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === label);

test("the note has its own Dismiss, and pressing it asks the server to clear the failure", async () => {
  const { root, calls, restore } = await mountRecording({ ...FINISHED, saveErrors: failedSave(DISK) });
  try {
    const dismiss = buttonNamed(root, "Dismiss");
    assert.equal(!!dismiss, true, "expected a Dismiss control on the note");
    assert.equal(!!dismiss!.closest('[role="alert"]'), true, "it belongs to the note, not to the row of timer controls");
    fireEvent.click(dismiss!);
    await settle();
    assert.ok(
      calls.some((c) => c.startsWith("POST ") && c.endsWith("/api/baptism/dismiss-save-error")),
      `expected a POST to /api/baptism/dismiss-save-error, got ${JSON.stringify(calls)}`,
    );
  } finally {
    restore();
  }
});

test("after the workflow toggle the state holds nobody, and Dismiss is the only thing that clears the note", async () => {
  // setMode() carries saveErrors into a fresh idle state: no people, nothing
  // finished. The card renders no Reset and no Undo there.
  const { root, restore } = await mountRecording({
    ...FINISHED,
    mode: "per-person",
    personNumber: 0,
    finishedAt: null,
    sessionStartedAt: null,
    people: [],
    saveErrors: failedSave(DISK),
  });
  try {
    assert.notEqual(alertText(root), null, "the note is up");
    assert.equal(!!buttonNamed(root, "Reset"), false, "sanity: no Reset in an empty idle state");
    assert.equal(!!buttonNamed(root, "Undo"), false, "sanity: no Undo either");
    assert.equal(!!buttonNamed(root, "Dismiss"), true, "so the note needs a control of its own");
  } finally {
    restore();
  }
});

test("the note stays up while the next session runs, since Start carries the failure", async () => {
  const root = await mount({
    ...FINISHED,
    phase: "testimony",
    finishedAt: null,
    people: [],
    segmentStartedAt: "2026-09-20T16:00:00.000Z",
    saveErrors: failedSave(DISK),
  });
  const text = alertText(root);
  assert.notEqual(text, null, "the alert is not tied to the finished readout");
  assert.ok(text!.includes(DISK));
});

// A single field let session A fail, session B ALSO fail, and B's retry
// landing clear the note entirely -- A was never written. The note is now a
// list; this proves both a failed session's own entry shows
// and that a second failure does not replace the first.
test("two failed sessions both show their own line, naming their own reason", async () => {
  const OTHER = "EACCES: permission denied";
  const root = await mount({
    ...FINISHED,
    saveErrors: [
      ...failedSave(DISK, "2026-09-13T15:00:00.000Z"),
      ...failedSave(OTHER, "2026-09-20T15:00:00.000Z"),
    ],
  });
  const text = alertText(root);
  assert.notEqual(text, null, "expected an alert on the card");
  assert.ok(text!.includes(DISK), `expected the first session's own reason: ${text}`);
  assert.ok(text!.includes(OTHER), `expected the second session's own reason: ${text}`);
  assert.match(text!, /2 sessions did not save/, "the note counts both, not just the latest");
});

// ── each failed session offers its own Rebuild from raw ────────────────────
//
// The clearing itself — that a real rebuild through the real route restores
// the session and removes exactly its own entry, on the server, whichever
// route did it — is proven end to end in
// main/services/routes/baptism-rebuild-clears-save-error.test.ts, against a
// REAL failed save (addSession stubbed to reject) and the real routes; a
// component test cannot drive a real route at all. What belongs here is the
// UI: which serviceKey each entry's button targets, when it is disabled and
// why, and that a click confirms before posting — the same three things
// header.test.tsx already proves for the header's own Rebuild button, reused
// rather than re-derived.

function stubRebuildFetch(
  opts: { live?: boolean; rebuildAnswer?: unknown; rebuildStatus?: number } = {},
) {
  const calls: { url: string; body: unknown }[] = [];
  const fetchFn = (async (input: string, init?: RequestInit) => {
    const url = String(input);
    const ok = (json: unknown, status = 200) => ({
      ok: status < 400,
      status,
      json: async () => json,
      text: async () => JSON.stringify(json),
    });
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
    calls.push({ url, body });
    if (url.includes("/api/history/live")) return ok({ live: opts.live ?? false });
    if (url.includes("/api/baptism/rebuild")) {
      if (opts.rebuildStatus && opts.rebuildStatus >= 400) {
        const a = opts.rebuildAnswer as { error?: string; code?: string } | undefined;
        const errBody: { error: string; code?: string } = { error: a?.error ?? "Rebuild refused" };
        if (a?.code) errBody.code = a.code;
        return ok(errBody, opts.rebuildStatus);
      }
      return ok(
        opts.rebuildAnswer ?? { rows: 1, sessions: 1, updated: 0, added: 1, unchanged: 0, newer: 0, disagreeing: 0, invalid: 0, kept: 0, full: 0 },
      );
    }
    return ok({});
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

async function mountWithRebuild(
  state: BaptismState,
  opts: Parameters<typeof stubRebuildFetch>[0] = {},
): Promise<{ root: HTMLElement; calls: { url: string; body: unknown }[]; rebuiltCount: () => number; restore: () => void }> {
  const { fetchFn, calls } = stubRebuildFetch(opts);
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;
  let rebuiltCount = 0;
  const view = render(
    React.createElement(
      TooltipProvider,
      null,
      React.createElement(TimerCard, {
        state,
        onFinished: () => {},
        onRebuilt: () => {
          rebuiltCount += 1;
        },
      }),
      React.createElement(ConfirmHost),
      React.createElement(Toaster),
    ),
  );
  await settle();
  await settle(); // one more turn for the per-entry live-check's own fetch to resolve
  return {
    root: view.container,
    calls,
    rebuiltCount: () => rebuiltCount,
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}

const findInBody = (label: string) =>
  [...document.body.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === label) as HTMLElement | undefined;

const rebuildButtonsIn = (root: ParentNode) =>
  [...root.querySelectorAll('[role="alert"] button')].filter((b) => (b.textContent ?? "").includes("Rebuild from raw")) as HTMLButtonElement[];

const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();

/** Opens the button's own tooltip via keyboard focus (Radix's Tooltip opens
 *  on hover AND focus) and reads its rendered text, then closes it again —
 *  same technique as header.test.tsx's own tooltipTextOf, and the same reason
 *  it works even on a disabled button: jsdom does not enforce a real
 *  browser's "a disabled element cannot receive focus." */
async function tooltipTextOf(btn: HTMLElement): Promise<string> {
  fireEvent.focus(btn);
  await act(async () => {
    await settle();
    await settle();
  });
  const shown = text(document.querySelector('[role="tooltip"]'));
  fireEvent.blur(btn);
  await act(async () => {
    await settle();
  });
  return shown;
}

test("a failed entry with a serviceKey offers its own Rebuild from raw; one with none is disabled and says why", async () => {
  const { root, restore } = await mountWithRebuild(
    {
      ...FINISHED,
      saveErrors: [
        { sessionId: baptismSessionId("2026-09-13T15:00:00.000Z"), serviceKey: "svc-a", reason: DISK },
        { sessionId: baptismSessionId("2026-09-06T15:00:00.000Z"), serviceKey: null, reason: DISK },
      ],
    },
    { live: false },
  );
  try {
    const buttons = rebuildButtonsIn(root);
    assert.equal(buttons.length, 2, "expected one Rebuild action per failed entry");
    assert.equal(buttons[0]!.disabled, false, "an entry with a serviceKey, not live, must be usable");
    assert.equal(buttons[1]!.disabled, true, "an entry with no serviceKey has no raw rows to rebuild from");
    assert.match(
      await tooltipTextOf(buttons[1]!),
      /no service open.*no raw rows/i,
      "expected the disabled entry's own tooltip to say WHY, not just that it is off",
    );
  } finally {
    restore();
  }
});

test("the offer is disabled while THAT entry's own service is live", async () => {
  // A real serviceKey, not failedSave()'s own null: a null serviceKey is
  // already, on its own, disabled by the no-service branch — { live: true }
  // is never even consulted for it, so hard-coding "not-live" in the real
  // useServiceLive check would stay green here for the wrong reason.
  const { root, restore } = await mountWithRebuild(
    { ...FINISHED, saveErrors: [{ sessionId: baptismSessionId("2026-09-13T15:00:00.000Z"), serviceKey: "svc-live", reason: DISK }] },
    { live: true },
  );
  try {
    const buttons = rebuildButtonsIn(root);
    assert.equal(buttons.length, 1);
    assert.equal(buttons[0]!.disabled, true, "the server's own 'live' answer must disable this entry's own action");
  } finally {
    restore();
  }
});

test("clicking an entry's Rebuild confirms, then posts for THAT entry's serviceKey — never state.serviceKey", async () => {
  // state.serviceKey names the NEXT session once one has started (see
  // baptismSubline) — exactly what this must NOT target.
  const entryStartedAt = "2026-09-13T15:00:00.000Z";
  const { root, calls, rebuiltCount, restore } = await mountWithRebuild(
    {
      ...FINISHED,
      serviceKey: "svc-next-session",
      saveErrors: [{ sessionId: baptismSessionId(entryStartedAt), serviceKey: "svc-failed", reason: DISK }],
    },
    { live: false },
  );
  try {
    const [btn] = rebuildButtonsIn(root);
    fireEvent.click(btn!);
    await settle();
    const dialog = (document.body.textContent ?? "");
    assert.match(dialog, /Rebuild from raw\?/, "expected the shared confirm dialog to open");
    fireEvent.click(findInBody("Rebuild")!);
    await settle();
    await settle();
    const rebuild = calls.find((c) => c.url.includes("/api/baptism/rebuild"));
    assert.ok(rebuild, "expected a POST to /api/baptism/rebuild");
    assert.deepEqual(rebuild!.body, { serviceKey: "svc-failed" }, "must target the FAILED entry's own serviceKey");
    assert.equal(rebuiltCount(), 1, "onRebuilt must fire so Past sessions/Trends can reload");
  } finally {
    restore();
  }
});

test("a rebuild that restored nothing for THIS session warns plainly instead of reporting success", async () => {
  // A full or read-only disk drops the finish row itself, not only the JSON
  // save (see rebuildBaptismSessions' own neverFinished counter) — a 200 from
  // POST /api/baptism/rebuild is not proof THIS session came back, only that
  // the request succeeded. restoredIds is the write-time truth; an entry
  // whose own id is missing from it must say so, not echo the generic
  // "N updated, M added" success toast meant for the service as a whole.
  const entryStartedAt = "2026-09-13T15:00:00.000Z";
  const sessionId = baptismSessionId(entryStartedAt);
  const { root, restore } = await mountWithRebuild(
    {
      ...FINISHED,
      saveErrors: [{ sessionId, serviceKey: "svc-never-finished", reason: DISK }],
    },
    {
      live: false,
      rebuildAnswer: {
        rows: 3, sessions: 0, updated: 0, added: 0, unchanged: 0, newer: 0,
        disagreeing: 0, invalid: 0, kept: 0, full: 0, restoredIds: [],
      },
    },
  );
  try {
    const [btn] = rebuildButtonsIn(root);
    fireEvent.click(btn!);
    await settle();
    fireEvent.click(findInBody("Rebuild")!);
    await settle();
    await settle();
    const body = document.body.textContent ?? "";
    assert.match(
      body,
      /The raw rows hold no finished copy of this session — copy the report now/,
      `expected the plain warning, got: ${body}`,
    );
    assert.doesNotMatch(body, /0 updated, 0 added/i, "must not also show the generic success toast");
  } finally {
    restore();
  }
});

test("cancelling the confirm reaches neither the server nor onRebuilt", async () => {
  const { root, calls, rebuiltCount, restore } = await mountWithRebuild(
    {
      ...FINISHED,
      saveErrors: [{ sessionId: baptismSessionId("2026-09-13T15:00:00.000Z"), serviceKey: "svc-a", reason: DISK }],
    },
    { live: false },
  );
  try {
    const [btn] = rebuildButtonsIn(root);
    fireEvent.click(btn!);
    await settle();
    fireEvent.click(findInBody("Cancel")!);
    await settle();
    assert.equal(calls.some((c) => c.url.includes("/api/baptism/rebuild")), false);
    assert.equal(rebuiltCount(), 0);
  } finally {
    restore();
  }
});

test("a live 409 the recheck did not catch shows the same refusal the header shows, and the entry stays", async () => {
  const { root, calls, restore } = await mountWithRebuild(
    {
      ...FINISHED,
      saveErrors: [{ sessionId: baptismSessionId("2026-09-13T15:00:00.000Z"), serviceKey: "svc-a", reason: DISK }],
    },
    { live: false, rebuildStatus: 409, rebuildAnswer: { error: "That service is recording right now.", code: "live" } },
  );
  try {
    const [btn] = rebuildButtonsIn(root);
    fireEvent.click(btn!);
    await settle();
    fireEvent.click(findInBody("Rebuild")!);
    await act(async () => {
      await settle();
      await settle();
    });
    assert.ok(calls.some((c) => c.url.includes("/api/baptism/rebuild")), "the POST must still have been attempted");
    const body = document.body.textContent ?? "";
    assert.match(
      body,
      /This service started recording again — rebuild once it ends/,
      `expected the same live-refusal toast the header's own Rebuild shows, got: ${body}`,
    );
    // The entry itself is drawn from `state.saveErrors`, which this refused
    // rebuild never changed — a real clear only ever arrives as a NEW state
    // prop, on the server's own push (see baptism-rebuild-clears-save-error
    // .test.ts). Nothing client-side may remove it optimistically.
    assert.equal(rebuildButtonsIn(root).length, 1, "a refused rebuild must leave the entry, and its action, in place");
  } finally {
    restore();
  }
});
