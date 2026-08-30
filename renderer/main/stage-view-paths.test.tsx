// Every screen StageView can land on, rendered.
//
// This file exists to be a PARITY BASELINE. It was written against the
// fifteen-return version of the component, run green, and only then did the
// component become one switch over `resolveScreen`. If a single assertion here
// had to be edited to survive that change, the change was a behaviour change —
// on the component every wall display in a building renders, where the failure
// mode is a dark or wrong screen with nobody standing next to it.
//
// So the assertions are deliberately about what an OPERATOR would see: the
// words on the screen, whether the escape-hatch link is there, whether the
// display is named. Not props, not internal structure. A test that asserts the
// component "called resolveScreen" would have passed before the refactor for
// the wrong reason and after it for no reason at all.
//
// The component is driven through its real seams — a stubbed `fetch` feeding
// the real `useStageState`, a stub EventSource, the real router-free path in
// `window.location` — rather than by mocking modules, which this repo's test
// runner is not configured for.

import { strict as assert } from "node:assert";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { installDom } from "../test-dom.js";
import { KIND_DRAWS_TOP_BAR, everyViewKind, type ViewKind } from "@main/types/views";

const teardown = installDom();

/**
 * jsdom ships no EventSource, and StageView reaches one: the state arrives over
 * SSE. A stub that connects to nothing is right here — every test drives the
 * state through the initial fetch instead, and a live stream would make this
 * file depend on a server.
 */
class StubEventSource {
  static readonly CONNECTING = 0;
  readyState = 0;
  onmessage: unknown = null;
  onerror: unknown = null;
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
}
(globalThis as unknown as { EventSource: unknown }).EventSource = StubEventSource;

/** How `/api/state` should answer the next render. */
type StateMode = "ok" | "reject" | "pending";
let stateBody: unknown = null;
let stateMode: StateMode = "ok";

// No network. `useStageState` fetches on mount; the presence heartbeat POSTs.
// Left real, those requests outlive the test, settle after installDom's teardown
// has removed `window`, and surface as an uncaughtException that fails the FILE
// while every test in it passes.
(globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown) => {
  if (String(input) === "/api/state") {
    if (stateMode === "reject") throw new Error("no route to host");
    // A request that never settles is what `isLoading` actually means.
    if (stateMode === "pending") return new Promise(() => {});
    return { ok: true, status: 200, json: async () => stateBody, text: async () => "" };
  }
  // A calendar view hydrates its own month on mount, and CalendarMonth reads
  // `grid.days` unguarded — so the blanket `{}` below put the calendar kind on
  // the error boundary rather than on screen, and any assertion about what a
  // calendar display draws passed by rendering "Display error".
  if (String(input).startsWith("/api/pco/calendar")) {
    return { ok: true, status: 200, json: async () => CALENDAR_GRID, text: async () => "" };
  }
  return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
};

/**
 * Six weeks of empty squares — the smallest thing CalendarMonth can draw.
 *
 * Real consecutive dates spanning the month boundaries, the way the endpoint
 * answers, because CalendarMonth keys its squares by date: a wrapping `i % 31`
 * repeated eleven of them and put 22 React duplicate-key warnings into every run
 * of the whole suite. The squares outside August carry inMonth false, which is
 * what the renderer dims.
 */
const CALENDAR_GRID = {
  monthLabel: "August 2026",
  zone: "America/Chicago",
  unplaceable: 0,
  // Sun 26 Jul 2026 through Sat 5 Sep — six weeks starting on a Sunday.
  days: Array.from({ length: 42 }, (_, i) => {
    const date = new Date(Date.UTC(2026, 6, 26) + i * 86_400_000).toISOString().slice(0, 10);
    return { date, inMonth: date.startsWith("2026-08"), events: [] };
  }),
};

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { render, cleanup, act } = await import("@testing-library/react");
const React = (await import("react")).default;
const { StageView } = await import("./stage-view.js");
const { __resetForTests } = await import("./use-stage-state.js");
const { TooltipProvider } = await import("../components/ui/tooltip-provider.js");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");

// The two providers the kiosk entry (renderer/main/index.tsx) wraps the view in.
// Without them the top bar's Tooltip throws and EVERY screen with a top bar
// renders the error boundary instead — which would make this file assert that
// four different screens all say "Display error".
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

