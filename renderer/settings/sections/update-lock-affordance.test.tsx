// While the update lock is active, the buttons it guards must READ as guarded
// and STAY clickable.
//
// The bug: the lock printed an amber "Update & restart locked — … or override in
// the dialog" sentence and then rendered "Update now" in the full accent, exactly
// as it looks when there is nothing to worry about. Reported as "the update
// button does not actually look locked..... or grayed".
//
// The fix is presentation only, and deliberately does NOT disable anything: a
// live service can go wrong and the operator may genuinely need to restart in
// the middle of one, so each of these opens a destructive override dialog
// instead of refusing. Disabling them would have been the easy wrong fix, so the
// not-disabled assertions below are the ones that must never go quietly green.
//
// WHAT THIS FILE CANNOT SEE — browser-only, and checked by hand against the
// production bundle in Chrome, in both themes:
//   - that the demoted button actually looks quieter than the accent one. jsdom
//     loads no stylesheet, so every colour resolves to the default. Measured:
//     accent rgb(46,102,145) on white text unlocked, versus the neutral fill —
//     rgba(0,0,0,.06) light, rgba(255,255,255,.07) dark — locked.
//   - that the lock glyph renders amber rather than the inherited foreground.
//     Measured: rgb(171,100,0) light and rgb(255,202,22) dark, the same value
//     the lock warning above the buttons resolves to in each theme.
// Opening on hover is the shared Tooltip's own behaviour, not this file's; all
// GuardedButton does is hand it a string.
//
// The class name is the closest observable jsdom has, and it is asserted in both
// directions: present when unlocked, absent when locked. That goes red on the
// reported bug; it cannot prove Tailwind still emits `bg-accent`, which the
// build does and which every other accent button in the app depends on.
//
// Every version, tag and reason below is INVENTED. This is a public repository.

import { strict as assert } from "node:assert";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { installDom } from "../../test-dom.js";
import type { UpdateStatus } from "@main/types/state";

const teardown = installDom();

// jsdom ships no EventSource, and this panel subscribes to four channels on
// mount so the lock indicator stays fresh while a service starts or ends.
class StubEventSource {
  readyState = 0;
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
}
(globalThis as unknown as { EventSource: unknown }).EventSource = StubEventSource;

/** What GET /api/update/lock answers with. Swapped per test. */
let lockReply: { active: boolean; reasons: string[] } = { active: false, reasons: [] };

(globalThis as unknown as { fetch: unknown }).fetch = async (url: string) => {
  const payload = url.includes("/api/update/lock") ? lockReply : {};
  return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
};

// After installDom(), never before: a static import evaluates first and React
// would come up with no document.
const { render, screen, cleanup, fireEvent } = await import("@testing-library/react");
const React = (await import("react")).default;
const { UpdatesPanel } = await import("./advanced-section.js");
const { ConfirmHost, TooltipProvider } = await import("../../components/ui/index.js");

const settle = () => new Promise((r) => setTimeout(r, 0));
after(async () => { await settle(); teardown(); });
beforeEach(() => { cleanup(); lockReply = { active: false, reasons: [] }; });
afterEach(async () => { cleanup(); await settle(); });

/** Every apply the panel asked for, with the override flag it passed. */
let applied: (boolean | undefined)[] = [];

/** An update status with one release waiting and a deferred restart pending. */
function status(over: Partial<UpdateStatus> = {}): UpdateStatus {
  return {
    isGitRepo: true,
    canUpdate: true,
    selfRecovers: true,
    branch: "beta",
    tracks: ["beta", "main"],
    version: "9.9.9",
    currentSha: "aaaaaaa",
    currentDate: "2020-01-01T00:00:00.000Z",
    behind: 3,
    behindUserFacing: 3,
    currentTag: "v9.9.9",
    targetTag: "v9.9.10",
    releasesBehind: 1,
    tagBased: true,
    latestSha: "bbbbbbb",
    latestDate: "2020-01-02T00:00:00.000Z",
    changelog: [],
    lastCheckedAt: "2020-01-02T00:00:00.000Z",
    phase: "idle",
    step: null,
    restartPending: true,
    lastResult: null,
    error: null,
    ...over,
  };
}

