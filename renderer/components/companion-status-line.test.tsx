// The Companion panel's Status field is the ONLY place the row's message renders.
//
// ConnectionBadge — which every integration card and every dialog header uses —
// shows a message only while the row is in `error`. The Companion row is never in
// error: nothing dials out to fail, so it is `connected` with a module attached
// and `disconnected` without one. Anything written to `state.message` and not
// shown by this panel is written nowhere.
//
// The field used to be gated on `connection === "connected"`, which is "a
// Companion module is attached". Two things the message carries are true with
// none attached and were rendered nowhere at all:
//
//  - the connection health from the hourly reconcile. An install with no Stream
//    Deck plugged in still has twelve of its fifty-two Companion connections in
//    error, and that is exactly the install whose cues read unknown.
//  - the reason a Test failed. "Cannot reach Companion: …" was written to the row
//    and covered over with "No Companion clients connected yet."
//
// The strings below are the real ones, read off a live Companion 5.0.3+9703
// through the app's own server.

import { strict as assert } from "node:assert";
import { after, afterEach, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

const { render, cleanup } = await import("@testing-library/react");
const { installFakeServer, withQueryClient, blankState } = await import(
  "../test-fixtures/integrations-harness.js"
);
const { CompanionInfoPanel } = await import("./companion-info-panel.js");

// The panel reads useStageState() for the LAN address, which opens an
// EventSource. Without the fake server there is no EventSource in jsdom at all.
const server = installFakeServer();

after(() => {
  server.restore();
  teardown();
});
afterEach(() => cleanup());

const HEALTH = "12 of 52 connection(s) in error, 10 not reporting";

/** Mount the panel over a Companion row and hand back the Status field's text. */
function statusText(over: { connection?: string; message?: string | null }): string {
  const { container } = render(
    withQueryClient(
      <CompanionInfoPanel
        state={blankState("companion", {
          enabled: true,
          connection: (over.connection ?? "disconnected") as never,
          message: over.message ?? null,
        })}
      />,
    ),
  );
  const el = container.querySelector("[data-testid='companion-status']");
  assert.ok(el, "no Status field — this guard is looking at the wrong element");
  return el.textContent ?? "";
}

describe("the Companion Status field", () => {
  test("shows the health with NO module attached, which is when it matters most", () => {
    assert.equal(statusText({ connection: "disconnected", message: HEALTH }), HEALTH);
  });

  test("shows the client count and the health together", () => {
    const both = `2 Companion client(s) connected. ${HEALTH}`;
    assert.equal(statusText({ connection: "connected", message: both }), both);
  });

  test("shows why a Test failed instead of covering it with the empty-room line", () => {
    const why = "Cannot reach Companion: connect ECONNREFUSED";
    assert.equal(statusText({ connection: "error", message: why }), why);
  });

  test("with nothing to say it is still the empty-room line, not a blank field", () => {
    assert.equal(
      statusText({ connection: "disconnected", message: null }),
      "No Companion clients connected yet.",
    );
  });

  // Several sentences long now. `truncate` here would cut the health off the end,
  // which is where it sits — the Test button's footer echo already does, and this
  // field is what an operator reads instead.
  test("the field wraps rather than truncating", () => {
    render(
      withQueryClient(
        <CompanionInfoPanel
          state={blankState("companion", { enabled: true, message: HEALTH })}
        />,
      ),
    );
    const el = document.querySelector("[data-testid='companion-status']");
    const cls = el?.getAttribute("class") ?? "";
    assert.match(cls, /break-words/);
    assert.doesNotMatch(cls, /truncate|line-clamp/);
  });
});