const settle = () => new Promise((r) => setTimeout(r, 0));
after(async () => { cleanup(); await settle(); teardown(); });
// `useStageState` caches the StageState at MODULE level and deliberately keeps
// it after the last consumer unmounts, so without this drop a case would
// inherit the previous one's state and pass or fail on test ORDER — the first
// case here leaves a request pending, which is how every later screen came to
// render the loading spinner.
beforeEach(() => { cleanup(); __resetForTests(); });
afterEach(async () => { cleanup(); await settle(); });

// ---- fixtures ---------------------------------------------------------------

function resolved(over: Record<string, unknown> = {}) {
  return { viewId: "v1", kind: "slots", ndiSource: null, viewName: "Mic board", blackout: false, locked: false, hideTopBar: false, ...over };
}

/** One slot, complete enough for SlotPanel to draw it. */
function slot(label: string) {
  return {
    id: "s1", channel: "1", order: 0,
    link: { kind: "static", label, color: "#2E6691" },
    device: { status: "none", rf: null, battery: null, freq: null, audioLevel: null, charge: null, iemCharge: null, label: null, iemLabel: null },
  };
}

function stageState(over: Record<string, unknown> = {}) {
  return {
    serviceTypeName: "Weekend", planTitle: "A plan", planSeriesTitle: null, planDates: null,
    showQr: false, remoteUrl: null, appName: "Stage Utility", appLogo: null,
    appLogoMonochrome: false, emptySlotLogo: null, defaultAvatar: null,
    pcoConfigured: true, hourCycle: "12h", accentColor: null,
    views: [{ id: "v1", name: "Mic board", kind: "slots" }],
    outputs: [{ id: "display-1", name: "Stage left", viewId: "v1" }],
    resolvedByOutput: { "display-1": resolved() },
    slotsByView: {}, slotsByLayoutObject: {}, notesByObject: {},
    barItems: [], savedColors: [], captionChannelColors: {},
    allowedServiceTypeIds: [], checklistNoteCategories: [], checklistNoteTeams: [],
    ...over,
  };
}

/** A state whose one display is routed to a View of the given kind. */
function ofKind(kind: string, view: Record<string, unknown> = {}) {
  return stageState({
    views: [{ id: "v1", name: "The view", kind, ...view }],
    resolvedByOutput: { "display-1": resolved({ kind }) },
  });
}

/** Render the kiosk at `path` with `/api/state` answering as described. */
async function showScreen(
  path: string,
  state: unknown,
  mode: StateMode = "ok",
): Promise<HTMLElement> {
  window.history.replaceState({}, "", path);
  stateBody = state;
  stateMode = mode;
  // Every call models opening the kiosk fresh at `path`. `useStageState` caches
  // the StageState at MODULE level and keeps it after the last consumer
  // unmounts, so without this drop a second showScreen in one case would read
  // the FIRST call's state and assert against it — which is what a blackout, a
  // lock and a second display each silently did.
  __resetForTests();
  let container!: HTMLElement;
  await act(async () => {
    container = render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(TooltipProvider, null, React.createElement(StageView)),
      ),
    ).container;
    await settle();
  });
  return container;
}

const says = (c: HTMLElement, text: string) => (c.textContent ?? "").includes(text);
/** The top bar's way home — stripped on a locked output, present otherwise. */
const hasHomeLink = (c: HTMLElement) => !!c.querySelector('a[href="/"]');
/**
 * Whether a press can reach the layout's controls.
 *
 * A BOOLEAN, deliberately, and so is every other DOM assertion in this file. An
 * `assert.equal(someElement, null)` that fails hands node:test a jsdom node to
 * serialize into the failure report — it walks into the document and the window
 * behind it, and the run hangs for twenty seconds and then dies naming the FILE
 * instead of the test. Found by mutating the resolver to watch these bite.
 */
const hasInertControls = (c: HTMLElement) => !!c.querySelector(".pointer-events-none.w-full");

// ---- lifecycle --------------------------------------------------------------

