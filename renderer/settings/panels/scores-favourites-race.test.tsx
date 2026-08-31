// Ticking three teams in a row must leave all three followed.
//
// The picker is multi-select and its rows stay clickable, so a burst of ticks is
// the INTENDED flow. Each tick saved the WHOLE list, built from a snapshot taken
// when that row was drawn, and a browser orders nothing between the several
// connections it opens per origin: the second write could reach the store before
// the first, and scoresStore.setFavourites replaces outright. One of the three
// teams was gone from scores-favourites.json with no error anywhere, and the
// panel — which painted whichever RESPONSE resolved last — went on showing it.
//
// Driven end to end and deliberately so. The REAL panel, the real api.ts client
// and the real store, with only `fetch` standing in for the wire so the arrival
// order can be forced. A test that toggled one team at a time, or that called
// the store directly, cannot fail on this — which is how it shipped.
//
// Every team, id and league name below is INVENTED. This is a public repository.

import assert from "node:assert/strict";
import { after, beforeEach, describe, test } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// Both before the store is imported: it resolves its data directory on load, and
// a default would write into the operator's own ~/.stage-utility.
const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-scores-race-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

// The DOM must exist before the component modules are evaluated — a `before`
// hook runs after the module body, so a static import would render into nothing.
import { installRenderDom } from "../../test-dom.js";

const teardown = installRenderDom();

const { scoresStore } = await import("@main/services/scores-store.js");
const { render, cleanup, fireEvent, act } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { ScoresTeamsPanel } = await import("./scores-teams-panel.js");

after(async () => {
  cleanup();
  await new Promise((r) => setTimeout(r, 20));
  teardown();
  await fs.rm(TMP, { recursive: true, force: true });
});

const TEAMS: ScoreFavourite[] = [
  {
    league: "mlb",
    teamId: "901",
    displayName: "Harbour City Anchors",
    abbreviation: "HCA",
    logo: null,
    color: "#204060",
  },
  {
    league: "mlb",
    teamId: "902",
    displayName: "Prairie Line Threshers",
    abbreviation: "PLT",
    logo: null,
    color: "#603020",
  },
  {
    league: "mlb",
    teamId: "903",
    displayName: "Summit Pass Wardens",
    abbreviation: "SPW",
    logo: null,
    color: "#2a5540",
  },
];

/**
 * The wire, with the reordering a browser gives for free.
 *
 * The FIRST save is the slow one and every later save is instant, so a panel
 * that fires its writes without waiting has its second and third reach the store
 * ahead of its first — and the first, carrying the shortest list, lands last and
 * wins. A panel that serializes never has two in flight, so the delay changes
 * nothing but the wall clock.
 */
let posts = 0;
const reply = (body: unknown) => ({
  ok: true,
  status: 200,
  json: async () => body,
  text: async () => JSON.stringify(body),
});
(globalThis as unknown as { fetch: unknown }).fetch = async (
  input: unknown,
  init?: { method?: string; body?: string },
) => {
  const url = String(input);
  if (url.startsWith("/api/scores/teams")) return reply(TEAMS);
  if (url.startsWith("/api/scores/favourites")) {
    if (init?.method !== "POST") return reply(scoresStore.get());
    const body = JSON.parse(String(init.body)) as { favourites: ScoreFavourite[] };
    const slow = ++posts === 1;
    await new Promise((r) => setTimeout(r, slow ? 40 : 0));
    return reply(await scoresStore.setFavourites(body.favourites));
  }
  throw new Error(`unexpected request ${url}`);
};

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, gcTime: Infinity } },
});

/** Let the writes, the store and the re-renders all settle. */
const settle = async (ms = 200): Promise<void> => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
};

describe("following several teams in one burst", () => {
  // Each test starts from an empty document: a panel left mounted by a failing
  // test makes the next one fail on an ambiguous query rather than on anything
  // it is testing.
  beforeEach(() => {
    cleanup();
  });

  test("THE GUARD: every team ticked survives, and the panel matches the store", async () => {
    await scoresStore.init();
    await scoresStore.setFavourites([]);
    posts = 0;

    const ui = render(
      <QueryClientProvider client={queryClient}>
        <ScoresTeamsPanel />
      </QueryClientProvider>,
    );
    await settle(20);

    fireEvent.click(ui.getByRole("button", { name: "Add a team" }));
    fireEvent.click(ui.getByRole("button", { name: /MLB/ }));
    await settle(20);

    // Three ticks with nothing awaited between them: the operator clicking down
    // a list, which is what the picker is for.
    for (const t of TEAMS) {
      fireEvent.click(ui.getByRole("option", { name: new RegExp(t.displayName) }));
    }
    await settle();

    const stored = scoresStore.get().favourites;
    assert.deepEqual(
      [...stored].map((f) => f.teamId).sort(),
      ["901", "902", "903"],
      `three teams were ticked and scores-favourites.json holds ${stored.length}: ` +
        `[${stored.map((f) => f.displayName).join(", ")}]`,
    );

    // The list the panel draws, read off the rendered rows. An EXACT count: a
    // panel showing four rows for three teams is as wrong as one showing two.
    const rows = ui
      .getAllByRole("button", { name: /^Stop following / })
      .map((b) => b.getAttribute("aria-label")?.replace("Stop following ", ""));
    assert.deepEqual(
      [...rows].sort(),
      [...stored].map((f) => f.displayName).sort(),
      `the panel shows [${rows.join(", ")}] over a store holding ` +
        `[${stored.map((f) => f.displayName).join(", ")}]`,
    );

    ui.unmount();
    await settle(20);
  });

  test("un-ticking mid-burst is honoured, not lost to an earlier write", async () => {
    await scoresStore.setFavourites([]);
    queryClient.setQueryData(["scores:getFavourites"], { favourites: [] });
    posts = 0;

    const ui = render(
      <QueryClientProvider client={queryClient}>
        <ScoresTeamsPanel />
      </QueryClientProvider>,
    );
    await settle(20);

    fireEvent.click(ui.getByRole("button", { name: "Add a team" }));
    fireEvent.click(ui.getByRole("button", { name: /MLB/ }));
    await settle(20);

    // Tick all three, then immediately un-tick the middle one. Whether that row
    // is an add or a remove has to be decided from the list as it stands, not
    // from a render one click behind.
    for (const t of TEAMS) {
      fireEvent.click(ui.getByRole("option", { name: new RegExp(t.displayName) }));
    }
    fireEvent.click(ui.getByRole("option", { name: new RegExp(TEAMS[1].displayName) }));
    await settle();

    const stored = scoresStore.get().favourites;
    assert.deepEqual(
      [...stored].map((f) => f.teamId).sort(),
      ["901", "903"],
      `the un-tick was lost: the store holds [${stored.map((f) => f.displayName).join(", ")}]`,
    );

    ui.unmount();
    await settle(20);
  });
});
