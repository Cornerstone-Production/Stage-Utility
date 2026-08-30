// A pinned game on a HOME card actually changes what the card draws.
//
// pickGame is unit-tested next door, and that is not the failure this file is
// for. The failure is the one this repo has already had once: Home's card menu
// wrote a setting into the object and the card that drew it never looked, so
// every switch in that menu was a control that did nothing. `HomeCard` was
// handed a bare `type` then; it takes the whole config now, and this is the
// assertion that says so for `game` rather than a promise that it does.
//
// So it renders the REAL path — ObjectContent, the home-card branch, HomeCard,
// ScoresCard — with the status the server would have pushed, and asserts on the
// team the card leads with.

import { strict as assert } from "node:assert";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

class StubEventSource {
  readyState = 0;
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
}
(globalThis as unknown as { EventSource: unknown }).EventSource = StubEventSource;

const TEAM = (id: string, score: number | null): ScoreTeamDTO => ({
  id,
  abbreviation: `T${id}`,
  name: `Team ${id}`,
  displayName: `Team ${id}`,
  color: null,
  logo: null,
  record: null,
  score,
});

const fixture = (eventId: string, awayId: string): ScoreGameDTO => ({
  league: "mlb",
  sport: "baseball",
  state: "in",
  delayed: false,
  detail: "Top 3rd",
  shortDetail: "Top 3rd",
  clock: "",
  startsAt: "2026-08-14T18:05:00.000Z",
  venue: null,
  away: TEAM(awayId, 1),
  home: TEAM("2", 0),
  situation: null,
  eventId,
});

/**
 * Two live games, and the one the operator did NOT pin is the one that scored
 * last.
 *
 * That is what makes this a test of the pin: `auto` prefers the game that just
 * scored, so a card ignoring `game` leads with "other" and a card reading it
 * leads with "mine". Without the event, both answers are "mine" and the test
 * would pass on a build that dropped the setting entirely.
 */
const STATUS: ScoresStatusDTO = {
  connected: true,
  games: [fixture("mine", "7"), fixture("other", "3")],
  scoreRev: 1,
  lastEvents: [{ eventId: "other", teamId: "3", from: 0, to: 1 }],
  fetchedAt: null,
  error: null,
};

(globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown) => {
  const url = String(input);
  const body = url.includes("/api/scores/status") ? STATUS : {};
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
};

const { render, cleanup, act } = await import("@testing-library/react");
const React = (await import("react")).default;
const { ObjectContent } = await import("./layout-renderer.js");
const { makeRenderCtx } = await import("./test-render-ctx.js");

const settle = () => new Promise((r) => setTimeout(r, 0));
before(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
after(async () => { await settle(); teardown(); });
beforeEach(() => cleanup());
afterEach(async () => { cleanup(); await settle(); });

/** The card, with the status hydrated — `useScoresState` fetches on mount. */
async function leadTeam(config: Record<string, unknown>): Promise<string | null> {
  let container!: HTMLElement;
  await act(async () => {
    ({ container } = render(
      React.createElement(ObjectContent, {
        o: { id: "c1", x: 0, y: 0, w: 4, h: 4, z: 1, config, style: {} },
        ctx: makeRenderCtx({ home: true, interactive: true }),
      } as never),
    ));
    await settle();
  });
  return container.querySelector(".home-scores-name")?.textContent ?? null;
}

describe("a game pinned on a Home card reaches the card", () => {
  test("unpinned, the card leads with whatever scored last", async () => {
    // The control. If this were "Team 7" the assertion below would prove
    // nothing, because both answers would be the same.
    assert.equal(await leadTeam({ type: "home-scores" }), "Team 3");
  });

  test("THE GUARD: pinned, the card leads with the pinned team", async () => {
    // Hand HomeCard a bare `type` again — or drop the prop on the ScoresCard
    // call — and this reads "Team 3": the setting the menu writes goes nowhere
    // and the operator's pin is a control that does nothing.
    assert.equal(await leadTeam({ type: "home-scores", game: "mlb:7" }), "Team 7");
  });
});
