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

  /**
   * A picker wired to real state, the way the panel wires it.
   *
   * The league is CONTROLLED by the parent — that is what lets the parent fetch
   * one league instead of eight — so a test that stubbed onLeague with a no-op
   * would render a picker whose sport step never advances, and would pass on a
   * back button that goes nowhere. This re-renders on the change, as the panel
   * does.
   */
  function picker(
    over: { teams?: ScoreFavourite[]; loading?: boolean; error?: string | null } = {},
  ) {
    let league: LeagueId | null = null;
    const ui = render(<span />);
    const draw = () =>
      ui.rerender(
        <TeamPicker
          league={league}
          onLeague={(next) => {
            league = next;
            draw();
          }}
          teams={league === null ? [] : (over.teams ?? TEAMS.filter((t) => t.league === league))}
          loading={over.loading ?? false}
          error={over.error ?? null}
          selected={new Set<string>()}
          onToggle={() => {}}
        />,
      );
    draw();
    return ui;
  }

  const toMlb = (ui: ReturnType<typeof render>) =>
    fireEvent.click(ui.getByRole("button", { name: /MLB/ }));

  test("THE GUARD: it asks for a sport BEFORE it lists any team", async () => {
    // The whole reason for the two steps. One flat list was fine at 124 teams
    // and unusable at ~2,000 once college arrived. Collapse it back to a single
    // list and this fails: the teams would be on screen with no sport chosen.
    const ui = picker();
    open(ui);
    assert.ok(ui.queryByText("Choose a sport"), "the sport step is missing");
    assert.equal(
      ui.queryByText("New York Yankees"),
      null,
      "teams were listed before a sport was chosen",
    );
    assert.equal(ui.queryByLabelText("Search teams"), null, "the search box belongs to step two");
    ui.unmount();
    await settle();
  });

  test("choosing a sport lists THAT sport's teams and no others", async () => {
    const ui = picker();
    open(ui);
    toMlb(ui);
    assert.ok(ui.queryByText("New York Yankees"), "the chosen league's teams are missing");
    assert.equal(
      ui.queryByText("Chicago Bears"),
      null,
      "an NFL team was listed under MLB — the list is not scoped to the league",
    );
    ui.unmount();
    await settle();
  });

  test("THE GUARD: the search narrows the CHOSEN league, not every league", async () => {
    // "Chicago" across all eight leagues is the Cubs, the White Sox, the Bears,
    // the Bulls, the Blackhawks and a fistful of colleges. Scoped to MLB it is
    // the Cubs.
    const ui = picker();
    open(ui);
    toMlb(ui);
    fireEvent.change(ui.getByLabelText("Search teams"), { target: { value: "chicago" } });
    assert.ok(ui.queryByText("Chicago Cubs"));
    assert.equal(ui.queryByText("Chicago Bears"), null, "the search reached outside the league");
    ui.unmount();
    await settle();
  });

  test("there is a way back to the sports", async () => {
    const ui = picker();
    open(ui);
    toMlb(ui);
    assert.equal(ui.queryByText("Choose a sport"), null);
    fireEvent.click(ui.getByLabelText("Back to sports"));
    assert.ok(ui.queryByText("Choose a sport"), "the back control did not return to the sport step");
    assert.equal(ui.queryByText("New York Yankees"), null, "the team list survived going back");
    ui.unmount();
    await settle();
  });

  test("THE GUARD: the query AND the league reset when the popover closes", async () => {
    // Without the reset, re-opening shows a list still filtered by a query the
    // operator cannot see — the field is there but the previous search is still
    // narrowing it. They see one team, believe that is every team, and cannot
    // find the one they came back for. The league resets with it, so re-opening
    // starts where the operator expects rather than deep inside a sport.
    const ui = picker();
    open(ui);
    toMlb(ui);
    fireEvent.change(ui.getByLabelText("Search teams"), { target: { value: "yankees" } });
    assert.equal((ui.getByLabelText("Search teams") as HTMLInputElement).value, "yankees");
    assert.equal(ui.queryByText("Chicago Cubs"), null, "the filter should be in effect");

    // Close, then re-open.
    fireEvent.click(ui.getByRole("button", { name: "Add a team" }));
    open(ui);

    assert.ok(ui.queryByText("Choose a sport"), "re-opening did not return to the sport step");
    toMlb(ui);
    assert.equal((ui.getByLabelText("Search teams") as HTMLInputElement).value, "");
    assert.ok(ui.queryByText("Chicago Cubs"), "every team must be listed again after reopening");
    ui.unmount();
    await settle();
  });

  test("an empty result shows the empty state, not a bare list", async () => {
    const ui = picker();
    open(ui);
    toMlb(ui);
    fireEvent.change(ui.getByLabelText("Search teams"), { target: { value: "zzzz" } });
    assert.ok(ui.queryByText("No teams match"));
    ui.unmount();
    await settle();
  });

  test("a league that failed to load is NAMED, not silently missing", async () => {
    // An empty dropdown and a failed request look identical to the operator.
    const ui = picker({ teams: [], error: "ESPN returned HTTP 503" });
    open(ui);
    toMlb(ui);
    assert.ok(ui.queryByText(/MLB could not be loaded/));
    assert.ok(ui.queryByText(/HTTP 503/));
    ui.unmount();
    await settle();
  });

  test("a league still loading says so rather than reading as empty", async () => {
    const ui = picker({ teams: [], loading: true });
    open(ui);
    toMlb(ui);
    assert.ok(ui.queryByText("Loading teams…"));
    assert.equal(ui.queryByText("No teams available"), null);
    ui.unmount();
    await settle();
  });

  /**
   * Colour comes from the semantic tokens, never straight off the palette ramp.
   *
   * Measured against the app's own grounds — light surface #ffffff, dark surface
   * #151515, dark popover #1c1c1c:
   *
   *   text-gray-9   3.32:1 light, 3.34–3.58:1 dark   — under AA for text
   *   text-fg-muted 5.98:1 light, 6.10–6.54:1 dark   — over it
   *
   * The ring is a themeability problem rather than a contrast one: --su-focus
   * follows the operator's accent, and a Radix `blue-8` ring stays Radix blue on
   * a themed install while every other control changes with it.
   *
   * Asserted as an ABSENCE, which is why a class name is the right thing to read
   * here: the repo's scar is a class that is PRESENT and overridden by a later
   * @layer rule, and no cascade can conjure a class that was never written.
   * integrations-visibility.test.tsx bans text-fg-subtle/text-fg-faint on its
   * page for the same reason — and this file exists because the same contrast
   * walked into a dialog under the palette alias instead.
   */
  const BANNED = [
    // Sub-AA as text, in both themes.
    /\btext-gray-[89]\b/,
    /\btext-fg-subtle\b/,
    /\btext-fg-faint\b/,
    // Not themeable: these keep Radix's blue when the app is not blue.
    /\bring-blue-\d/,
    /\bborder-blue-\d/,
  ];

  test("THE GUARD: no unreadable or unthemeable colour, in either step", async () => {
    const ui = picker();
    open(ui);
    for (const banned of BANNED) {
      assert.doesNotMatch(document.body.innerHTML, banned, `the sport step carries ${banned}`);
    }
    toMlb(ui);
    for (const banned of BANNED) {
      assert.doesNotMatch(document.body.innerHTML, banned, `the team step carries ${banned}`);
    }
    ui.unmount();
    await settle();
  });
});