async function mount(over: Partial<UpdateStatus> = {}) {
  applied = [];
  const handlers = {
    handleCheckUpdates: async () => {},
    handleApplyUpdate: async (override?: boolean) => { applied.push(override); },
    handleSetAutoUpdate: async () => {},
  };
  // The operator app wraps everything in a TooltipProvider (renderer/app/index.tsx);
  // a guarded button carries a tooltip and Radix throws without one.
  const view = render(
    React.createElement(TooltipProvider, null,
      React.createElement(UpdatesPanel, {
        updateStatus: status(over),
        autoUpdate: { mode: "manual", dayOfWeek: null, hour: 3 },
        // Only the three update handlers are reached from this panel.
        handlers: handlers as unknown as Parameters<typeof UpdatesPanel>[0]["handlers"],
      }),
      React.createElement(ConfirmHost, null),
    ),
  );
  // The lock is fetched on mount; let that request land before asserting.
  await settle();
  await settle();
  return view;
}

/**
 * Every control the lock guards, and the label each shows in either state.
 *
 * One table rather than parallel lists, because the parity check below compares
 * the two states position by position and a list that drifted out of order would
 * still pass. `nth` disambiguates the two that share a locked name.
 *
 * Named rather than found by a class so a rename cannot silently drop one from
 * the sweep — the whole point of doing all four together.
 */
const CONTROLS = [
  { open: "Update now", shut: "Update anyway", nth: 0 },
  { open: "Restart", shut: "Restart anyway", nth: 0 },
  { open: "Switch", shut: "Switch anyway", nth: 0 },
  { open: "Restart now", shut: "Restart anyway", nth: 1 },
] as const;

/** Strict: throws rather than silently taking the first of several matches. */
function button(name: string): HTMLButtonElement {
  return screen.getByRole("button", { name }) as HTMLButtonElement;
}

/**
 * Pick the track this server is NOT on, which is the only thing that enables
 * Switch.
 *
 * Without this the parity check below is worthless: Switch is disabled by its
 * own rule whatever the lock does, so "same disabled either way" passes on a
 * lock that disables it. Proven — the first version of that check stayed green
 * with `guarded ||` added to Switch's `disabled`.
 */
function pickOtherTrack() {
  const select = screen.getByLabelText("Update track") as HTMLSelectElement;
  fireEvent.change(select, { target: { value: "main" } });
}

