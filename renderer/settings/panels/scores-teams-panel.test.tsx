import { strict as assert } from "node:assert";
import { after, beforeEach, describe, test } from "node:test";

// The DOM must exist before the component modules are evaluated - a `before`
// hook runs after the module body, so a static import would render into nothing.
import { installDom } from "../../test-dom.js";

const teardown = installDom();

const { render, cleanup, fireEvent } = await import("@testing-library/react");
const { TeamPicker, filterTeams } = await import("./scores-teams-panel.js");

/**
 * Let the popover's own async cleanup run while the DOM still exists.
 *
 * Radix schedules focus and dismissable-layer work on a later tick. Unmounting
 * and returning immediately leaves that work to fire after the test ended — and
 * after teardown() has taken `window` off globalThis, so it throws
 * "window is not defined" from inside a library, which node:test reports as an
 * unhandledRejection and fails the FILE while every test in it passes.
 */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

after(async () => {
  cleanup();
  await settle();
  teardown();
});

function team(over: Partial<ScoreFavourite> = {}): ScoreFavourite {
  return {
    league: "mlb",
    teamId: "10",
    displayName: "New York Yankees",
    abbreviation: "NYY",
    logo: null,
    color: "#132448",
    ...over,
  };
}

const TEAMS: ScoreFavourite[] = [
  team(),
  team({ teamId: "2", displayName: "Boston Red Sox", abbreviation: "BOS" }),
  team({ teamId: "16", displayName: "Chicago Cubs", abbreviation: "CHC" }),
  team({ league: "nfl", teamId: "3", displayName: "Chicago Bears", abbreviation: "CHI" }),
];

describe("filterTeams", () => {
  test("matches the full display name", () => {
    assert.deepEqual(
      filterTeams(TEAMS, "yankees").map((t) => t.abbreviation),
      ["NYY"],
    );
  });

  test("matches the ABBREVIATION too", () => {
    // An operator who thinks of the team as "CHC" should not have to know it is
    // filed under "Chicago Cubs".
    assert.deepEqual(
      filterTeams(TEAMS, "chc").map((t) => t.displayName),
      ["Chicago Cubs"],
    );
  });

  test("is case-insensitive and matches mid-string", () => {
    assert.deepEqual(
      filterTeams(TEAMS, "CHICAGO").map((t) => t.abbreviation),
      ["CHC", "CHI"],
    );
  });

  test("an empty query is every team, not none", () => {
    assert.equal(filterTeams(TEAMS, "   ").length, TEAMS.length);
  });

  test("a query nothing matches yields nothing, so the empty state can show", () => {
    assert.deepEqual(filterTeams(TEAMS, "zzzz"), []);
  });
});

describe("TeamPicker", () => {
  // Each render must start from an empty document: two mounted pickers means two
  // "Add a team" buttons, and the query then fails on ambiguity rather than on
  // anything this file is testing.
  beforeEach(() => {
    cleanup();
  });

  function open(ui: ReturnType<typeof render>): void {
    fireEvent.click(ui.getByRole("button", { name: "Add a team" }));
  }

  function picker() {
    return render(
      <TeamPicker
        catalogue={{ teams: TEAMS, errors: [] }}
        loading={false}
        selected={new Set<string>()}
        onToggle={() => {}}
        onOpen={() => {}}
      />,
    );
  }

  test("THE GUARD: the query resets when the popover closes", async () => {
    // Without the reset, re-opening shows a list still filtered by a query the
    // operator cannot see — the field is there but the previous search is still
    // narrowing it. They see four teams, believe that is every team, and cannot
    // find the one they came back for.
    const ui = picker();
    open(ui);
    const search = ui.getByLabelText("Search teams") as HTMLInputElement;
    fireEvent.change(search, { target: { value: "yankees" } });
    assert.equal((ui.getByLabelText("Search teams") as HTMLInputElement).value, "yankees");
    assert.equal(ui.queryByText("Chicago Cubs"), null, "the filter should be in effect");

    // Close, then re-open.
    fireEvent.click(ui.getByRole("button", { name: "Add a team" }));
    open(ui);

    assert.equal((ui.getByLabelText("Search teams") as HTMLInputElement).value, "");
    assert.ok(ui.queryByText("Chicago Cubs"), "every team must be listed again after reopening");
    ui.unmount();
    await settle();
  });

  test("an empty result shows the empty state, not a bare list", async () => {
    const ui = picker();
    open(ui);
    fireEvent.change(ui.getByLabelText("Search teams"), { target: { value: "zzzz" } });
    assert.ok(ui.queryByText("No teams match"));
    ui.unmount();
    await settle();
  });

  test("a league that failed to load is NAMED, not silently missing", async () => {
    // An empty dropdown and a failed request look identical to the operator.
    const ui = render(
      <TeamPicker
        catalogue={{ teams: TEAMS, errors: ["NHL could not be loaded — ESPN returned HTTP 503"] }}
        loading={false}
        selected={new Set<string>()}
        onToggle={() => {}}
        onOpen={() => {}}
      />,
    );
    open(ui);
    assert.ok(ui.queryByText(/NHL could not be loaded/));
    ui.unmount();
    await settle();
  });
});
