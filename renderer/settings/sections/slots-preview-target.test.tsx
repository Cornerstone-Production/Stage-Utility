// The slots preview following the plan switcher, over a stubbed server.
//
// What is under test is which board the preview is a picture of. Three ways it
// can lie, and every one of them is silent:
//
//  1. Resolving only while there are unsaved edits, so a clean editor stepped to
//     next Sunday keeps showing THIS Sunday's board. That is the bug this file
//     exists for.
//  2. Sending no target with the request, so the server answers for the plan the
//     screens follow and the rows are the wrong week's.
//  3. Stepping twice faster than one round trip and painting the first target's
//     answer over the second's.
//
// NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND. node:assert builds its
// failure message by inspecting `actual`, and inspecting a live jsdom element
// does not terminate in any useful time — a sibling file ran for 81.5 s on one
// such assertion and had to be killed, reporting no line number. Every assertion
// here is on a string, a number or a boolean.
//
// NOT unit-tested here, and driven in a browser against the real server instead:
// that the resolved rows actually reach the preview iframe. The push is a
// postMessage into a cross-document `<iframe src>` that jsdom never navigates,
// and the caption's amber is a stylesheet colour jsdom does not load at all.
// Both are in the PR notes with the requests that exercised them.

import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { installRenderDom } from "../../test-dom.js";

const teardown = installRenderDom();

const SUN = "st-sun";
const LIVE_PLAN = "s1";
const NEXT_PLAN = "s2";

const PLANS: UpcomingPlan[] = [
  { serviceTypeId: SUN, serviceTypeName: "Sunday", planId: LIVE_PLAN, title: "Sunday", sortDate: "2026-09-13T14:00:00Z", dates: "September 13, 2026", isCurrent: true },
  { serviceTypeId: SUN, serviceTypeName: "Sunday", planId: NEXT_PLAN, title: "Sunday", sortDate: "2026-09-20T14:00:00Z", dates: "September 20, 2026", isCurrent: false },
];

const STATE = {
  appName: "Stage",
  accentColor: null,
  hourCycle: "12h",
  serviceTypeId: SUN,
  serviceTypeName: "Sunday",
  planId: LIVE_PLAN,
  planTitle: "Sunday",
  planDates: "September 13, 2026",
  planSwitcherMode: "upcoming",
  timezone: "UTC",
  slotsByView: {},
  slotsByLayoutObject: {},
} as unknown as StageState;

/** Every resolve-slots body the stub was handed, verbatim. */
let resolveBodies: string[] = [];

/**
 * The answer for the next resolve, and — when `hold` is on — a hand on the tap.
 *
 * Case 3 needs two requests in flight at once with the FIRST one landing last,
 * which no amount of waiting produces on its own.
 */
let hold = false;
let pending: (() => void)[] = [];
let nextAnswer: (body: string) => SlotsPreviewDTO = () => ({ slots: [], roster: "live" });

(globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown, init?: RequestInit) => {
  const url = String(input);
  if (url.includes("/api/events/subscribe")) {
    return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
  }
  let body: unknown = {};
  if (url.includes("/api/plans/upcoming")) {
    body = { plans: PLANS, cacheAgeMs: 0 };
  } else if (url.includes("/api/views/resolve-slots")) {
    const sent = typeof init?.body === "string" ? init.body : "";
    resolveBodies.push(sent);
    body = nextAnswer(sent);
    if (hold) {
      await new Promise<void>((r) => pending.push(r));
    }
  } else if (url.includes("/slot-targets")) {
    const q = new URL(url, "http://localhost:8788").searchParams;
    const row = PLANS.find((p) => p.planId === q.get("planId"));
    body = {
      scope: "view",
      key: "v1",
      serviceTypeId: q.get("serviceTypeId"),
      serviceTypeName: "Sunday",
      planId: q.get("planId"),
      planDates: row?.dates ?? null,
      planSortDate: row?.sortDate ?? null,
      defaultSlots: [],
      overrideSlots: null,
    };
  } else if (url.includes("/api/state")) {
    body = STATE;
  }
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
};

const { render, cleanup, act, fireEvent, screen } = await import("@testing-library/react");
const React = (await import("react")).default;
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { PlanSwitcher } = await import("./plan-switcher.js");
const { useSlotsPreview, SlotsPreviewNote, previewNote, positionsFilled } = await import("./slots-preview-target.js");
const { __setEditingTargetForTests } = await import("./editing-target.js");
const { __resetForTests } = await import("../../main/use-stage-state.js");
const { __resetReplayCacheForTests } = await import("../../lib/api.js");
const { encodeTarget } = await import("./plan-switcher-step.js");

