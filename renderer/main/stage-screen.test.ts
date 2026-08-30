// Every screen a wall display can land on, asserted without a browser.
//
// Before resolveScreen existed, the only way to check "a blackout beats the
// routed view" or "a lock never applies in the settings preview" was to open a
// kiosk page and look at it. These are the same decisions, run as functions.

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { resolveScreen, type ScreenInput } from "./stage-screen.js";

// ---- fixtures ---------------------------------------------------------------

function resolvedOutput(over: Partial<ResolvedOutput> = {}): ResolvedOutput {
  return {
    viewId: "v1",
    kind: "slots",
    ndiSource: null,
    viewName: "Mic board",
    blackout: false,
    locked: false,
    hideTopBar: false,
    ...over,
  };
}

function stageState(over: Partial<StageState> = {}): StageState {
  return {
    pcoConfigured: true,
    views: [{ id: "v1", name: "Mic board", kind: "slots" }],
    outputs: [{ id: "display-1", name: "Stage left", viewId: "v1" }],
    resolvedByOutput: { "display-1": resolvedOutput() },
    slotsByView: {},
    ...over,
  } as unknown as StageState;
}

function input(over: Partial<ScreenInput> = {}): ScreenInput {
  return {
    state: stageState(),
    isLoading: false,
    error: null,
    displayId: "display-1",
    previewViewId: null,
    ...over,
  };
}

// ---- lifecycle --------------------------------------------------------------

describe("lifecycle comes first", () => {
  test("loading beats everything, including a blackout", () => {
    const screen = resolveScreen(input({
      isLoading: true,
      state: stageState({ resolvedByOutput: { "display-1": resolvedOutput({ blackout: true }) } }),
    }));
    assert.equal(screen.k, "loading");
  });

  test("an error beats a missing state", () => {
    const screen = resolveScreen(input({ error: "SSE dropped", state: null }));
    assert.deepEqual(screen, { k: "error", message: "SSE dropped" });
  });

  test("a missing state is an error, not an empty screen", () => {
    const screen = resolveScreen(input({ state: null }));
    assert.deepEqual(screen, { k: "error", message: "State is unavailable." });
  });
});

// ---- output state -----------------------------------------------------------