describe("StageView lifecycle screens", () => {
  test("a request still in flight shows the loading screen", async () => {
    const c = await showScreen("/display-1", null, "pending");
    assert.ok(says(c, "Loading stage"), c.textContent ?? "");
  });

  test("a failed hydrate shows the error, with the reason on screen", async () => {
    const c = await showScreen("/display-1", null, "reject");
    assert.ok(says(c, "Could not load stage state"));
    // The reason matters: a wall screen that only says "error" tells the
    // operator nothing they can act on from across the room.
    assert.ok(says(c, "no route to host"), c.textContent ?? "");
  });

  test("no state at all is an error screen, not an empty one", async () => {
    // A falsy body is the only way to reach this guard through the real hook —
    // it is defensive, and it is the difference between saying so and drawing an
    // empty slot grid that looks like a configuration mistake.
    const c = await showScreen("/display-1", 0);
    assert.ok(says(c, "State is unavailable."), c.textContent ?? "");
  });
});

// ---- output state -----------------------------------------------------------

describe("StageView output state", () => {
  test("a blacked-out output renders nothing but black", async () => {
    const c = await showScreen("/display-1", stageState({
      resolvedByOutput: { "display-1": resolved({ blackout: true }) },
    }));
    assert.equal(c.innerHTML, '<div class="fixed inset-0 z-50 bg-black"></div>');
  });

  test("a blackout beats the view that is routed to the output", async () => {
    // Same state, same routed slots — only the flag differs, and the slots must
    // not appear. Toggling it off has to restore them instantly, which is only
    // true while blackout is a state and not baked into the view.
    const withSlots = { slotsByView: { v1: [slot("Pastor")] } };
    const lit = await showScreen("/display-1", stageState(withSlots));
    assert.ok(says(lit, "Pastor"));
    cleanup();
    const dark = await showScreen("/display-1", stageState({
      ...withSlots,
      resolvedByOutput: { "display-1": resolved({ blackout: true }) },
    }));
    assert.ok(!says(dark, "Pastor"), dark.textContent ?? "");
  });

  test("an output with no view routed says so, rather than showing an empty grid", async () => {
    const c = await showScreen("/display-1", stageState({
      resolvedByOutput: { "display-1": resolved({ viewId: null }) },
    }));
    assert.ok(says(c, "Display not configured"), c.textContent ?? "");
    assert.ok(says(c, "No view is assigned to this display."));
  });

  test("an output the server never resolved is unrouted too", async () => {
    const c = await showScreen("/display-1", stageState({ resolvedByOutput: {} }));
    assert.ok(says(c, "Display not configured"), c.textContent ?? "");
  });

  test("a locked output loses the way home; an unlocked one keeps it", async () => {
    const withSlots = { slotsByView: { v1: [slot("Pastor")] } };
    const open = await showScreen("/display-1", stageState(withSlots));
    assert.equal(hasHomeLink(open), true);
    cleanup();
    const locked = await showScreen("/display-1", stageState({
      ...withSlots,
      resolvedByOutput: { "display-1": resolved({ locked: true }) },
    }));
    assert.equal(hasHomeLink(locked), false);
    assert.ok(says(locked, "Pastor"), "a lock hides the nav, it does not hide the view");
  });

  test("the lock reaches the unrouted screen as well as the view", async () => {
    const c = await showScreen("/display-1", stageState({
      resolvedByOutput: { "display-1": resolved({ viewId: null, locked: true }) },
    }));
    assert.ok(says(c, "Display not configured"));
    assert.equal(hasHomeLink(c), false);
  });

  test("one display is not named; two are", async () => {
    const withSlots = { slotsByView: { v1: [slot("Pastor")] } };
    const single = await showScreen("/display-1", stageState(withSlots));
    assert.ok(!says(single, "Stage left"), single.textContent ?? "");
    cleanup();
    const multi = await showScreen("/display-1", stageState({
      ...withSlots,
      outputs: [
        { id: "display-1", name: "Stage left", viewId: "v1" },
        { id: "display-2", name: "Stage right", viewId: "v1" },
      ],
    }));
    assert.ok(says(multi, "Stage left"), multi.textContent ?? "");
  });

  test("a friendly slug resolves to the same screen as the id", async () => {
    const state = stageState({
      slotsByView: { v1: [slot("Pastor")] },
      outputs: [{ id: "display-1", name: "Stage left", slug: "left-mic", viewId: "v1" }],
    });
    const c = await showScreen("/left-mic", state);
    assert.ok(says(c, "Pastor"), c.textContent ?? "");
  });
});

// ---- the settings live preview ----------------------------------------------

