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
// THE WAY OUT IS A BUTTON. The block used to say "save with that field left
// empty to turn SafeSpace off", and the server obliged on EVERY save — with no
// id stored the dialog seeds the field as "" and posts it whatever the operator
// came to change, so editing the Vea poll interval switched SafeSpace off by
// accident and the deliberate gesture could not be told apart from the accident.
// The button sends `safeSpaceEnabled: false`, which is the one thing a body may
// say about that key and can only ever remove the marker. The case below asserts
// the REQUEST it makes, not that it renders: a control that renders is not a
// control that does anything.
//
// NOT TESTED HERE: the amber border/background, where the block sits in the
// dialog, and whether the button is reachable at phone width are CSS, and jsdom
// loads no stylesheet. Driven in headless Chrome against a real server instead.

import { strict as assert } from "node:assert";
import { after, afterEach, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

const { render, cleanup, fireEvent, act } = await import("@testing-library/react");
const { installFakeServer, withQueryClient, blankState, settle } = await import(
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

/** Mount the SenSource panel over one config. */
function mount(config: Record<string, unknown>, onStateChange: (next: IntegrationState) => void = () => {}) {
  return render(
    withQueryClient(
      <SenSourceScopePicker
        state={blankState("sensource", { enabled: true, config })}
        onStateChange={onStateChange}
      />,
    ),
  );
}

/** Mount the SenSource panel over one config and hand back the notice, if any. */
function notice(config: Record<string, unknown>): string | null {
  return mount(config).container.querySelector("[data-testid='safespace-id-missing']")?.textContent ?? null;
}

describe("the SenSource panel's SafeSpace notice", () => {
  test("switched on with no id says so, and says what to do", () => {
    const text = notice({ safeSpaceEnabled: true, safeSpaceId: "" });
    assert.ok(text, "SafeSpace fell back to Vea and the panel said nothing at all");
    assert.match(text, /SafeSpace is on but has no space ID/);
    assert.match(text, /coming from Vea/, "it does not say what the count is running on now");
    assert.match(text, /turn\s+SafeSpace off/, "it offers no way out but retyping");
    assert.doesNotMatch(
      text,
      /save with that field/,
      "it still tells the operator to turn SafeSpace off by saving with the field empty. The " +
        "server no longer reads that as anything — it cannot, because the dialog posts an empty " +
        "field on every save in this state — so the instruction is one the app will not honour",
    );
  });

  test("the way out is a button that actually asks the server to turn it off", async () => {
    const seen: IntegrationState[] = [];
    const { container } = mount({ safeSpaceEnabled: true, safeSpaceId: "" }, (n) => seen.push(n));
    const button = container.querySelector<HTMLButtonElement>("[data-testid='safespace-turn-off']");
    assert.ok(button, "the notice offers no control at all");

    const before = server.posts.length;
    await act(async () => {
      fireEvent.click(button);
      await settle();
    });

    const posted = server.posts.slice(before);
    assert.deepEqual(
      posted,
      [
        {
          path: "/api/integrations/sensource/config",
          // `id` goes in the URL: renderer/lib/api.ts maps the channel to
          // POST /api/integrations/:id/config and sends only `config`.
          body: { config: { safeSpaceEnabled: false } },
        },
      ],
      "the button did not send exactly the one command that turns the marker off. " +
        "`safeSpaceEnabled: false` is the only thing the server reads as 'off' when no id is " +
        "stored, and the only thing it accepts for this key at all",
    );
    assert.equal(seen.length, 1, "the answer never reached the page, so the notice stays up until a reload");
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