function slot(id: string, position: string, displayName: string | null): Slot {
  return {
    id,
    channel: "01",
    order: 0,
    link: { kind: "pco", matchBy: "position", positions: [{ name: position }] },
    deviceBinding: null,
    displayName,
    photoUrl: null,
    device: { status: "none", rf: null, battery: null, freq: null, audioLevel: null, charge: null, iemCharge: null, label: null, iemLabel: null },
  } as unknown as Slot;
}

const BOARD = [slot("s1", "Vocals", null), slot("s2", "Guitar", null)];

/** Several macrotasks — the hydrate, the queries and their re-renders are
 *  separate turns. Long enough to clear the hook's 250 ms debounce. */
const settle = async () => {
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 45));
    });
  }
};

let dirty = false;

/** Prints what the hook resolved to, beside a real switcher to step it with. */
function Probe(): React.ReactElement {
  const preview = useSlotsPreview(BOARD, dirty);
  return React.createElement(
    "div",
    null,
    React.createElement(PlanSwitcher, null),
    // Strings, never objects — see the note at the top of the file.
    React.createElement("span", { "data-testid": "roster" }, preview?.roster ?? "none-at-all"),
    React.createElement(
      "span",
      { "data-testid": "names" },
      (preview?.slots ?? []).map((s) => s.displayName ?? "-").join(","),
    ),
    React.createElement(SlotsPreviewNote, {
      resolution: preview,
      planLabel: "Sun, Sep 20",
      serviceTypeName: "Sunday",
    }),
  );
}

let client: InstanceType<typeof QueryClient> | null = null;

function mount() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    React.createElement(QueryClientProvider, { client }, React.createElement(Probe, null)),
  );
}

const roster = () => screen.getByTestId("roster").textContent ?? "";
const names = () => screen.getByTestId("names").textContent ?? "";
const note = () =>
  document.querySelector("[data-slots-preview-note]")?.textContent ?? "";
const noteTitle = () =>
  document.querySelector("[data-slots-preview-note]")?.getAttribute("title") ?? "";

/** Pick a target from the switcher's native select, as an operator's click does. */
const pick = async (value: string) => {
  const select = document.querySelector("[data-plan-switcher] select") as HTMLSelectElement;
  assert.ok(select, "the switcher's middle control is a native select");
  await act(async () => {
    fireEvent.change(select, { target: { value } });
  });
  await settle();
};

/** The target JSON each recorded resolve request carried, "" for none. */
const targets = () =>
  resolveBodies.map((b) => {
    const parsed = JSON.parse(b) as { target?: unknown };
    return parsed.target ? JSON.stringify(parsed.target) : "";
  });

beforeEach(() => {
  cleanup();
  __resetForTests();
  __resetReplayCacheForTests();
  __setEditingTargetForTests(null);
  resolveBodies = [];
  pending = [];
  hold = false;
  dirty = false;
  nextAnswer = () => ({ slots: [], roster: "live" });
});
afterEach(async () => {
  hold = false;
  for (const r of pending) r();
  pending = [];
  cleanup();
  await settle();
  client?.clear();
  client = null;
});
after(async () => {
  __setEditingTargetForTests(null);
  await settle();
  teardown();
});

describe("when the preview asks the server at all", () => {
  test("live and clean: it does not — the iframe is the kiosk", async () => {
    mount();
    await settle();
    assert.deepEqual(resolveBodies, [], "a clean editor on the live plan has nothing the kiosk is not already showing");
    assert.equal(roster(), "none-at-all", "and the hook hands the preview no rows to override it with");
    assert.equal(note(), "", "nor a caption — the preview IS what the screens are showing");
  });

  test("live and dirty: it does, for the live plan", async () => {
    dirty = true;
    mount();
    await settle();
    assert.equal(resolveBodies.length >= 1, true, "unsaved edits still have to be resolved to be previewed");
    assert.deepEqual(targets().slice(0, 1), [JSON.stringify({ serviceTypeId: SUN, planId: LIVE_PLAN })]);
  });

  test("clean but on another plan: it does, carrying that target", async () => {
    nextAnswer = () => ({
      slots: [slot("s1", "Vocals", "Next Person"), slot("s2", "Guitar", null)],
      roster: "plan",
    });
    mount();
    await settle();
    resolveBodies = [];

    await pick(encodeTarget({ serviceTypeId: SUN, planId: NEXT_PLAN }));

    assert.deepEqual(
      targets(),
      [JSON.stringify({ serviceTypeId: SUN, planId: NEXT_PLAN })],
      "gating the resolve on dirtiness is what left the preview showing this Sunday under next Sunday's switcher",
    );
    assert.equal(roster(), "plan");
    assert.equal(names(), "Next Person,-", "with that plan's people in it");
  });

  test("clean but on the Default side: it does, with planId null", async () => {
    nextAnswer = () => ({ slots: BOARD, roster: "none" });
    mount();
    await settle();
    resolveBodies = [];

    await pick(encodeTarget({ serviceTypeId: SUN, planId: null }));

    assert.deepEqual(targets(), [JSON.stringify({ serviceTypeId: SUN, planId: null })]);
    assert.equal(roster(), "none");
  });
});

