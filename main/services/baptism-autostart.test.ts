import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { autoStartAction } from "./baptism-autostart.js";

const on = { enabled: true, testimonyKeyword: "baptism stories" };
const input = (over: Partial<Parameters<typeof autoStartAction>[0]> = {}) =>
  autoStartAction({ itemId: "i1", itemTitle: "BAPTISM STORIES", phase: "idle", triggers: null, auto: on, ...over });

describe("autoStartAction", () => {
  test("the item named for the testimonies starts them", () => {
    assert.equal(input(), "start-testimonies");
  });

  test("matching ignores case, since PCO titles are shouted", () => {
    assert.equal(input({ itemTitle: "Baptism Stories" }), "start-testimonies");
  });

  test("the bound item wins even when its name says nothing", () => {
    // The baptisms happen during a song, which no keyword could ever find.
    assert.equal(
      input({ itemId: "song1", itemTitle: "Bless God (Live)", phase: "testimony", triggers: { baptismItemId: "song1" } }),
      "start-baptisms",
    );
  });

  test("a bound testimony item works without any keyword", () => {
    assert.equal(
      input({ itemId: "x9", itemTitle: "Something else", triggers: { testimonyItemId: "x9" }, auto: null }),
      "start-testimonies",
    );
  });

  test("an ordinary item does nothing", () => {
    assert.equal(input({ itemTitle: "MESSAGE" }), null);
    assert.equal(input({ itemTitle: "CORPORATE PRAYER" }), null);
  });

  test("it never interrupts a session already running", () => {
    // The testimony item going live again — a PCO re-sync, or the operator stepping
    // back — must not restart and lose what has been timed.
    assert.equal(input({ phase: "testimony" }), null);
    assert.equal(input({ phase: "baptism" }), null);
  });

  test("baptisms only start from testimonies, never from idle", () => {
    // Otherwise a song going live on an ordinary Sunday would open a session.
    assert.equal(input({ itemId: "song1", itemTitle: "Bless God", phase: "idle", triggers: { baptismItemId: "song1" } }), null);
  });

  test("switched off, the keyword does nothing", () => {
    assert.equal(input({ auto: { enabled: false, testimonyKeyword: "baptism stories" } }), null);
    assert.equal(input({ auto: null }), null);
  });

  test("an empty keyword does not match every item", () => {
    assert.equal(input({ itemTitle: "MESSAGE", auto: { enabled: true, testimonyKeyword: "   " } }), null);
  });

  test("the bound baptism item is checked before the testimony keyword", () => {
    // An item that is both bound to the baptisms and named like the testimonies
    // should move the session on rather than trying to restart it.
    assert.equal(
      input({ itemId: "b1", itemTitle: "BAPTISM STORIES", phase: "testimony", triggers: { baptismItemId: "b1" } }),
      "start-baptisms",
    );
  });

  test("a missing title or id is not a match", () => {
    assert.equal(input({ itemTitle: null }), null);
    assert.equal(input({ itemId: null, itemTitle: "MESSAGE", triggers: { testimonyItemId: "i1" } }), null);
  });
});