describe("output state", () => {
  test("BLACKOUT beats the routed view", () => {
    // Toggling blackout off must restore the view instantly, so blackout is a
    // state, not a property of the view.
    const screen = resolveScreen(input({
      state: stageState({ resolvedByOutput: { "display-1": resolvedOutput({ blackout: true }) } }),
    }));
    assert.equal(screen.k, "blackout");
  });

  test("a blackout with nothing routed is still black, not the unrouted placeholder", () => {
    // Blackout is checked BEFORE routing: an operator who blacks out a screen
    // gets black, whatever that screen is (or is not) showing.
    const screen = resolveScreen(input({
      state: stageState({
        resolvedByOutput: { "display-1": resolvedOutput({ viewId: null, blackout: true }) },
      }),
    }));
    assert.equal(screen.k, "blackout");
  });

  test("a PREVIEW ignores blackout", () => {
    // The settings live preview renders a view regardless of output routing.
    const screen = resolveScreen(input({
      displayId: "preview-v1",
      previewViewId: "v1",
      state: stageState({ resolvedByOutput: { "preview-v1": resolvedOutput({ blackout: true }) } }),
    }));
    assert.equal(screen.k, "view");
  });

  test("an output with no view routed is unrouted, not empty", () => {
    const screen = resolveScreen(input({
      state: stageState({ resolvedByOutput: { "display-1": resolvedOutput({ viewId: null }) } }),
    }));
    assert.equal(screen.k, "unrouted");
  });

  test("an output the server never resolved is unrouted", () => {
    const screen = resolveScreen(input({ state: stageState({ resolvedByOutput: {} }) }));
    assert.equal(screen.k, "unrouted");
  });

  test("carries the lock through, and never locks a preview", () => {
    const locked = resolveScreen(input({
      state: stageState({ resolvedByOutput: { "display-1": resolvedOutput({ locked: true }) } }),
    }));
    assert.equal(locked.k === "view" && locked.locked, true);

    // The settings preview iframe is inside the operator app, where navigation
    // has to keep working — a lock must never follow the View into it.
    const preview = resolveScreen(input({
      displayId: "preview-v1",
      previewViewId: "v1",
      state: stageState({ resolvedByOutput: { "preview-v1": resolvedOutput({ locked: true }) } }),
    }));
    assert.equal(preview.k === "view" && preview.locked, false);
  });

  test("the lock reaches the unrouted and not-configured screens too", () => {
    const unrouted = resolveScreen(input({
      state: stageState({
        resolvedByOutput: { "display-1": resolvedOutput({ viewId: null, locked: true }) },
      }),
    }));
    assert.deepEqual(unrouted, { k: "unrouted", displayName: null, locked: true, hideTopBar: false });

    const notConfigured = resolveScreen(input({
      state: stageState({
        pcoConfigured: false,
        resolvedByOutput: { "display-1": resolvedOutput({ locked: true }) },
      }),
    }));
    assert.deepEqual(notConfigured, { k: "not-configured", displayName: null, locked: true, hideTopBar: false });
  });

  test("names the display only when there is more than one", () => {
    // Today displayName is null on a single-display install. Preserve that.
    const single = resolveScreen(input());
    assert.equal(single.k === "view" && single.displayName, null);

    const multi = resolveScreen(input({
      state: stageState({
        outputs: [
          { id: "display-1", name: "Stage left", viewId: "v1" },
          { id: "display-2", name: "Stage right", viewId: "v1" },
        ] as unknown as Output[],
      }),
    }));
    assert.equal(multi.k === "view" && multi.displayName, "Stage left");
  });

  test("a display id with no Output of its own is not named after the URL", () => {
    // This used to render the id — so a mistyped or stale address labelled the
    // screen with the URL fragment it was opened at. There is no name to show
    // here, and blank says that better than "display-9" does.
    const screen = resolveScreen(input({
      displayId: "display-9",
      state: stageState({
        outputs: [
          { id: "display-1", name: "Stage left", viewId: "v1" },
          { id: "display-2", name: "Stage right", viewId: "v1" },
        ] as unknown as Output[],
        resolvedByOutput: { "display-9": resolvedOutput() },
      }),
    }));
    assert.equal(screen.k === "view" && screen.displayName, null);
  });

  test("no screen is ever named after the URL it was opened at", () => {
    // The rule, rather than one instance of it: whatever the path was, the name
    // on the wall is an Output's name or nothing. Both routes that used to leak
    // it are covered — an id with no Output, and a preview of a deleted View.
    const outputs = [
      { id: "display-1", name: "Stage left", viewId: "v1" },
      { id: "display-2", name: "Stage right", viewId: "v1" },
    ] as unknown as Output[];
    const paths: [string, string | null][] = [
      ["display-9", null],
      ["left-mic", null],
      ["preview-gone", "gone"],
    ];
    for (const [displayId, previewViewId] of paths) {
      const screen = resolveScreen(input({
        displayId,
        previewViewId,
        state: stageState({ views: [], outputs, resolvedByOutput: { [displayId]: resolvedOutput() } }),
      }));
      const named = "displayName" in screen ? screen.displayName : null;
      assert.notEqual(named, displayId, `${displayId} was rendered as its own name`);
      assert.equal(named, null);
    }
  });

  test("a preview is never named, however many displays exist", () => {
    const screen = resolveScreen(input({
      displayId: "preview-v1",
      previewViewId: "v1",
      state: stageState({
        outputs: [
          { id: "display-1", name: "Stage left", viewId: "v1" },
          { id: "display-2", name: "Stage right", viewId: "v1" },
        ] as unknown as Output[],
      }),
    }));
    assert.equal(screen.k === "view" && screen.displayName, null);
  });
});

// ---- view kind --------------------------------------------------------------

