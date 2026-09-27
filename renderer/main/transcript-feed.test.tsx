// TranscriptFeed re-renders only the lines a push actually changed.
//
// WHAT THIS PROVES. `renderer/main/transcript-feed.tsx` used to give every
// visible line a brand-new element on every push, so React re-diffed the whole
// window (up to ~104 lines observed in production) even though a push at the
// buffer's cap only ever changes a handful. `TranscriptLineRow` below is a
// React.memo'd row with a custom comparator; the render counter
// (`__rowRenderCountForTests`) is the only way to observe a memo bail-out —
// jsdom does no layout and there is no DOM signal for "this row's render was
// skipped", only for "the DOM changed", and a re-rendered row can still leave
// the DOM untouched.
//
// EVERY "second push" below is `JSON.parse(JSON.stringify(...))` of the first,
// exactly like the real path (`sse-shared-worker.ts` parses a fresh string on
// every message): an object field compared with `===` would never be equal
// twice in a row even when nothing changed, so a comparator that got this
// wrong would show up here as either "identical resend" re-rendering
// everything, or a real change being silently swallowed.
//
// NOT covered here: the visual result (a pixel-level color, the CSS layout
// backing the scroll clip). jsdom loads no stylesheet and does no layout — this
// file only proves which rows re-ran, never what they painted. That was driven
// in WebKit; see the PR description.

import assert from "node:assert/strict";
import { after, afterEach, describe, test } from "node:test";

import { installRenderDom, unmountAndTeardown } from "../test-dom.js";

const teardown = installRenderDom();
const { render, cleanup } = await import("@testing-library/react");
const {
  TranscriptFeed,
  __rowRenderCountForTests,
  __resetRowRenderCountForTests,
} = await import("./transcript-feed.js");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => cleanup());

