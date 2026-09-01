// The integration-card lookup waits for the card.
//
// The failure this exists for took a release build down. `idle()` answers a
// question about react-query — every query settled, none in flight — and the test
// files then read the DOM for a card immediately. React commits the render that
// draws the cards AFTER the queries settle, so the two are not the same moment.
// On an unloaded machine the gap is invisible; on a loaded CI runner one of the
// sixteen dialog tests lost the race and reported
//
//   Unable to fire a "click" event - please provide a DOM element
//
// which is what `querySelector(...)!` becomes when the element is not there yet.
// Five test files reached for a card that way.
//
// So this is about the helper they all use now, not about any one of them: it has
// to return a card that arrives LATE, and it has to say something useful when the
// card never arrives at all.

import { strict as assert } from "node:assert";
import { after, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();
const { integrationCard } = await import("../test-fixtures/integrations-harness.js");

after(() => teardown());

/** A container with a card added after `delayMs`, the way React commits one. */
function lateCard(delayMs: number, id: string): HTMLElement {
  const box = document.createElement("div");
  setTimeout(() => {
    const el = document.createElement("div");
    el.setAttribute("data-integration-card", id);
    box.appendChild(el);
  }, delayMs);
  return box;
}

describe("waiting for an integration card", () => {
  test("returns a card that renders after the lookup starts", async () => {
    // 80ms is well past the zero-wait the old code effectively had, and well
    // inside the cap. Without the wait this rejects immediately.
    const box = lateCard(80, "obs");
    const el = await integrationCard(box, "obs", 2000);
    assert.equal(el.getAttribute("data-integration-card"), "obs");
  });

  test("returns immediately when the card is already there", async () => {
    const box = document.createElement("div");
    const el = document.createElement("div");
    el.setAttribute("data-integration-card", "reaper");
    box.appendChild(el);
    const started = Date.now();
    assert.equal(await integrationCard(box, "reaper", 2000), el);
    assert.ok(Date.now() - started < 100, "an already-rendered card must not be waited for");
  });

  test("a card that never arrives names the ones that did", async () => {
    // The old message was about fireEvent's argument, which said nothing about
    // integrations at all. This one has to be readable at 9am on a Sunday.
    const box = document.createElement("div");
    for (const id of ["obs", "reaper"]) {
      const el = document.createElement("div");
      el.setAttribute("data-integration-card", id);
      box.appendChild(el);
    }
    await assert.rejects(
      () => integrationCard(box, "resi", 120),
      (err: Error) => {
        assert.match(err.message, /no card for "resi"/);
        assert.match(err.message, /obs, reaper/, "it must say what the page did draw");
        return true;
      },
    );
  });

  test("an empty page says the page is empty, not that one card is missing", async () => {
    await assert.rejects(
      () => integrationCard(document.createElement("div"), "obs", 120),
      /no integration cards rendered at all/,
    );
  });
});
