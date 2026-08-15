import { strict as assert } from "node:assert";
import { after, describe, test } from "node:test";

import { installDom } from "../../test-dom.js";

const teardown = installDom();

const { commissionTargets } = await import("./commission.js");

after(() => teardown());

describe("commissioning targets", () => {
  test("offers every configured output", () => {
    // The display picker's whole job. Missing one means a monitor that cannot
    // be told what it is.
    const state = {
      outputs: [
        { id: "d1", name: "Mic board" },
        { id: "d2", name: "Lobby" },
      ],
    } as unknown as StageState;
    assert.deepEqual(commissionTargets(state).map((t) => t.id), ["d1", "d2"]);
  });

  test("keeps the tint an operator chose", () => {
    // iconColors are set from Screens and keyed by display id. Dropping them
    // silently discards a colour someone picked - it still works, so nothing
    // reports it.
    const state = {
      outputs: [{ id: "d1", name: "Mic board" }],
      iconColors: { d1: "#e0653a" },
    } as unknown as StageState;
    assert.equal(commissionTargets(state)[0].color, "#e0653a");
  });

  test("falls back to the theme accent when untinted", () => {
    const state = { outputs: [{ id: "d1", name: "Mic board" }] } as unknown as StageState;
    assert.equal(commissionTargets(state)[0].color, "var(--su-accent)");
  });

  test("treats an empty tint as untinted rather than as a colour", () => {
    // Clearing a colour writes "" rather than deleting the key. Passing that
    // through as a CSS colour paints the icon with nothing at all.
    const state = {
      outputs: [{ id: "d1", name: "Mic board" }],
      iconColors: { d1: "" },
    } as unknown as StageState;
    assert.equal(commissionTargets(state)[0].color, "var(--su-accent)");
  });

  test("no outputs is an empty list, not a throw", () => {
    assert.deepEqual(commissionTargets({} as StageState), []);
  });
});
