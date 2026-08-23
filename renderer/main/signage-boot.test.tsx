// A signage screen coming up with no server.
//
// The claim this feature is sold on is that a Pi keeps playing through a power
// cut on a dead network. Every piece of that was in place and the screen still
// came up on an error page, because the kiosk shell will not render ANYTHING
// until /api/state answers — and on a cold boot offline it never does.
//
// So this drives the real shell with a dead server: fetch rejects, the event
// stream never opens. The assertion is what is on the wall.

import { strict as assert } from "node:assert";
import { after, beforeEach, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

// A dead server, exactly as a rebooted Pi finds one: every request refused, and
// an event stream that opens onto nothing.
const g = globalThis as unknown as Record<string, unknown>;
g.fetch = () => Promise.reject(new Error("ECONNREFUSED"));
class DeadEventSource {
  static readonly CLOSED = 2;
  readyState = 2;
  onopen: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  addEventListener() {}
  removeEventListener() {}
  close() {}
}
g.EventSource = DeadEventSource;

const { render, cleanup, screen, waitFor } = await import("@testing-library/react");
const React = await import("react");
const { StageView } = await import("./stage-view.js");
const boot = await import("./signage-boot.js");

after(() => {
  cleanup();
  teardown();
});

/** Point the shell at a path, the way a browser would. */
function at(pathname: string) {
  window.history.replaceState({}, "", pathname);
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
});

describe("a screen booting with no server", () => {
  test("plays the signage it last held instead of the could-not-load screen", async () => {
    boot.rememberSignageBoot("display-9", "display-9");
    at("/display-9");

    render(React.createElement(StageView));

    // The state fetch has to be given its chance to fail — the bug is precisely
    // that the shell waits for it, so asserting before it settles would pass
    // against the broken version too.
    await waitFor(() => {
      assert.equal(screen.queryByText(/Could not load stage state/i), null);
    });
    assert.equal(screen.queryByText(/Loading stage/i), null);
    assert.ok(
      document.querySelector("[data-signage-player]"),
      "nothing on this wall is a signage screen",
    );
  });

  test("a device that boots at its own /enroll URL plays too", async () => {
    // The path a Pi is actually on when the server is gone: chromium opens
    // /enroll?device=… and the redirect that would take it to /display-9 never
    // happens. Keyed only on the display path, this screen stayed dark.
    boot.rememberSignageBoot("display-9", "display-9");
    at("/enroll?device=abc");

    render(React.createElement(StageView));

    await waitFor(() => {
      assert.ok(
        document.querySelector("[data-signage-player]"),
        "a device booting at /enroll did not reach its signage",
      );
    });
  });

  test("a screen that never played signage still shows the error", async () => {
    // The other half. Nothing here should turn every dead-server display into a
    // black rectangle that hides the fact that the server is down.
    at("/display-4");

    render(React.createElement(StageView));

    await screen.findByText(/Could not load stage state/i);
    assert.equal(document.querySelector("[data-signage-player]"), null);
  });

  test("a remembered screen does not answer for a different display", async () => {
    boot.rememberSignageBoot("display-9", "display-9");
    at("/display-4");

    render(React.createElement(StageView));

    await screen.findByText(/Could not load stage state/i);
  });
});

describe("the boot record", () => {
  test("survives a round trip and normalises the path", () => {
    assert.equal(boot.rememberSignageBoot("/Display-9/", "display-9"), true);
    assert.deepEqual(boot.readSignageBoot(), { path: "display-9", outputId: "display-9" });
  });

  test("a friendly slug still resolves to the canonical output id", () => {
    // The persisted horizon is keyed by id. A slug reaching IndexedDB finds
    // nothing, and the screen boots black with a perfectly good plan on disk.
    boot.rememberSignageBoot("foyer-north", "display-9");
    assert.equal(boot.signageBootOutput("/foyer-north", boot.readSignageBoot()), "display-9");
  });

  test("malformed storage reads as nothing remembered", () => {
    localStorage.setItem("stage:signage-screen", "{not json");
    assert.equal(boot.readSignageBoot(), null);
    localStorage.setItem("stage:signage-screen", JSON.stringify({ path: "display-9" }));
    assert.equal(boot.readSignageBoot(), null);
  });

  test("forgetting it means waiting for the server again", () => {
    boot.rememberSignageBoot("display-9", "display-9");
    boot.forgetSignageBoot("display-9");
    assert.equal(boot.signageBootOutput("display-9", boot.readSignageBoot()), null);
  });

  test("another display in the same browser does not erase it", () => {
    // One record per browser profile, which is right for a kiosk device showing
    // one screen. Unscoped, opening a slots display on the same machine would
    // quietly cost the signage screen its ability to come back after a power cut.
    boot.rememberSignageBoot("display-9", "display-9");
    boot.forgetSignageBoot("display-4");
    assert.deepEqual(boot.readSignageBoot(), { path: "display-9", outputId: "display-9" });
  });
});