describe("StageView preview", () => {
  test("a preview renders the View's own slots", async () => {
    const c = await showScreen("/preview-v1", stageState({ slotsByView: { v1: [slot("Pastor")] } }));
    assert.ok(says(c, "Pastor"), c.textContent ?? "");
  });

  test("a preview ignores the output's blackout and lock", async () => {
    // The preview lives in the settings console, where navigation has to keep
    // working and where an output's blackout means nothing.
    const c = await showScreen("/preview-v1", stageState({
      slotsByView: { v1: [slot("Pastor")] },
      outputs: [
        { id: "display-1", name: "Stage left", viewId: "v1" },
        { id: "preview-v1", name: "Not a real screen", viewId: "v1" },
      ],
      resolvedByOutput: { "preview-v1": resolved({ blackout: true, locked: true }) },
    }));
    assert.ok(says(c, "Pastor"), c.textContent ?? "");
    assert.equal(hasHomeLink(c), true);
  });

  test("a preview is never named, even on a multi-display install", async () => {
    const c = await showScreen("/preview-v1", stageState({
      slotsByView: { v1: [slot("Pastor")] },
      outputs: [
        { id: "display-1", name: "Stage left", viewId: "v1" },
        { id: "display-2", name: "Stage right", viewId: "v1" },
      ],
    }));
    assert.ok(!says(c, "Stage left"), c.textContent ?? "");
  });
});

// ---- one test per view kind -------------------------------------------------

describe("StageView renders each view kind", () => {
  test("slots draws the slot panels", async () => {
    const c = await showScreen("/display-1", stageState({ slotsByView: { v1: [slot("Pastor")] } }));
    assert.ok(says(c, "Pastor"), c.textContent ?? "");
  });

  test("slots with nothing assigned is the empty screen", async () => {
    const c = await showScreen("/display-1", stageState({ slotsByView: {} }));
    assert.ok(says(c, "No mic slots assigned yet"), c.textContent ?? "");
  });

  test("slots without Planning Center says that instead", async () => {
    // Ordered ahead of the empty screen: "no slots" is the wrong advice when the
    // reason there are none is that PCO was never connected.
    const c = await showScreen("/display-1", stageState({ pcoConfigured: false, slotsByView: {} }));
    assert.ok(says(c, "Planning Center not configured"), c.textContent ?? "");
  });

  test("custom draws the layout canvas", async () => {
    const c = await showScreen("/display-1", ofKind("custom", {
      layout: { canvas: { width: 1920, height: 1080, background: null }, objects: [] },
    }));
    const canvas = c.querySelector('div[style*="width: 1920px"]');
    assert.ok(canvas, `no layout canvas rendered: ${c.innerHTML.slice(0, 300)}`);
    assert.ok(!says(c, "No mic slots assigned yet"));
  });

  test("custom with no layout drawn yet is the empty screen", async () => {
    const c = await showScreen("/display-1", ofKind("custom"));
    assert.ok(says(c, "No mic slots assigned yet"), c.textContent ?? "");
    assert.equal(!!c.querySelector('div[style*="width: 1920px"]'), false);
  });

  test("dashboard draws the dashboard", async () => {
    const c = await showScreen("/display-1", ofKind("dashboard"));
    assert.ok(says(c, "Current time"), c.textContent ?? "");
    assert.ok(says(c, "Service timer"));
  });

  test("stage draws the stage display", async () => {
    const c = await showScreen("/display-1", ofKind("stage"));
    assert.ok(says(c, "Remaining slides"), c.textContent ?? "");
    assert.ok(says(c, "Planning Center Live"));
  });

  test("transcription draws the transcript", async () => {
    const c = await showScreen("/display-1", ofKind("transcription"));
    assert.ok(says(c, "Waiting for transcript"), c.textContent ?? "");
  });

  test("script draws the rundown", async () => {
    const c = await showScreen("/display-1", ofKind("script", { scriptViewLayoutId: "sl1" }));
    assert.ok(says(c, "ScriptView"), c.textContent ?? "");
  });

  test("spl-rundown draws the SPL rundown", async () => {
    const c = await showScreen("/display-1", ofKind("spl-rundown"));
    assert.ok(says(c, "Max SPL per item"), c.textContent ?? "");
  });

  test("a kind this build does not recognise says so, never draws slots", async () => {
    // Not a hypothetical: the app ships a beta/main track switch, so a View kind
    // written by a beta build and read by a main build is a real path.
    //
    // This used to fall through to the slots path and draw somebody's MIC SLOTS,
    // with nothing on screen to say the build could not draw what it was routed
    // to. The screen must still say something an operator can read — and it must
    // name the kind, so they know which screen to re-route.
    const c = await showScreen("/display-1", stageState({
      views: [{ id: "v1", name: "From the future", kind: "holodeck" }],
      resolvedByOutput: { "display-1": resolved({ kind: "holodeck" }) },
    }));
    assert.ok((c.textContent ?? "").length > 0, "an unknown kind rendered nothing at all");
    assert.ok(says(c, "This build cannot draw this view"), c.textContent ?? "");
    assert.ok(says(c, "holodeck"), c.textContent ?? "");
    assert.ok(!says(c, "No mic slots assigned yet"), "an unknown kind fell through to slots");
  });
});

