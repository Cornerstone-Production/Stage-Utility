// The Default | <this plan> pill, rendered.
//
// What is under test is the pill's own behaviour: which side reads as pressed,
// whether the "edited" badge is there, whether the plan side can be pressed with
// no plan, and the two actions being offered only when there is something for
// them to act on. Those are the parts an operator can misread into saving a
// weekly swap onto a service type's standing board.
//
// The labelling helpers are tested as functions, because a wrong date on this
// pill points a save at the wrong week and the formatting is where that would
// come from.
//
// NOT unit-tested here, and verified in a browser against the real server
// instead: that `data-slots-target` on the grid root follows the pill, and that
// the grid below re-seeds from the other board when the side changes. Both need
// the whole settings hook — a live SSE state, four query hooks and the server's
// slot-targets read — and jsdom loads no stylesheet, so the pill's amber badge
// and the pressed segment's fill are not observable here at all.
//
// NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND, and every absence is
// asserted as `!node` rather than `node === null`. node:assert builds its failure
// message by inspecting `actual`, and inspecting a live jsdom element does not
// terminate in any useful time: with an inverted `hasOverride` on the badge, this
// file ran for 81.5 s and was then killed, reporting `'test failed'` with no
// assertion text, no test names and no line number. A guard that cannot say what
// broke is most of the way to not being a guard.

import assert from "node:assert/strict";
import { describe, test, after, afterEach } from "node:test";
import { installDom } from "../../test-dom.js";

const teardown = installDom();

const { render, screen, cleanup } = await import("@testing-library/react");

// Unmount whatever a test rendered even when its assertion threw before the
// `unmount()` at the end of it. Without this the next test's getByRole finds the
// leaked tree as well and fails for a reason that has nothing to do with it.
afterEach(cleanup);
after(() => {
  cleanup();
  teardown();
});
const { SlotsTargetPill, planLabel, savedMessage, namedType } = await import("./slots-target-pill.js");

function pill(props: Partial<Parameters<typeof SlotsTargetPill>[0]> = {}) {
  return render(
    <SlotsTargetPill
      side="plan"
      label="Wed Sep 13"
      hasPlan
      hasOverride={false}
      onSwitch={() => {}}
      onRevert={() => {}}
      onPromote={() => {}}
      {...props}
    />,
  );
}

describe("the pill's two sides", () => {
  test("the selected side reads as pressed and the other does not", () => {
    const { unmount } = pill({ side: "default" });
    assert.equal(screen.getByRole("button", { name: "Default" }).getAttribute("aria-pressed"), "true");
    assert.equal(screen.getByRole("button", { name: /Wed Sep 13/ }).getAttribute("aria-pressed"), "false");
    unmount();
  });

  test("pressing a side reports it", () => {
    const asked: string[] = [];
    const { unmount } = pill({ side: "plan", onSwitch: (s) => asked.push(s) });
    screen.getByRole("button", { name: "Default" }).click();
    assert.deepEqual(asked, ["default"]);
    unmount();
  });

  test("the plan side is disabled with no plan selected", () => {
    const { unmount } = pill({ hasPlan: false, side: "default", label: "This plan" });
    const planSide = screen.getByRole("button", { name: /This plan/ });
    assert.equal(
      (planSide as HTMLButtonElement).disabled,
      true,
      "there is nothing to make an exception for, and a pressable side would save to a target that does not exist",
    );
    unmount();
  });
});

describe("the edited badge", () => {
  test("is absent when the plan has no board of its own", () => {
    const { container, unmount } = pill({ hasOverride: false });
    // `!badge`, not `badge === null` — see the note at the top of the file.
    assert.ok(
      !container.querySelector("[data-slots-edited]"),
      "a plan with no board of its own must not read as an exception",
    );
    unmount();
  });

  test("is present when it does", () => {
    const { container, unmount } = pill({ hasOverride: true });
    const badge = container.querySelector("[data-slots-edited]");
    assert.ok(badge, "an operator has to be able to see that this week is already an exception");
    assert.equal(badge?.textContent, "edited");
    unmount();
  });
});

describe("revert and set-as-default", () => {
  test("are not offered when there is no override to act on", () => {
    const { unmount } = pill({ hasOverride: false });
    assert.ok(!screen.queryByRole("button", { name: "Revert to default" }));
    assert.ok(
      !screen.queryByRole("button", { name: "Set as default" }),
      "a Revert to default with nothing to revert is a button that does nothing",
    );
    unmount();
  });

  test("are offered, and report, when there is", () => {
    let reverted = 0;
    let promoted = 0;
    const { unmount } = pill({
      hasOverride: true,
      onRevert: () => reverted++,
      onPromote: () => promoted++,
    });
    screen.getByRole("button", { name: "Revert to default" }).click();
    screen.getByRole("button", { name: "Set as default" }).click();
    assert.equal(reverted, 1);
    assert.equal(promoted, 1);
    unmount();
  });
});

describe("labelling", () => {
  test("a plan's sort date becomes a short weekday date", () => {
    // A fixed zone, so the assertion does not depend on where the box is.
    assert.equal(planLabel("2026-09-13T14:00:00Z", "September 13, 2026", "UTC"), "Sun, Sep 13");
  });

  test("falls back to Planning Center's own words with no sort date", () => {
    assert.equal(
      planLabel(null, "September 13-14, 2026", "UTC"),
      "September 13-14, 2026",
      "parsing what somebody typed into a weekday would be guessing, and a wrong date here points a save at the wrong week",
    );
  });

  test("falls back again with neither", () => {
    assert.equal(planLabel(null, null, null), "This plan");
  });

  test("an unparseable sort date does not become Invalid Date", () => {
    assert.equal(planLabel("not-a-date", "September 13, 2026", "UTC"), "September 13, 2026");
  });

  test("the save message names which board it landed on", () => {
    assert.equal(
      savedMessage("plan", "Wed Sep 13", "Cornerstone Youth"),
      "Saved slots for Wed Sep 13 · Cornerstone Youth",
    );
    assert.equal(savedMessage("default", "Wed Sep 13", "Cornerstone Youth"), "Saved the Cornerstone Youth default");
  });

  test("and still says something without a service type name", () => {
    assert.equal(savedMessage("plan", "Wed Sep 13", null), "Saved slots for Wed Sep 13");
    assert.equal(savedMessage("default", "Wed Sep 13", null), "Saved the default");
  });

  // A service type's name is whatever somebody typed into Planning Center, and
  // "The Salt Company" is a real one — five strings that named a default board
  // read "the The Salt Company default".
  test("a type name that already opens with an article does not get a second one", () => {
    assert.equal(namedType("The Salt Company"), "The Salt Company");
    assert.equal(namedType("Weekend"), "the Weekend");
    assert.equal(namedType(null), "the service type");
    assert.equal(
      savedMessage("default", "Wed Sep 13", "The Salt Company"),
      "Saved The Salt Company default",
    );
  });

  test("and it capitalises for a sentence that opens with it", () => {
    assert.equal(namedType("Weekend", true), "The Weekend");
    assert.equal(namedType("the midweek", true), "The midweek");
    assert.equal(namedType(null, true), "The service type");
  });
});
