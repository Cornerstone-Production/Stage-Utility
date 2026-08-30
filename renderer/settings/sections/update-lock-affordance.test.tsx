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
//     accent #2e6691 / white text unlocked, versus the neutral fill locked.
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
 * The guarded buttons, by the label each shows in the state under test.
 *
 * Named rather than found by a class so a rename cannot silently drop one from
 * the sweep — the whole point of doing all four together.
 */
const LOCKED_LABELS = ["Update anyway", "Restart anyway", "Switch anyway"];
const UNLOCKED_LABELS = ["Update now", "Restart", "Switch", "Restart now"];

function button(name: string): HTMLButtonElement {
  const hits = screen.getAllByRole("button", { name });
  return hits[0] as HTMLButtonElement;
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

    // "Restart anyway" appears twice — the row button and the restart-pending
    // banner — and both must stay live.
    const restarts = screen.getAllByRole("button", { name: "Restart anyway" }) as HTMLButtonElement[];
    assert.equal(restarts.length, 2, "both restart controls should be guarded");

    for (const el of [button("Update anyway"), ...restarts]) {
      assert.equal(el.disabled, false, `${el.textContent} must stay clickable while locked`);
    }
    // Switch is disabled by its own rule (no other track picked), not by the lock.
    assert.equal(button("Switch anyway").disabled, true);
  });

  test("locked: Update drops off the accent and says what pressing it means", async () => {
    lockReply = { active: true, reasons: ["A service is live"] };
    await mount();

    const update = button("Update anyway");
    assert.ok(
      !update.className.includes("bg-accent"),
      "the locked update button must not render as the encouraged primary action",
    );
    // Not colour alone: the label changed and the action's own icon gave way to
    // the lock. lucide renders its name into the class list.
    assert.ok(update.innerHTML.includes("lucide-lock"), "expected the lock glyph on the button");
    assert.ok(!update.innerHTML.includes("lucide-download"), "the download glyph should have given way");

    // Every locked label is on screen, and none of the unlocked ones survives.
    for (const name of LOCKED_LABELS) assert.ok(screen.getAllByRole("button", { name }).length > 0, name);
    for (const name of ["Update now", "Restart", "Switch"]) {
      assert.equal(screen.queryAllByRole("button", { name }).length, 0, `"${name}" should have been replaced`);
    }
  });

  test("unlocked: nothing changes — the normal case is the regression risk", async () => {
    await mount();

    const update = button("Update now");
    assert.ok(update.className.includes("bg-accent"), "unlocked, Update now is still the primary action");
    assert.equal(update.disabled, false);
    assert.ok(update.innerHTML.includes("lucide-download"));
    assert.ok(!update.innerHTML.includes("lucide-lock"), "no lock glyph when nothing is locked");

    for (const name of UNLOCKED_LABELS) assert.ok(screen.getAllByRole("button", { name }).length > 0, name);
    for (const name of LOCKED_LABELS) {
      assert.equal(screen.queryAllByRole("button", { name }).length, 0, `"${name}" should not be shown`);
    }
  });

  test("the lock never becomes the reason a button is disabled", async () => {
    // The whole claim in one shape: every guarded control's `disabled` reads the
    // same locked as unlocked, both with a release waiting and with nothing to
    // install. Whatever disables one of these, it is never the lock.
    for (const over of [{}, { releasesBehind: 0, behind: 0, behindUserFacing: 0, targetTag: "v9.9.9" }]) {
      lockReply = { active: false, reasons: [] };
      await mount(over);
      pickOtherTrack();
      const open = UNLOCKED_LABELS.map((n) => button(n).disabled);
      cleanup();

      lockReply = { active: true, reasons: ["A service is live"] };
      await mount(over);
      pickOtherTrack();
      // The same four controls in the same order. "Restart anyway" twice — the
      // row button and the banner — exactly as "Restart" and "Restart now" were.
      const shut = ["Update anyway", "Restart anyway", "Switch anyway", "Restart anyway"].map((n, i) => {
        const hits = screen.getAllByRole("button", { name: n }) as HTMLButtonElement[];
        return (i === 3 ? hits[1] : hits[0]).disabled;
      });
      cleanup();

      assert.deepEqual(shut, open, `the lock changed a disabled state (${JSON.stringify(over)})`);
    }

    // Mid-update, WITH the lock still active (lockReply is deliberately left set
    // from the block above — that is what makes this assertion mean anything):
    // everything is disabled and the guarded look stands down, because the update
    // IS the thing happening, so "anyway" would be a lie.
    await mount({ phase: "updating", step: "build" });
    assert.equal(button("Updating…").disabled, true);
    assert.equal(button("Restart").disabled, true);
    assert.equal(screen.queryAllByRole("button", { name: "Update anyway" }).length, 0);
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