// ---- everything below POSTDATES the parity baseline --------------------------
//
// The block above is the contract that the refactor changed nothing. These are
// the two bugs the refactor exposed, fixed deliberately afterwards, plus the
// panel-mode case the parity block was missing. They are here rather than in
// their own file because they are assertions about the same rendered screens,
// and a second harness for four tests is a second harness to keep in step.

describe("StageView no longer names a screen after its URL", () => {
  test("a preview of a deleted View is not labelled with its slug", async () => {
    // The top bar used to fall back to the display id, which in a preview is the
    // URL fragment: an operator saw "preview-gone" written on the screen as if
    // that were a display's name.
    const c = await showScreen("/preview-gone", stageState({
      outputs: [
        { id: "display-1", name: "Stage left", viewId: "v1" },
        { id: "display-2", name: "Stage right", viewId: "v1" },
      ],
    }));
    assert.ok(!says(c, "preview-gone"), c.textContent ?? "");
    assert.ok(!says(c, "preview-"), c.textContent ?? "");
  });

  test("the browser tab is not titled after the URL either", async () => {
    // The same fallback, in a second place: the tab title did its own
    // `outputs.find(...) ?? displayId`, so every preview tab read
    // "Stage Utility — preview-v1". It now reads the resolved screen's name, so
    // the tab and the top bar cannot disagree.
    const twoDisplays = {
      outputs: [
        { id: "display-1", name: "Stage left", viewId: "v1" },
        { id: "display-2", name: "Stage right", viewId: "v1" },
      ],
    };
    await showScreen("/preview-v1", stageState({ ...twoDisplays, slotsByView: { v1: [slot("Pastor")] } }));
    assert.ok(!document.title.includes("preview-"), document.title);
    assert.equal(document.title, "Stage Utility");
    cleanup();

    // A real display still names itself, which is the whole point of the title.
    await showScreen("/display-1", stageState({ ...twoDisplays, slotsByView: { v1: [slot("Pastor")] } }));
    assert.equal(document.title, "Stage Utility — Stage left");
  });

  test("an address with no display behind it is not labelled with the path", async () => {
    const c = await showScreen("/display-9", stageState({
      outputs: [
        { id: "display-1", name: "Stage left", viewId: "v1" },
        { id: "display-2", name: "Stage right", viewId: "v1" },
      ],
      resolvedByOutput: { "display-9": resolved() },
    }));
    assert.ok(!says(c, "display-9"), c.textContent ?? "");
  });
});

describe("StageView says when a previewed View is gone", () => {
  test("a preview of a deleted View says so, instead of drawing an empty slot grid", async () => {
    const c = await showScreen("/preview-gone", stageState({ views: [] }));
    assert.ok(says(c, "View not found"), c.textContent ?? "");
    assert.ok(says(c, "has been deleted"), c.textContent ?? "");
    // The screen it used to draw, which said nothing was wrong.
    assert.ok(!says(c, "No mic slots assigned yet"), c.textContent ?? "");
  });

  test("a real output with its View deleted still says unrouted, not view-missing", async () => {
    // The server clears an output's routing when its View goes, so on a wall
    // screen the honest message is that nothing is assigned. Only a preview,
    // whose URL still names the View, gets the other wording.
    const c = await showScreen("/display-1", stageState({
      views: [],
      resolvedByOutput: { "display-1": resolved({ viewId: null }) },
    }));
    assert.ok(says(c, "Display not configured"), c.textContent ?? "");
    assert.ok(!says(c, "View not found"), c.textContent ?? "");
  });
});

