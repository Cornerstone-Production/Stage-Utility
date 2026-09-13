// ConnectionBadge is the only thing the integrations grid shows about a row's
// state, and it used to render `message` in the ERROR state and nowhere else.
//
// The case that matters: RossTalk appends " — simulate mode" to its CONNECTED
// message (integration-manager.refreshRossTalkSummary) with the comment "a
// connected badge would otherwise imply commands are reaching the device when
// they are being swallowed" — and then the badge dropped the suffix on the
// floor. An operator saw a green "Connected" over every command being discarded.
// Companion's connection health is the same shape and needed a whole panel of
// its own before it was visible anywhere.
//
// The strings below are the real ones, built by the real code in
// integration-manager.ts. Asserted against the rendered text, not against props.
//
// WHAT IS NOT TESTED HERE, and why. jsdom loads no stylesheet, so `truncate`,
// `max-w-[9rem]` and `shrink-0` all measure as nothing and a guard over them
// would pass whatever the classes said. The tooltip needs a real hover. Both
// were checked in a browser instead: a RossTalk tile at 252px shows "Connected"
// in full with the simulate suffix cut mid-word after it, the full string on
// hover; the wireless row and the ProPresenter instance row keep their controls
// on one line. What IS asserted here is the thing that was actually broken —
// whether the text reaches the DOM at all.

import { strict as assert } from "node:assert";
import { after, afterEach, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

const { render, cleanup } = await import("@testing-library/react");
const { TooltipProvider } = await import("./ui/index.js");
const { ConnectionBadge } = await import("./connection-badge.js");

after(() => teardown());
afterEach(() => cleanup());

/** Mount one badge and hand back everything it put on screen. */
function badgeText(props: {
  connection: string;
  message?: string | null;
  inbound?: boolean;
}): string {
  const { container } = render(
    <TooltipProvider>
      <ConnectionBadge
        connection={props.connection as never}
        message={props.message ?? null}
        inbound={props.inbound}
      />
    </TooltipProvider>,
  );
  return container.textContent ?? "";
}

describe("a non-error message reaches the grid", () => {
  test("RossTalk's simulate suffix shows on a CONNECTED row", () => {
    // refreshRossTalkSummary: `${connected} of ${enabled.length} target(s)${sim}`
    const text = badgeText({ connection: "connected", message: "2 of 2 target(s) — simulate mode" });
    assert.match(text, /simulate mode/, "the operator cannot see that commands are being discarded");
    assert.match(text, /Connected/, "the state word must survive beside the message");
  });

  test("Companion's connection health shows with no module attached", () => {
    // applyCompanionRow, disconnected half. Companion is inbound, so the word is
    // the empty-room line rather than "Disconnected".
    const health = "12 of 52 connection(s) in error, 10 not reporting";
    const text = badgeText({ connection: "disconnected", message: health, inbound: true });
    assert.match(text, /12 of 52 connection\(s\) in error/);
    assert.match(text, /No clients yet/);
  });

  test("a disconnected row keeps the word that says it is down", () => {
    // refreshRossTalkSummary's disconnected half: "3 target(s)" alone would read
    // like a healthy row. The colour cannot carry that on its own.
    const text = badgeText({ connection: "disconnected", message: "3 target(s)" });
    assert.match(text, /Disconnected/);
    assert.match(text, /3 target\(s\)/);
  });

  test("SenSource's occupancy source shows on a connected row", () => {
    // sensource-service's poll report: `${scope}, occ via ${occSource}`.
    const text = badgeText({ connection: "connected", message: "4 zone(s), occ via safespace/space" });
    assert.match(text, /occ via safespace\/space/);
  });

  test("a connecting row shows what it is dialling", () => {
    const text = badgeText({ connection: "connecting", message: "Connecting 192.0.2.50:9910" });
    assert.match(text, /Connecting…/);
    assert.match(text, /192\.0\.2\.50:9910/);
  });
});

describe("what the badge did before, unchanged", () => {
  test("an error still shows the message INSTEAD of the word", () => {
    const why = "Can't reach 192.0.2.50:1025 — ECONNREFUSED";
    const text = badgeText({ connection: "error", message: why });
    assert.equal(text, why, "the error branch must not grow a second label");
  });

  test("an error with no message is still labelled", () => {
    assert.equal(badgeText({ connection: "error", message: null }), "Error");
  });

  test("no message is the bare state word, with nothing appended", () => {
    assert.equal(badgeText({ connection: "connected", message: null }), "Connected");
    assert.equal(badgeText({ connection: "disconnected", message: null }), "Disconnected");
    assert.equal(badgeText({ connection: "disconnected", message: null, inbound: true }), "No clients yet");
    assert.equal(badgeText({ connection: "connecting", message: null }), "Connecting…");
  });

  test("a message of whitespace is not a message", () => {
    // The four call sites forward whatever the server last wrote, and a stray
    // "  " would otherwise open a tooltip on an empty box.
    assert.equal(badgeText({ connection: "connected", message: "   " }), "Connected");
  });
});

describe("what a screen reader is given", () => {
  test("the word and the message are one label, not two fragments", () => {
    render(
      <TooltipProvider>
        <ConnectionBadge connection={"connected" as never} message="2 of 2 target(s) — simulate mode" />
      </TooltipProvider>,
    );
    const el = document.querySelector("[aria-label]");
    assert.equal(el?.getAttribute("aria-label"), "Connected — 2 of 2 target(s) — simulate mode");
  });
});
