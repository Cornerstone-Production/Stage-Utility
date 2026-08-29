// Every screen StageView can land on, rendered.
//
// This file exists to be a PARITY BASELINE. It was written against the
// fourteen-return version of the component, run green, and only then did the
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
import { after, afterEach, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

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
  return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
};

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { render, cleanup, act } = await import("@testing-library/react");
const React = (await import("react")).default;
const { StageView } = await import("./stage-view.js");
const { TooltipProvider } = await import("../components/ui/tooltip-provider.js");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");

// The two providers the kiosk entry (renderer/main/index.tsx) wraps the view in.
// Without them the top bar's Tooltip throws and EVERY screen with a top bar
// renders the error boundary instead — which would make this file assert that
// four different screens all say "Display error".
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

const settle = () => new Promise((r) => setTimeout(r, 0));
after(async () => { cleanup(); await settle(); teardown(); });
afterEach(async () => { cleanup(); await settle(); });

// ---- fixtures ---------------------------------------------------------------

function resolved(over: Record<string, unknown> = {}) {
  return { viewId: "v1", kind: "slots", ndiSource: null, viewName: "Mic board", blackout: false, locked: false, ...over };
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

  test("a kind this build does not recognise lands on a screen, never a blank one", async () => {
    // Not a hypothetical: a newer server may route a View kind this build has
    // never heard of. The chain has no arm for it, so it falls through to the
    // slots path — which must still draw something an operator can read.
    const c = await showScreen("/display-1", stageState({
      views: [{ id: "v1", name: "From the future", kind: "holodeck" }],
      resolvedByOutput: { "display-1": resolved({ kind: "holodeck" }) },
    }));
    assert.ok((c.textContent ?? "").length > 0, "an unknown kind rendered nothing at all");
    assert.ok(says(c, "No mic slots assigned yet"), c.textContent ?? "");
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
    outputs: [{ id: "display-1", name: "Stage left", viewId: "v1", ...(mode ? { mode } : {}) }],
    resolvedByOutput: { "display-1": resolved({ kind: "custom" }) },
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
