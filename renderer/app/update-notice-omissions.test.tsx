// What the post-update dialog is NOT showing, said out loud.
//
// The release notes generator caps each release's change lists and writes how
// much it cut — `- …and 37 more` — and the dialog's parser dropped that bullet
// as markdown furniture. Its own cap then cut more and said nothing at all, and
// the generator's held-back sentence ("36 further fixes … are not listed") was
// dropped for the crime of being a paragraph rather than a bullet.
//
// Net, for 1.18.0: 49 features, twelve shown, and nothing anywhere to suggest
// the other 37 existed — a new ProdCom websocket transport, Planning Center
// rate-limit backoff, YouTube viewer counts, wireless mute and interference,
// REAPER transport, ProPresenter macros, the cues manifest and the Download
// YAML button among them. A dialog reporting success having shown a quarter of
// the release.
//
// WHAT THIS FILE CANNOT SEE — browser-only, checked by hand against the
// production bundle served by a real server on a spare port, in both themes:
//   - that the count line reads as a footnote rather than as another change.
//     jsdom loads no stylesheet, so `text-caption1 text-fg-subtle` resolves to
//     the document default here and proves nothing. Measured in Chrome: the
//     token is #63636b on the light card and rgba(255,255,255,.45) on the dark
//     one, against bullets at the ordinary foreground.
//   - that a section with NO bullets left still lays out — the `<ul>` is gone,
//     so the count block supplies its own top padding. Driven with a Breaking
//     section capped to nothing; heading, count and note all render.
// Both were verified with the real dialog, over a seeded update-notices.json,
// at 1280x1400 light and 900x1500 dark.
//
// Every version and change line below is INVENTED. This is a public repository.

import { strict as assert } from "node:assert";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { installDom, settle, unmountAndTeardown } from "../test-dom.js";
import type { ReleaseSection } from "@main/services/update/release-notes";

const teardown = installDom();
// React only act-wraps a render, and only warns when an update escapes one,
// once it is told it is in a test environment. Without this the file reads
// as clean while 90 updates land outside act — which is why it was
// cleared the first time round.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class StubEventSource {
  readyState = 0;
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
}
(globalThis as unknown as { EventSource: unknown }).EventSource = StubEventSource;

/** What GET /api/update/notices answers with. Swapped per test. */
let notice: unknown = null;

(globalThis as unknown as { fetch: unknown }).fetch = async (url: string) => {
  const payload = url.includes("/api/update/notices") ? { justUpdated: notice } : {};
  return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
};

// After installDom(), never before: a static import evaluates first and React
// would come up with no document.
const { render, screen, cleanup } = await import("@testing-library/react");
const React = (await import("react")).default;
const { UpdateNotices } = await import("./update-notices.js");

after(() => unmountAndTeardown(cleanup, teardown));
beforeEach(() => { cleanup(); notice = null; });
afterEach(async () => { cleanup(); await settle(); });

async function mount(notes: ReleaseSection[]) {
  notice = {
    version: "v9.9.0",
    fromVersion: "9.8.1",
    notes,
    lines: [],
    at: "2020-01-01T00:00:00.000Z",
  };
  const view = render(React.createElement(UpdateNotices));
  await settle();
  await settle();
  return view;
}

describe("the dialog says how much it is not showing", () => {
  test("the count the notes generator published is rendered, not swallowed", async () => {
    await mount([{ section: "New", lines: ["a new thing"], omitted: 37 }]);
    assert.ok(screen.getByText(/…and 37 more/), "the release cut 37 lines and the dialog said nothing");
    // And the one line it DID get is still there — the count is an addition.
    assert.ok(screen.getByText("a new thing"));
  });

  test("the generator's held-back sentence is rendered too", async () => {
    await mount([{
      section: "Fixed",
      lines: ["a real fix"],
      omitted: 0,
      note: "36 further fixes made while building the features above are not listed.",
    }]);
    assert.ok(
      screen.getByText(/36 further fixes made while building/),
      "the sentence explaining the omission never reached the operator",
    );
  });

  test("a section cut to nothing still renders its heading and its count", async () => {
    // The case that has no bullets to hang anything on. Dropping the section
    // would be the same silence one level up.
    await mount([{ section: "Breaking", lines: [], omitted: 4 }]);
    assert.ok(screen.getByText("Breaking"));
    assert.ok(screen.getByText(/…and 4 more/));
  });

  test("a section that cut nothing gets no count line", async () => {
    // A footnote under every list would train the eye to skip it.
    await mount([{ section: "New", lines: ["all of it"], omitted: 0 }]);
    assert.equal(screen.queryByText(/…and \d+ more/), null);
  });

  test("a notice stored by an older server draws no count rather than a wrong one", async () => {
    // Notices are captured BEFORE the update runs, so one written by the
    // previous version is read by this code and simply has no `omitted`. Zero
    // is not a fact we have; absence of a count is.
    await mount([{ section: "New", lines: ["from last week's notice"] } as ReleaseSection]);
    assert.ok(screen.getByText("from last week's notice"));
    assert.equal(screen.queryByText(/…and/), null);
  });
});
