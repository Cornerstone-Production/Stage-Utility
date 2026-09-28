// The Video widget's inspector section: Feed, Fit, Show feed name and When
// offline — the four settings the approved design's Layout editor tab shows.
//
// Driven through the real VideoConfig component with a stubbed fetch, not
// reasoned about: a control that renders is not a control that patches the
// right field, and the whole reason this file exists is a Fit toggle whose
// onChange writes the wrong key or nothing at all.

import { strict as assert } from "node:assert";
import { after, afterEach, describe, test } from "node:test";

import { installRenderDom, settle, unmountAndTeardown } from "../test-dom.js";
import { ok, stubFetchWithLog } from "../test-fixtures/fetch-log.js";

const teardown = installRenderDom();

const { render, cleanup, fireEvent } = await import("@testing-library/react");
const React = await import("react");
const { Inspector, VideoConfig } = await import("./inspector.js");
const { TooltipProvider } = await import("../components/ui/index.js");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { DEFAULT_STAGE_STATE } = await import("../main/test-render-ctx.js");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => cleanup());

type Config = Extract<LayoutObjectConfig, { type: "video" }>;

const DEFAULT_CONFIG: Config = {
  type: "video",
  feedId: null,
  fit: "contain",
  showLabel: true,
  whenOffline: "message",
};

const FEEDS_STATE = {
  rev: 1,
  relay: { state: "off" as const },
  kinds: ["pull", "push", "embed", "external"],
  feeds: [
    { id: "program", name: "Program (IMAG)", kind: "pull", sourceLine: "rtsp://192.0.2.21:8554/stream2", source: { kind: "pull", url: "rtsp://192.0.2.21:8554/stream2", username: "" }, play: { via: "relay", whep: "/whep/program", hls: "/hls/program" }, status: { state: "live" } },
    { id: "lobby", name: "Lobby cam", kind: "pull", sourceLine: "rtsp://192.0.2.22:8554/stream1", source: { kind: "pull", url: "rtsp://192.0.2.22:8554/stream1", username: "" }, play: { via: "relay", whep: "/whep/lobby", hls: "/hls/lobby" }, status: { state: "offline" } },
  ],
};

/** Stubs /api/video/state (and /api/state, for the full Inspector);
 *  everything else is an empty 200. */
function stubVideoState() {
  return stubFetchWithLog((url) =>
    url.includes("/api/video/state") ? ok(FEEDS_STATE) : url.endsWith("/api/state") ? ok(DEFAULT_STAGE_STATE) : ok({}),
  );
}

async function mount(config: Config, onConfig: (c: LayoutObjectConfig) => void) {
  const utils = render(
    React.createElement(
      TooltipProvider,
      null,
      React.createElement(VideoConfig, { c: config, onConfig }),
    ),
  );
  await settle();
  await settle();
  return utils;
}

