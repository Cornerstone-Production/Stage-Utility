// Every home card is a Home card, everywhere it is drawn.
//
// Home's page renders through LayoutRenderer, and LayoutRenderer used to match
// `home-streaming`, `home-streaming-resi` and `home-streaming-youtube` in the
// same case as `stream-status` — the WALL widget. So the two streaming tiles on
// Home came out two lines and ALL CAPS, in a grey the neighbouring cards did not
// wear, in a row of three-line cards that were none of those things.
//
// The routing now asks isHomeCard first, and `Record<HomeCardType, true>` makes
// the set exhaustive at compile time. This is the runtime half: the registry is
// the list of everything that exists, and every home- type in it must be claimed
// by the card renderer rather than by whatever case happens to name it.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { LAYOUT_OBJECTS } from "../../main/layout-objects.js";
import { isHomeCard } from "./cards.js";

const HOME_TYPES = Object.keys(LAYOUT_OBJECTS).filter((t) => t.startsWith("home-"));

describe("routing a home card", () => {
  test("the registry has home cards to route", () => {
    // A guard over an empty list is green for the wrong reason.
    assert.equal(HOME_TYPES.length, 14, "the home card set changed — update this count on purpose");
  });

  test("every home- type in the registry is claimed by the card renderer", () => {
    const orphans = HOME_TYPES.filter(
      (type) => !isHomeCard(LAYOUT_OBJECTS[type as keyof typeof LAYOUT_OBJECTS].config() as never),
    );
    assert.deepEqual(
      orphans,
      [],
      "these fall through to LayoutRenderer's switch and are drawn as something else",
    );
  });

  test("the streaming trio in particular", () => {
    // Named, because these are the three that were drawn as wall widgets.
    for (const type of ["home-streaming", "home-streaming-resi", "home-streaming-youtube"]) {
      assert.ok(
        isHomeCard({ type } as never),
        `${type} must render as a Home card, not as stream-status`,
      );
    }
  });
});