describe("stepping twice faster than one round trip", () => {
  test("the first target's answer is discarded, not painted over the second's", async () => {
    mount();
    await settle();
    resolveBodies = [];

    // The first step's request is held open, so its answer can be released
    // AFTER the second step has already been answered.
    hold = true;
    nextAnswer = () => ({ slots: [slot("s1", "Vocals", "STALE")], roster: "plan" });
    await pick(encodeTarget({ serviceTypeId: SUN, planId: NEXT_PLAN }));
    assert.equal(pending.length, 1, "the first request is in flight");

    hold = false;
    nextAnswer = () => ({ slots: [slot("s1", "Vocals", "CURRENT")], roster: "none" });
    await pick(encodeTarget({ serviceTypeId: SUN, planId: null }));
    assert.equal(names(), "CURRENT", "the second target's answer is the one showing");

    // Now let the first one land.
    for (const r of pending) r();
    pending = [];
    await settle();

    assert.equal(
      names(),
      "CURRENT",
      "a late answer for a target the operator has already left must never reach the preview",
    );
    assert.equal(roster(), "none");
  });
});

describe("the caption", () => {
  test("names the plan and how much of the board the roster filled", () => {
    const text = previewNote(
      {
        slots: [
          slot("a", "Vocals", "Ada"),
          slot("b", "Guitar", "Ben"),
          slot("c", "Bass", null),
          { ...slot("d", "x", null), link: { kind: "spacer" } } as unknown as Slot,
        ],
        roster: "plan",
      },
      "Sun, Sep 20",
      "Sunday",
    );
    assert.equal(text?.text, "Previewing Sun, Sep 20 · 2 of 3 positions filled");
    assert.equal(text?.title, undefined);
  });

  test("says a default board has no week rather than implying nobody is scheduled", () => {
    const text = previewNote({ slots: BOARD, roster: "none" }, "Sun, Sep 20", "Sunday");
    assert.equal(text?.text, "Previewing the Sunday default — positions only, no plan");
  });

  test("says so when Planning Center could not be read, with the reason on hover", () => {
    const text = previewNote(
      { slots: BOARD, roster: "unavailable", reason: "401 Unauthorized" },
      "Sun, Sep 20",
      "Sunday",
    );
    assert.equal(
      text?.text,
      "Previewing Sun, Sep 20 — Planning Center could not be read, so rows show positions only",
    );
    assert.equal(text?.title, "401 Unauthorized");
  });

  test("is silent on the live plan and with no resolution at all", () => {
    assert.equal(previewNote({ slots: BOARD, roster: "live" }, "Sun, Sep 20", "Sunday"), null);
    assert.equal(previewNote(null, "Sun, Sep 20", "Sunday"), null);
  });

  test("counts only PCO-linked rows — a spacer is not an unfilled position", () => {
    const counted = positionsFilled([
      slot("a", "Vocals", "Ada"),
      { ...slot("b", "x", null), link: { kind: "spacer" } } as unknown as Slot,
      { ...slot("c", "x", null), link: { kind: "static", label: "Pastor", color: null } } as unknown as Slot,
    ]);
    assert.equal(counted.filled, 1);
    assert.equal(counted.total, 1);
  });

  test("renders, with the roster on the element and the reason as its title", async () => {
    nextAnswer = () => ({ slots: BOARD, roster: "unavailable", reason: "getaddrinfo ENOTFOUND" });
    mount();
    await settle();
    await pick(encodeTarget({ serviceTypeId: SUN, planId: NEXT_PLAN }));
    assert.equal(
      note(),
      "Previewing Sun, Sep 20 — Planning Center could not be read, so rows show positions only",
    );
    assert.equal(noteTitle(), "getaddrinfo ENOTFOUND");
  });
});