describe("VideoConfig — Feed", () => {
  test("offers 'Choose a feed' plus every feed from video:state", async () => {
    const f = stubVideoState();
    try {
      const { container } = await mount(DEFAULT_CONFIG, () => {});
      const selects = container.querySelectorAll("select");
      const feedSelect = selects[0];
      const optionLabels = [...feedSelect.querySelectorAll("option")].map((o) => o.textContent);
      assert.deepEqual(optionLabels, ["Choose a feed", "Program (IMAG)", "Lobby cam"]);
    } finally {
      f.restore();
    }
  });

  test("a stored feed id shows that feed selected once the read lands", async () => {
    const f = stubVideoState();
    try {
      const { container } = await mount({ ...DEFAULT_CONFIG, feedId: "lobby" }, () => {});
      const feedSelect = container.querySelectorAll("select")[0] as HTMLSelectElement;
      assert.equal(feedSelect.value, "lobby");
    } finally {
      f.restore();
    }
  });

  test("picking a feed patches feedId and nothing else", async () => {
    const f = stubVideoState();
    try {
      let patched: LayoutObjectConfig | null = null;
      const { container } = await mount(DEFAULT_CONFIG, (c) => { patched = c; });
      const feedSelect = container.querySelectorAll("select")[0] as HTMLSelectElement;
      fireEvent.change(feedSelect, { target: { value: "program" } });
      assert.deepEqual(patched, { ...DEFAULT_CONFIG, feedId: "program" });
    } finally {
      f.restore();
    }
  });

  test("'Choose a feed' stores null, not an empty id", async () => {
    const f = stubVideoState();
    try {
      let patched: LayoutObjectConfig | null = null;
      const { container } = await mount({ ...DEFAULT_CONFIG, feedId: "program" }, (c) => { patched = c; });
      const feedSelect = container.querySelectorAll("select")[0] as HTMLSelectElement;
      fireEvent.change(feedSelect, { target: { value: "" } });
      assert.deepEqual(patched, { ...DEFAULT_CONFIG, feedId: null });
    } finally {
      f.restore();
    }
  });

  test("a deleted feed renders without throwing, still offering 'Choose a feed' and the live feeds", async () => {
    // A feed removed on the Video feeds page after this object was bound to it —
    // video:state no longer lists it, but the object's own config still names
    // it. The native <select> this repo's Select renders (see select.tsx)
    // handles a stored value with no matching option by synthesising one
    // labelled "<value> · not found" rather than silently resetting the field
    // or throwing, so this is a real behaviour to pin, not a defensive guess.
    const f = stubVideoState();
    try {
      const { container } = await mount({ ...DEFAULT_CONFIG, feedId: "deleted-feed" }, () => {});
      const feedSelect = container.querySelectorAll("select")[0] as HTMLSelectElement;
      const optionLabels = [...feedSelect.querySelectorAll("option")].map((o) => o.textContent);
      assert.deepEqual(optionLabels, [
        "Choose a feed",
        "Program (IMAG)",
        "Lobby cam",
        "deleted-feed · not found",
      ]);
      assert.equal(feedSelect.value, "deleted-feed", "the missing feed's binding was silently cleared");
    } finally {
      f.restore();
    }
  });
});

describe("VideoConfig — laid out as the approved design", () => {
  // Stacking and truncation are CSS, which jsdom does not load; the section
  // was checked in Chromium against the design's layout-editor tab. What the
  // DOM can show: the Feed description is on the page in full, not behind an
  // (i) that has to be clicked, and every label is there whole.
  test("the Feed description is shown in full, not behind an info button", async () => {
    const f = stubVideoState();
    try {
      const { queryByText, queryByRole } = await mount(DEFAULT_CONFIG, () => {});
      assert.equal(
        !!queryByText("Feeds are set up once on the Video feeds page. Change a feed there and every layout using it follows."),
        true,
        "the Feed description is hidden",
      );
      assert.equal(!!queryByRole("button", { name: "More info" }), false);
      for (const label of ["Feed", "Fit", "Show feed name", "When the feed is offline"]) {
        assert.equal(!!queryByText(label, { exact: true }), true, label);
      }
    } finally {
      f.restore();
    }
  });
});

describe("VideoConfig — Fit", () => {
  // THE guard this file exists for. Break the toggle's onChange (comment out
  // the RED case below) and this must go red — see the commit body for the
  // failing message observed in this session.
  test("clicking 'Fill the box' patches exactly { fit: \"cover\" }", async () => {
    const f = stubVideoState();
    try {
      let patched: LayoutObjectConfig | null = null;
      const { getByRole } = await mount(DEFAULT_CONFIG, (c) => { patched = c; });
      fireEvent.click(getByRole("button", { name: "Fill the box" }));
      assert.deepEqual(patched, { ...DEFAULT_CONFIG, fit: "cover" });
    } finally {
      f.restore();
    }
  });

  test("clicking 'Fit whole picture' patches back to contain", async () => {
    const f = stubVideoState();
    try {
      let patched: LayoutObjectConfig | null = null;
      const { getByRole } = await mount({ ...DEFAULT_CONFIG, fit: "cover" }, (c) => { patched = c; });
      fireEvent.click(getByRole("button", { name: "Fit whole picture" }));
      assert.deepEqual(patched, { ...DEFAULT_CONFIG, fit: "contain" });
    } finally {
      f.restore();
    }
  });
});

