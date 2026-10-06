// An in-app link to an old /scriptview address lands on the new page.
//
// The server answers a direct load with a 301 (legacy-page-routes.test.ts), but a
// click inside the running app, or a pushState, never reaches the server — the
// router has to give the same answer. This drives the REAL router (router.tsx's
// own route tree) with a real history push and reads where it ended up, rather
// than reading redirects.tsx for a string a comment could satisfy.

import { strict as assert } from "node:assert";
import { after, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

const { router } = await import("./router.js");

after(() => teardown());

/** Push an address the way a link or a pasted URL would, and wait for the router to settle. */
async function visit(href: string): Promise<{ pathname: string; search: string; hash: string }> {
  router.history.push(href);
  await router.load();
  const { pathname, searchStr, hash } = router.state.location;
  return { pathname, search: searchStr, hash };
}

describe("the router answers an old /scriptview address", () => {
  test("a rundown keeps its path and its query", async () => {
    const at = await visit("/scriptview/weekend/audio?text=150&plan=1&transport=poll");
    assert.equal(at.pathname, "/servicecue/weekend/audio");
    const q = new URLSearchParams(at.search);
    assert.equal(q.get("text"), "150");
    assert.equal(q.get("plan"), "1");
    assert.equal(q.get("transport"), "poll");
  });

  test("a real-sized plan id comes through as its digits", async () => {
    const at = await visit("/scriptview/weekend/audio?plan=481516234");
    assert.equal(new URLSearchParams(at.search).get("plan"), "481516234");
  });

  test("the launcher, the manager and the presets editor each land on their twin", async () => {
    assert.equal((await visit("/scriptview")).pathname, "/servicecue");
    assert.equal((await visit("/scriptview/manage")).pathname, "/servicecue/manage");
    assert.equal((await visit("/scriptview/presets")).pathname, "/servicecue/presets");
  });

  test("the new address is not touched", async () => {
    const at = await visit("/servicecue/weekend/audio?text=120");
    assert.equal(at.pathname, "/servicecue/weekend/audio");
    assert.equal(new URLSearchParams(at.search).get("text"), "120");
  });
});