function makeLine(id: string, text: string, overrides: Partial<TranscriptLineDTO> = {}): TranscriptLineDTO {
  return {
    id,
    channel: "1",
    channelName: "Pastor",
    color: null,
    text,
    isFinal: true,
    at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function buildBuffer(n: number): TranscriptLineDTO[] {
  return Array.from({ length: n }, (_, i) => makeLine(`L${i}`, `line number ${i}`));
}

/** Mirrors the real wire path (see file header): a "fresh" copy of identical
 *  content is never referentially equal to the object it was cloned from. */
function freshParse<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("TranscriptFeed re-renders only the lines that changed", () => {
  test("a push where exactly one line's text changed re-renders exactly one row", () => {
    const first = buildBuffer(100);
    const { rerender } = render(<TranscriptFeed lines={first} />);
    __resetRowRenderCountForTests();

    const second = freshParse(first);
    second[50] = freshParse(makeLine("L50", "line number 50 — updated"));
    rerender(<TranscriptFeed lines={second} />);

    assert.equal(__rowRenderCountForTests(), 1, "only the one changed line should have re-rendered");
  });

  for (const field of ["text", "isFinal", "channel", "channelName", "color", "redactions"] as const) {
    test(`a line whose ${field} alone changed re-renders exactly that row`, () => {
      const first = buildBuffer(100);
      const { rerender } = render(<TranscriptFeed lines={first} />);
      __resetRowRenderCountForTests();

      const second = freshParse(first);
      const changed: Partial<TranscriptLineDTO> =
        field === "text" ? { text: "changed text" }
        : field === "isFinal" ? { isFinal: false }
        : field === "channel" ? { channel: "9" }
        : field === "channelName" ? { channelName: "Someone else" }
        : field === "color" ? { color: "#ff00ff" }
        : { redactions: 2 };
      second[50] = { ...second[50]!, ...changed };
      rerender(<TranscriptFeed lines={second} />);

      assert.equal(__rowRenderCountForTests(), 1, `changing only ${field} should re-render exactly one row`);
    });
  }

  test("a caption color override change re-renders every visible row", () => {
    const lines = buildBuffer(100);
    const { rerender } = render(<TranscriptFeed lines={lines} colorOverrides={{ Pastor: "#111111" }} />);
    __resetRowRenderCountForTests();

    // colorOverrides is one shared prop, not per-line, so every row's
    // `lineColor()` result can depend on it — the comparator cannot know which
    // rows actually use it without inspecting each line, so all of them
    // correctly re-render rather than risk a stale color on a row that does.
    rerender(<TranscriptFeed lines={lines} colorOverrides={{ Pastor: "#222222" }} />);

    assert.equal(__rowRenderCountForTests(), 100, "a color override change must reach every row that could use it");
  });

  test("the follow-ProdCom-colors switch re-renders every visible row", () => {
    const lines = buildBuffer(100);
    const { rerender } = render(<TranscriptFeed lines={lines} followProdcom={false} />);
    __resetRowRenderCountForTests();

    // followProdcom is one shared prop, not per-line, and feeds directly into
    // every row's lineColor() call (channel-color.ts's resolveChannelColor) —
    // the same reasoning as the color-override case above.
    rerender(<TranscriptFeed lines={lines} followProdcom={true} />);

    assert.equal(__rowRenderCountForTests(), 100, "toggling followProdcom must reach every row, since each one reads it");
  });

  test("the labels toggle re-renders every visible row", () => {
    const lines = buildBuffer(100);
    const { rerender } = render(<TranscriptFeed lines={lines} showLabels={true} />);
    __resetRowRenderCountForTests();

    rerender(<TranscriptFeed lines={lines} showLabels={false} />);

    assert.equal(__rowRenderCountForTests(), 100, "toggling labels must reach every row, since each one reads it");
  });

  test("a lineClassName change re-renders every visible row", () => {
    const lines = buildBuffer(100);
    const { rerender } = render(<TranscriptFeed lines={lines} lineClassName="text-lg" />);
    __resetRowRenderCountForTests();

    rerender(<TranscriptFeed lines={lines} lineClassName="text-xl" />);

    assert.equal(__rowRenderCountForTests(), 100, "a lineClassName change must reach every row, since each one reads it");
  });

  test("an identical re-send with fresh objects re-renders nothing", () => {
    const first = buildBuffer(100);
    const overrides = { Pastor: "#111111" };
    const { rerender } = render(<TranscriptFeed lines={first} colorOverrides={overrides} />);
    __resetRowRenderCountForTests();

    // Both the array of lines AND the colorOverrides map are fresh objects with
    // byte-identical content — the shape every consumer actually receives.
    rerender(<TranscriptFeed lines={freshParse(first)} colorOverrides={freshParse(overrides)} />);

    assert.equal(__rowRenderCountForTests(), 0, "nothing changed by value, so nothing should have re-rendered");
  });
});

// No test covers removing `line.id` from the comparator: `id` also serves as
// the React `key` (`key={l.id}` in transcript-feed.tsx), so a changed `id`
// makes React unmount the old element and mount a new one under the new key —
// the custom comparator is never invoked for that case at all, with or
// without `id` in it. Keeping the field is defensive, not load-bearing, and a
// test asserting it is load-bearing would be asserting something false.

describe("the scrollable feed's auto-scroll does not assume scrollIntoView exists", () => {
  test("renders and updates without throwing when the element has no scrollIntoView", () => {
    // jsdom ships no scrollIntoView at all (confirmed: typeof is "undefined",
    // not a no-op stub) — the same gap flagged in service-history-section.tsx
    // and worked around in flash.ts. No stub is installed here on purpose: an
    // unguarded `endRef.current.scrollIntoView(...)` throws inside the
    // passive effect the moment this renders, which is the point of the test.
    const lines = buildBuffer(3);
    assert.doesNotThrow(() => {
      const { rerender } = render(<TranscriptFeed lines={lines} scrollable />);
      rerender(<TranscriptFeed lines={[...lines, makeLine("L3", "a new line")]} scrollable />);
    });
  });
});