describe("StageView keeps controls dead unless the screen is a panel", () => {
  // The observable is the class, not a click: a `live-controls` object renders
  // the same buttons either way, and what changes is whether a press can reach
  // them. `pointer-events-none` is what the renderer puts there, and it is the
  // one thing standing between a wall screen and the service advancing because
  // somebody leaned on it.
  const withControls = (mode?: string) => stageState({
    views: [{
      id: "v1", name: "Console", kind: "custom",
      layout: {
        canvas: { width: 1920, height: 1080, background: null },
        objects: [{ id: "o1", x: 0, y: 0, w: 1, h: 1, z: 0, config: { type: "live-controls" } }],
      },
    }],
    // An Output at the PREVIEW slug too, and this is load-bearing rather than
    // tidiness: "a preview of a panel is still inert" loads /preview-v1, so with
    // only display-1 here the lookup misses whether or not the preview rule
    // exists, and the test passes with that rule deleted. It was green under
    // both `isPreview: false` and an unconditional currentDisplay lookup.
    outputs: [
      { id: "display-1", name: "Stage left", viewId: "v1", ...(mode ? { mode } : {}) },
      { id: "preview-v1", name: "Preview", viewId: "v1", ...(mode ? { mode } : {}) },
    ],
    resolvedByOutput: {
      "display-1": resolved({ kind: "custom" }),
      "preview-v1": resolved({ kind: "custom" }),
    },
  });

  test("a display's controls are inert", async () => {
    const c = await showScreen("/display-1", withControls());
    assert.equal(hasInertControls(c), true, "a wall screen's controls were left live");
  });

  test("a panel's controls are live", async () => {
    // The Output's mode reaches the renderer through the resolved screen; before
    // it was carried there, this was the one thing on the `view` arm that no
    // rendered test covered.
    const c = await showScreen("/display-1", withControls("panel"));
    assert.equal(
      hasInertControls(c),
      false,
      "a panel's controls were left inert — the Output's mode did not reach the renderer",
    );
  });

  test("a preview of a panel is still inert", async () => {
    // A "/preview-…" iframe is always a display: every card on the Screens page
    // renders one, and a preview whose buttons fired would let that page advance
    // the service by being looked at.
    const c = await showScreen("/preview-v1", withControls("panel"));
    assert.equal(hasInertControls(c), true, "a preview's controls were live");
  });
});

// ---- the per-display top bar ------------------------------------------------