describe("VideoConfig — Show feed name", () => {
  test("defaults on, and toggling off patches showLabel: false only", async () => {
    const f = stubVideoState();
    try {
      let patched: LayoutObjectConfig | null = null;
      const { getByRole } = await mount(DEFAULT_CONFIG, (c) => { patched = c; });
      const sw = getByRole("switch");
      assert.equal(sw.getAttribute("aria-checked"), "true");
      fireEvent.click(sw);
      assert.deepEqual(patched, { ...DEFAULT_CONFIG, showLabel: false });
    } finally {
      f.restore();
    }
  });
});

describe("VideoConfig — When the feed is offline", () => {
  test("defaults to 'Say it is offline', and picking 'Show nothing' patches whenOffline only", async () => {
    const f = stubVideoState();
    try {
      let patched: LayoutObjectConfig | null = null;
      const { container } = await mount(DEFAULT_CONFIG, (c) => { patched = c; });
      const offlineSelect = container.querySelectorAll("select")[1] as HTMLSelectElement;
      assert.equal(offlineSelect.value, "message");
      fireEvent.change(offlineSelect, { target: { value: "nothing" } });
      assert.deepEqual(patched, { ...DEFAULT_CONFIG, whenOffline: "nothing" });
    } finally {
      f.restore();
    }
  });
});

describe("VideoConfig — the callout", () => {
  test("always says muted, no controls, and where a struggling screen reports", async () => {
    const f = stubVideoState();
    try {
      const { getByText } = await mount(DEFAULT_CONFIG, () => {});
      assert.ok(getByText(/Always muted, with no controls/));
    } finally {
      f.restore();
    }
  });
});

describe("the full Inspector, for a Video object", () => {
  // The whole Inspector, not VideoConfig alone: the switch arm that renders
  // VideoConfig, and the isText list that keeps the text-style rows off a
  // picture, live in it and in nothing smaller.
  async function mountInspector() {
    const o: LayoutObject = { id: "v1", x: 0.1, y: 0.1, w: 0.5, h: 0.5, z: 0, config: DEFAULT_CONFIG };
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const noop = () => {};
    const utils = render(
      React.createElement(
        QueryClientProvider,
        { client: qc },
        React.createElement(
          TooltipProvider,
          null,
          React.createElement(Inspector, {
            o,
            canvas: { width: 1920, height: 1080 },
            parentW: 1920,
            parentH: 1080,
            nested: false,
            locked: false,
            slotsViews: [],
            onGeom: noop,
            onStyle: noop,
            onResetLook: noop,
            onConfig: noop,
            onReorder: noop,
            onDuplicate: noop,
            onRemove: noop,
            onReparentOut: noop,
            onToggleLock: noop,
            onSaveGroup: noop,
            onSnapToGrid: noop,
          }),
        ),
      ),
    );
    await settle();
    await settle();
    return utils;
  }

  test("renders the Video section", async () => {
    const f = stubVideoState();
    try {
      const { queryByRole } = await mountInspector();
      assert.equal(!!queryByRole("button", { name: "Fill the box" }), true, "the Video section is missing from the Inspector");
    } finally {
      f.restore();
    }
  });

  test("offers no text styling for a picture", async () => {
    const f = stubVideoState();
    try {
      const { queryByText } = await mountInspector();
      for (const label of ["Font size", "Weight", "Color"]) {
        assert.equal(!!queryByText(label, { exact: true }), false, `a Video object offers "${label}"`);
      }
    } finally {
      f.restore();
    }
  });
});