describe("the view kind", () => {
  test("prefers the preview's kind over the routed one", () => {
    const screen = resolveScreen(input({
      displayId: "preview-v2",
      previewViewId: "v2",
      state: stageState({
        views: [
          { id: "v1", name: "Mic board", kind: "slots" },
          { id: "v2", name: "Lobby", kind: "dashboard" },
        ] as unknown as View[],
        resolvedByOutput: { "preview-v2": resolvedOutput({ kind: "slots" }) },
      }),
    }));
    assert.equal(screen.k === "view" && screen.kind, "dashboard");
    assert.equal(screen.k === "view" && screen.isPreview, true);
  });

  test("takes the routed view's kind when not previewing", () => {
    const screen = resolveScreen(input({
      state: stageState({
        views: [{ id: "v1", name: "Lobby", kind: "dashboard" }] as unknown as View[],
        resolvedByOutput: { "display-1": resolvedOutput({ kind: "dashboard" }) },
      }),
    }));
    assert.equal(screen.k === "view" && screen.kind, "dashboard");
    assert.equal(screen.k === "view" && screen.isPreview, false);
  });

  test("resolves the View object the arm will need", () => {
    // StageView computed activeView separately in the custom arm, the script arm
    // and the slots arm — the same expression all three times. One resolution
    // here serves all of them.
    const custom = resolveScreen(input({
      state: stageState({
        views: [{ id: "v1", name: "Wall", kind: "custom", layout: { canvas: { width: 1920 }, objects: [] } }] as unknown as View[],
        resolvedByOutput: { "display-1": resolvedOutput({ kind: "custom" }) },
      }),
    }));
    assert.equal(custom.k === "view" && custom.view?.id, "v1");

    const script = resolveScreen(input({
      state: stageState({
        views: [{ id: "v1", name: "Script", kind: "script", scriptViewLayoutId: "sl1" }] as unknown as View[],
        resolvedByOutput: { "display-1": resolvedOutput({ kind: "script" }) },
      }),
    }));
    assert.equal(script.k === "view" && script.view?.scriptViewLayoutId, "sl1");
  });

  test("the preview's own View wins over the routed one", () => {
    const screen = resolveScreen(input({
      displayId: "preview-v2",
      previewViewId: "v2",
      state: stageState({
        views: [
          { id: "v1", name: "Mic board", kind: "slots" },
          { id: "v2", name: "Lobby", kind: "slots" },
        ] as unknown as View[],
      }),
    }));
    assert.equal(screen.k === "view" && screen.view?.id, "v2");
  });

  test("routing that points at a deleted View still resolves a screen, with no View", () => {
    const screen = resolveScreen(input({
      state: stageState({
        views: [],
        resolvedByOutput: { "display-1": resolvedOutput({ viewId: "gone" }) },
      }),
    }));
    assert.equal(screen.k === "view" && screen.view, null);
  });

  test("every non-slots kind reaches its own arm", () => {
    for (const kind of ["dashboard", "stage", "transcription", "script", "spl-rundown"] as const) {
      const screen = resolveScreen(input({
        state: stageState({
          views: [{ id: "v1", name: "V", kind }] as unknown as View[],
          resolvedByOutput: { "display-1": resolvedOutput({ kind }) },
        }),
      }));
      assert.equal(screen.k, "view", `${kind} should render a view`);
      assert.equal(screen.k === "view" && screen.kind, kind);
    }
  });

  test("a custom View with a layout renders it; one without is empty", () => {
    const drawn = resolveScreen(input({
      state: stageState({
        views: [{ id: "v1", name: "Wall", kind: "custom", layout: { canvas: { width: 1920 }, objects: [] } }] as unknown as View[],
        resolvedByOutput: { "display-1": resolvedOutput({ kind: "custom" }) },
      }),
    }));
    assert.equal(drawn.k, "view");

    const blank = resolveScreen(input({
      state: stageState({
        views: [{ id: "v1", name: "Wall", kind: "custom" }] as unknown as View[],
        resolvedByOutput: { "display-1": resolvedOutput({ kind: "custom" }) },
      }),
    }));
    assert.deepEqual(blank, { k: "empty", displayName: null, locked: false, hideTopBar: false });
  });

  test("slots without Planning Center is not-configured", () => {
    const screen = resolveScreen(input({ state: stageState({ pcoConfigured: false }) }));
    assert.equal(screen.k, "not-configured");
  });

  test("Planning Center is only a prerequisite for slots, not for the other kinds", () => {
    // A dashboard or a custom wall does not need PCO to draw itself, and the
    // check sits after those arms so it never intercepts them.
    const screen = resolveScreen(input({
      state: stageState({
        pcoConfigured: false,
        views: [{ id: "v1", name: "Lobby", kind: "dashboard" }] as unknown as View[],
        resolvedByOutput: { "display-1": resolvedOutput({ kind: "dashboard" }) },
      }),
    }));
    assert.equal(screen.k, "view");
  });

  test("a configured slots display reaches the slots arm", () => {
    const screen = resolveScreen(input());
    assert.deepEqual(screen, {
      k: "view",
      kind: "slots",
      view: { id: "v1", name: "Mic board", kind: "slots" },
      displayId: "display-1",
      displayName: null,
      locked: false,
      hideTopBar: false,
      isPreview: false,
      outputMode: undefined,
    });
  });

  test("a kind this build does not recognise says so, rather than drawing slots", () => {
    // Not hypothetical: the app ships a beta/main track switch, so a View kind
    // written by a beta build and read by a main build is a real path.
    //
    // This used to fall through to the Planning-Center check and the slots arm,
    // because slots was the end of the chain rather than a case of its own. A
    // kind with no arm therefore drew somebody's MIC SLOTS — an office wall
    // showing a department's slot grid, with nothing on screen to say the build
    // simply could not draw what it was routed to.
    const unknown = "holodeck" as ViewKind;
    const routed = resolveScreen(input({
      state: stageState({
        views: [{ id: "v1", name: "From the future", kind: unknown }] as unknown as View[],
        resolvedByOutput: { "display-1": resolvedOutput({ kind: unknown }) },
      }),
    }));
    assert.equal(routed.k, "unknown-kind");
    // The kind is carried so the screen can name it — "a holodeck view" tells an
    // operator which screen to re-route; "something went wrong" does not.
    assert.equal(routed.k === "unknown-kind" && routed.kind, unknown);

    // Planning Center gates SLOTS, not everything past the known kinds. An
    // unrecognised kind is unrecognised whether or not PCO is connected, and
    // saying "connect Planning Center" here would be a false lead.
    const noPco = resolveScreen(input({
      state: stageState({
        pcoConfigured: false,
        views: [{ id: "v1", name: "From the future", kind: unknown }] as unknown as View[],
        resolvedByOutput: { "display-1": resolvedOutput({ kind: unknown }) },
      }),
    }));
    assert.equal(noPco.k, "unknown-kind");
  });

  test("carries the output's mode, and never a preview's", () => {
    // The custom arm turns this into `contextForOutput(mode, isPreview)`, which
    // decides whether a button on a wall screen actually fires. It rides along
    // with the screen because it comes from the same `outputs.find` the display
    // name does — looked up twice, the preview rule gets remembered once.
    const panel = resolveScreen(input({
      state: stageState({
        outputs: [{ id: "display-1", name: "Console", viewId: "v1", mode: "panel" }] as unknown as Output[],
      }),
    }));
    assert.equal(panel.k === "view" && panel.outputMode, "panel");

    const preview = resolveScreen(input({
      displayId: "preview-v1",
      previewViewId: "v1",
      state: stageState({
        outputs: [{ id: "preview-v1", name: "Not a screen", viewId: "v1", mode: "panel" }] as unknown as Output[],
      }),
    }));
    assert.equal(preview.k === "view" && preview.outputMode, undefined);
  });

  test("a preview of a View that no longer exists says so, instead of drawing slots", () => {
    // The old `?? "slots"` sent this state to the slots arm, so previewing a
    // deleted View drew an empty mic-slot grid — a screen that looks like a
    // configuration mistake rather than a deleted view. There is no default kind
    // now: the one state that has no source of its own gets its own screen.
    const screen = resolveScreen(input({
      displayId: "preview-gone",
      previewViewId: "gone",
      state: stageState({ views: [] }),
    }));
    assert.equal(screen.k, "view-missing");
  });

  test("a deleted View is view-missing in a preview and unrouted on a real output", () => {
    // The two are NOT the same event and must not share a screen. On a real
    // output the server clears the routing (viewId: null), so the display is
    // genuinely unrouted; in a preview the URL still names the View, and what is
    // missing is the View itself.
    const preview = resolveScreen(input({
      displayId: "preview-gone",
      previewViewId: "gone",
      state: stageState({ views: [] }),
    }));
    assert.equal(preview.k, "view-missing");

    const output = resolveScreen(input({
      state: stageState({
        views: [],
        resolvedByOutput: { "display-1": resolvedOutput({ viewId: null }) },
      }),
    }));
    assert.equal(output.k, "unrouted");
  });

  test("every kind that reaches a view arm came from a real source", () => {
    // What replaced `?? "slots"`: there is no value the resolver invents. Each
    // kind on a `view` screen is either the previewed View's or the resolved
    // routing's, and the one case with neither returns view-missing above.
    const routed = resolveScreen(input({
      state: stageState({
        views: [{ id: "v1", name: "Lobby", kind: "dashboard" }] as unknown as View[],
        resolvedByOutput: { "display-1": resolvedOutput({ kind: "dashboard" }) },
      }),
    }));
    assert.equal(routed.k === "view" && routed.kind, "dashboard");

    // A preview reads its own View, never the routing sitting under its slug.
    const previewed = resolveScreen(input({
      displayId: "preview-v1",
      previewViewId: "v1",
      state: stageState({
        views: [{ id: "v1", name: "Captions", kind: "transcription" }] as unknown as View[],
        resolvedByOutput: { "preview-v1": resolvedOutput({ kind: "stage" }) },
      }),
    }));
    assert.equal(previewed.k === "view" && previewed.kind, "transcription");
  });
});