describe("StageView honours a display's hidden top bar", () => {
  // The bar has SIX render sites in this component. Gating one of them is how
  // five walls keep a bar the operator turned off and nobody notices for a
  // month — so this is a TABLE over every screen a real display can land on,
  // not a spot check on whichever one happened to be edited.
  //
  // Five of the six are below. The sixth, view-missing, is preview-only and so
  // can never see the flag set; it has its own case after the table, which says
  // why rather than leaving it looking like a hole.
  //
  // The observable is the bar's own context label, "<service>: <plan>", which
  // nothing else on any of these screens draws. Not a class and not a test id:
  // those keep passing when a seventh render site draws a bar without the gate,
  // and the words on the screen are what the operator is looking at.
  const TOP_BAR = "Weekend: A plan";
  const hasTopBar = (c: HTMLElement) => says(c, TOP_BAR);

  /**
   * Every screen a display can land on, and whether it draws a top bar.
   *
   * The `bar: false` rows are as load-bearing as the others: a dashboard that
   * grows an ungated bar, or a blackout that grows one, fails the hidden half
   * below. That is the seventh-render-site case this table exists for.
   */
  const SCREENS: { name: string; bar: boolean; state: () => Record<string, unknown> }[] = [
    { name: "slots", bar: true, state: () => stageState({ slotsByView: { v1: [slot("Pastor")] } }) },
    { name: "slots with nothing assigned (the empty screen)", bar: true, state: () => stageState({ slotsByView: {} }) },
    { name: "slots without Planning Center (not configured)", bar: true, state: () => stageState({ pcoConfigured: false, slotsByView: {} }) },
    {
      name: "a custom layout",
      bar: true,
      state: () => ofKind("custom", { layout: { canvas: { width: 1920, height: 1080, background: null }, objects: [] } }),
    },
    { name: "a custom view with nothing drawn on it", bar: true, state: () => ofKind("custom") },
    { name: "an unrouted display", bar: true, state: () => stageState({ resolvedByOutput: { "display-1": resolved({ viewId: null }) } }) },
    { name: "dashboard", bar: true, state: () => ofKind("dashboard") },
    { name: "stage", bar: false, state: () => ofKind("stage") },
    { name: "transcription", bar: false, state: () => ofKind("transcription") },
    { name: "script", bar: false, state: () => ofKind("script", { scriptViewLayoutId: "sl1" }) },
    { name: "spl-rundown", bar: false, state: () => ofKind("spl-rundown") },
    { name: "calendar", bar: false, state: () => ofKind("calendar") },
    { name: "a blacked-out display", bar: false, state: () => stageState({ resolvedByOutput: { "display-1": resolved({ blackout: true }) } }) },
  ];

  /** The same state, with this display's top bar hidden. */
  function hidden(state: Record<string, unknown>): Record<string, unknown> {
    const byOutput = state.resolvedByOutput as Record<string, Record<string, unknown>>;
    const resolvedByOutput: Record<string, unknown> = {};
    for (const [id, r] of Object.entries(byOutput)) resolvedByOutput[id] = { ...r, hideTopBar: true };
    return { ...state, resolvedByOutput };
  }

  for (const screen of SCREENS) {
    test(`${screen.name}: draws its bar ${screen.bar ? "by default" : "never"}, and never when hidden`, async () => {
      const shown = await showScreen("/display-1", screen.state());
      assert.equal(
        hasTopBar(shown),
        screen.bar,
        screen.bar
          ? `${screen.name} lost its top bar with nothing hidden`
          : `${screen.name} grew a top bar: ${shown.textContent ?? ""}`,
      );
      cleanup();

      const off = await showScreen("/display-1", hidden(screen.state()));
      assert.equal(
        hasTopBar(off),
        false,
        `${screen.name} still drew its top bar with hideTopBar set — a render site is missing the gate`,
      );
    });
  }

  test("hiding one display's bar leaves another display's alone", async () => {
    const two = {
      slotsByView: { v1: [slot("Pastor")] },
      outputs: [
        { id: "display-1", name: "Stage left", viewId: "v1" },
        { id: "display-2", name: "Stage right", viewId: "v1" },
      ],
      resolvedByOutput: {
        "display-1": resolved({ hideTopBar: true }),
        "display-2": resolved(),
      },
    };
    const off = await showScreen("/display-1", stageState(two));
    assert.equal(hasTopBar(off), false, "the display the toggle was set on kept its bar");
    cleanup();
    const on = await showScreen("/display-2", stageState(two));
    assert.equal(hasTopBar(on), true, "hiding one display's bar hid another's — the flag is not per display");
  });

  test("the settings preview keeps its bar however the output is set", async () => {
    // The same rule the lock and the blackout follow: the preview iframe lives
    // in the settings console and is not the wall screen the toggle is about.
    const c = await showScreen("/preview-v1", stageState({
      slotsByView: { v1: [slot("Pastor")] },
      outputs: [
        { id: "display-1", name: "Stage left", viewId: "v1" },
        { id: "preview-v1", name: "Not a real screen", viewId: "v1" },
      ],
      resolvedByOutput: { "preview-v1": resolved({ hideTopBar: true }) },
    }));
    assert.equal(hasTopBar(c), true, "a preview lost its bar to an output's toggle");
  });

  test("the view-missing screen keeps its bar, which is the sixth render site", async () => {
    // The one KioskTopBar site the table above cannot reach, and the reason is
    // worth stating rather than leaving as an apparent hole: `view-missing` is
    // reachable ONLY from a "/preview-…" slug, and in a preview `resolved` is
    // null, so hideTopBar is forced false there. Its gate can never fire true.
    //
    // So this asserts the half that CAN regress — that the screen still draws a
    // bar at all. Route hideTopBar off the raw output instead of the
    // preview-nulled `resolved` and this is the screen that loses one.
    const c = await showScreen("/preview-gone", stageState({
      views: [],
      outputs: [
        { id: "display-1", name: "Stage left", viewId: "v1" },
        { id: "preview-gone", name: "Not a real screen", viewId: null },
      ],
      resolvedByOutput: { "preview-gone": resolved({ viewId: null, hideTopBar: true }) },
    }));
    assert.ok(says(c, "View not found"), c.textContent ?? "");
    assert.equal(hasTopBar(c), true, "the view-missing screen lost its bar to an output's toggle");
  });

  test("a hidden bar is not a lock, and a lock is not a hidden bar", async () => {
    const withSlots = { slotsByView: { v1: [slot("Pastor")] } };
    // Locked, bar shown: the bar is there, its way home is not.
    const locked = await showScreen("/display-1", stageState({
      ...withSlots,
      resolvedByOutput: { "display-1": resolved({ locked: true }) },
    }));
    assert.equal(hasTopBar(locked), true, "a lock hid the whole bar");
    assert.equal(hasHomeLink(locked), false);
    cleanup();

    // Bar hidden, unlocked: no bar, so no way home either — but the view itself
    // is untouched, which is the whole difference from a blackout.
    const bare = await showScreen("/display-1", stageState({
      ...withSlots,
      resolvedByOutput: { "display-1": resolved({ hideTopBar: true }) },
    }));
    assert.equal(hasTopBar(bare), false);
    assert.equal(hasHomeLink(bare), false, "the way home lives in the bar that is gone");
    assert.ok(says(bare, "Pastor"), "hiding the bar hid the view with it");
  });

  test("the content reclaims the strip, rather than leaving a gap", async () => {
    // The bar is a `shrink-0` row above a `flex-1` body, so it has to be GONE
    // and not merely blank: an empty spacer would leave a dark band across the
    // top of the wall, and every assertion above about the bar's words would
    // still pass. Counting the shell's children is what catches that.
    const state = stageState({ slotsByView: { v1: [slot("Pastor")] } });
    const shown = await showScreen("/display-1", state);
    const withBar = (shown.firstElementChild as HTMLElement).children.length;
    cleanup();

    const off = await showScreen("/display-1", stageState({
      slotsByView: { v1: [slot("Pastor")] },
      resolvedByOutput: { "display-1": resolved({ hideTopBar: true }) },
    }));
    const withoutBar = (off.firstElementChild as HTMLElement).children.length;
    assert.equal(
      withoutBar,
      withBar - 1,
      `the kiosk shell went from ${withBar} children to ${withoutBar}: the bar left something behind`,
    );
  });
});

