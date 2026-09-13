// SafeSpace switched on with no space id has to be VISIBLE in the panel that
// fixes it.
//
// The space id is a bearer capability — safespace-client.ts: "THE SPACE ID IS
// THE ENTIRE CREDENTIAL. There is no key, no token and no account check" — so it
// lives in secrets.bin and a config snapshot deliberately does not carry it. The
// bundle DOES carry the marker that SafeSpace was on, which is the point: a
// restore onto another box lands in exactly this state.
//
// What makes it dangerous is that the fallback is CORRECT. The occupancy goes
// back to Vea, the count keeps coming, every display keeps working — and the
// site is quietly running on a number that refreshes about every 78 seconds
// instead of every ten, with a green Connected badge over it. The /log line and
// the row's message both say so, and both are transient; this is the one that
// stays put, beside the field the operator has to retype.
//
// `safeSpaceId` in the state map is the MASK, never the value: "••••" when one
// is stored, "" when none is. A fixture here could not contain a real id even by
// accident.
//
// NOT TESTED HERE: the amber border/background and where the block sits in the
// dialog are CSS, and jsdom loads no stylesheet. Checked in a browser instead.

import { strict as assert } from "node:assert";
import { after, afterEach, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

const { render, cleanup } = await import("@testing-library/react");
const { installFakeServer, withQueryClient, blankState } = await import(
  "../test-fixtures/integrations-harness.js"
);
const { SenSourceScopePicker } = await import("./sensource-scope-picker.js");

// The picker reads invoke() for the location/zone lists. `configured: false`
// with no saved scope means it does not auto-load, but the fake server is still
// needed for the EventSource jsdom does not have.
const server = installFakeServer();

after(() => {
  server.restore();
  teardown();
});
afterEach(() => cleanup());

/** Mount the SenSource panel over one config and hand back the notice, if any. */
function notice(config: Record<string, unknown>): string | null {
  const { container } = render(
    withQueryClient(
      <SenSourceScopePicker
        state={blankState("sensource", { enabled: true, config })}
        onStateChange={() => {}}
      />,
    ),
  );
  return container.querySelector("[data-testid='safespace-id-missing']")?.textContent ?? null;
}

describe("the SenSource panel's SafeSpace notice", () => {
  test("switched on with no id says so, and says what to do", () => {
    const text = notice({ safeSpaceEnabled: true, safeSpaceId: "" });
    assert.ok(text, "SafeSpace fell back to Vea and the panel said nothing at all");
    assert.match(text, /SafeSpace is on but has no space ID/);
    assert.match(text, /coming from Vea/, "it does not say what the count is running on now");
    assert.match(text, /clear that field to turn\s+SafeSpace off/, "it offers no way out but retyping");
  });

  test("with an id stored there is no notice", () => {
    // "••••" is what the server puts in the state for a stored secret.
    assert.equal(notice({ safeSpaceEnabled: true, safeSpaceId: "••••" }), null);
  });

  test("switched off there is no notice — most sites never had SafeSpace", () => {
    assert.equal(notice({ safeSpaceId: "" }), null);
    assert.equal(notice({ safeSpaceEnabled: false, safeSpaceId: "" }), null);
    assert.equal(notice({}), null);
  });
});