describe("update lock affordance", () => {
  test("locked: the guarded buttons are NOT disabled — the override is the point", async () => {
    lockReply = { active: true, reasons: ["A service is live", "Attendance is recording"] };
    await mount();
    pickOtherTrack();

    // "Restart anyway" appears twice — the row button and the restart-pending
    // banner — and both must stay live.
    const restarts = screen.getAllByRole("button", { name: "Restart anyway" }) as HTMLButtonElement[];
    assert.equal(restarts.length, 2, "both restart controls should be guarded");

    for (const el of [button("Update anyway"), button("Switch anyway"), ...restarts]) {
      assert.equal(el.disabled, false, `${el.textContent} must stay clickable while locked`);
    }
  });

  test("locked: Update drops off the accent and says what pressing it means", async () => {
    lockReply = { active: true, reasons: ["A service is live"] };
    await mount();
    pickOtherTrack();

    const update = button("Update anyway");
    assert.ok(
      !update.className.includes("bg-accent"),
      "the locked update button must not render as the encouraged primary action",
    );
    // Not colour alone: the label changed and the action's own icon gave way to
    // the lock. lucide renders its name into the class list.
    assert.ok(update.innerHTML.includes("lucide-lock"), "expected the lock glyph on the button");
    assert.ok(!update.innerHTML.includes("lucide-download"), "the download glyph should have given way");

    // Every locked label is on screen, and not one unlocked label survives —
    // "Restart now" included, which is the one an earlier version let through.
    for (const c of CONTROLS) {
      assert.ok(screen.getAllByRole("button", { name: c.shut }).length > c.nth, c.shut);
      assert.equal(screen.queryAllByRole("button", { name: c.open }).length, 0, `"${c.open}" should have been replaced`);
    }
  });

  test("unlocked: nothing changes — the normal case is the regression risk", async () => {
    await mount();
    pickOtherTrack();

    const update = button("Update now");
    assert.ok(update.className.includes("bg-accent"), "unlocked, Update now is still the primary action");
    assert.equal(update.disabled, false);
    assert.ok(update.innerHTML.includes("lucide-download"));
    assert.ok(!update.innerHTML.includes("lucide-lock"), "no lock glyph when nothing is locked");

    for (const c of CONTROLS) {
      assert.ok(screen.getAllByRole("button", { name: c.open }).length > 0, c.open);
      assert.equal(screen.queryAllByRole("button", { name: c.shut }).length, 0, `"${c.shut}" should not be shown`);
    }
  });

  test("the lock never becomes the reason a button is disabled", async () => {
    // The whole claim in one shape, and compared by POSITION rather than by
    // label: the guarded controls change their names between the two states, so
    // looking them up by name would have to know the answer in advance. The lock
    // adds and removes no buttons, so the panel's buttons line up one-for-one and
    // every `disabled` in it must read the same either way — not just the four.
    const disabledStates = () =>
      (screen.getAllByRole("button") as HTMLButtonElement[]).map((b) => b.disabled);

    for (const over of [
      {},
      { releasesBehind: 0, behind: 0, behindUserFacing: 0, targetTag: "v9.9.9" },
      { phase: "updating", step: "build" } as Partial<UpdateStatus>,
    ]) {
      lockReply = { active: false, reasons: [] };
      await mount(over);
      pickOtherTrack();
      const open = disabledStates();
      cleanup();

      lockReply = { active: true, reasons: ["A service is live"] };
      await mount(over);
      pickOtherTrack();
      const shut = disabledStates();
      cleanup();

      assert.deepEqual(shut, open, `the lock changed a disabled state (${JSON.stringify(over)})`);
    }
  });

  test("mid-update, the one control nothing else disables is still guarded", async () => {
    // The hole an earlier version of this fix left open. Tying the guarded look
    // to `!updating` was safe for the three controls that `updating` disables —
    // and wrong for the deferred-restart banner, which nothing disables. In
    // `updating` + `restartPending` + locked it rendered clickable, in full
    // accent, with no lock, on a press that opens the destructive override.
    lockReply = { active: true, reasons: ["A service is live"] };
    await mount({ phase: "updating", step: "build" });

    const banner = button("Restart anyway");
    assert.equal(banner.disabled, false, "the banner restart is the one nothing else disables");
    assert.ok(!banner.className.includes("bg-accent"), "and mid-update it must still not read as encouraged");
    assert.ok(banner.innerHTML.includes("lucide-lock"), "expected the lock glyph mid-update");
    assert.equal(screen.queryAllByRole("button", { name: "Restart now" }).length, 0);

    // Its three siblings are disabled by their own rules, so they say what they
    // are doing rather than promising an override they cannot reach.
    assert.equal(button("Updating…").disabled, true);
    assert.equal(button("Restart").disabled, true);
    assert.equal(button("Switch").disabled, true);
  });

  test("locked: pressing it still opens the override dialog, and confirming still updates", async () => {
    lockReply = { active: true, reasons: ["A service is live"] };
    await mount();

    fireEvent.click(button("Update anyway"));
    await settle();

    assert.ok(screen.getByText("Service in progress"), "the override dialog should have opened");
    const override = screen.getByRole("button", { name: "Override & update anyway" });
    fireEvent.click(override);
    await settle();

    assert.deepEqual(applied, [true], "confirming the override must apply with override=true");
  });
});