describe("KIND_DRAWS_TOP_BAR is what the arms actually render", () => {
  // The anti-drift guard. `stage-view.tsx` decides a bar in two places — the
  // KioskFrame arms read the map, the slots and custom shells are bespoke — and
  // `outputs-section.tsx` reads the map to decide whether its two bar menu items
  // are worth offering. Nothing keeps those in step except this.
  //
  // It loops the MAP, not a hand-written list, so a ViewKind added tomorrow is
  // rendered here the moment it is given a value — there is no row to forget.
  // The map's type already refuses a kind with no value at all.
  const TOP_BAR = "Weekend: A plan";
  const hasTopBar = (c: HTMLElement) => says(c, TOP_BAR);

  /** What each kind needs on its View before its arm will draw anything. */
  const EXTRAS: Partial<Record<ViewKind, Record<string, unknown>>> = {
    custom: { layout: { canvas: { width: 1920, height: 1080, background: null }, objects: [] } },
    script: { scriptViewLayoutId: "sl1" },
  };

  for (const [kind, draws] of Object.entries(KIND_DRAWS_TOP_BAR) as [ViewKind, boolean][]) {
    test(`${kind} draws ${draws ? "a" : "no"} top bar`, async () => {
      const c = await showScreen("/display-1", {
        ...ofKind(kind, EXTRAS[kind] ?? {}),
        slotsByView: { v1: [slot("Pastor")] },
      });
      assert.equal(
        hasTopBar(c),
        draws,
        draws
          ? `KIND_DRAWS_TOP_BAR says ${kind} draws a bar and it did not: its arm does not read the map`
          : `${kind} drew a bar the map does not declare — an arm decided for itself`,
      );
    });
  }

  test("every ViewKind is covered, so a new kind cannot slip past", () => {
    // Belt to the Record's braces: the type stops a kind with no value, this
    // stops the map being widened to `Record<string, boolean>` some day and the
    // loop above quietly shrinking to whatever happens to be listed.
    assert.deepEqual(
      Object.keys(KIND_DRAWS_TOP_BAR).sort(),
      [...everyViewKind(["slots", "dashboard", "stage", "transcription", "custom", "script", "spl-rundown", "calendar"])].sort(),
    );
  });
});
