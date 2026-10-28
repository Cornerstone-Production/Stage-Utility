// messages.ts — what a viewer is sent.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { DOCS_LIST_MAX, docsMessage, echoableCloseCode, frameMessage, heartbeatMessage } from "./messages.js";

describe("frameMessage", () => {
  test("is the stored text as data, verbatim, on the channel", () => {
    assert.equal(frameMessage("pco:live", '{"mode" : "item"}'), '{"channel":"pco:live","data":{"mode" : "item"}}');
    assert.equal(frameMessage("spl:history", "null"), '{"channel":"spl:history","data":null}');
  });

  test("is marked as a replay for a viewer that has just joined, and only then", () => {
    assert.equal(frameMessage("pco:live", "{}", true), '{"channel":"pco:live","data":{},"replay":true}');
    assert.doesNotMatch(frameMessage("pco:live", "{}"), /replay/);
  });

  test("is JSON a viewer can parse", () => {
    assert.deepEqual(JSON.parse(frameMessage("stage:state-changed", '{"pcoConfigured":true}', true)), {
      channel: "stage:state-changed",
      data: { pcoConfigured: true },
      replay: true,
    });
  });
});

describe("heartbeatMessage", () => {
  test("a live one is when, and the build", () => {
    assert.equal(heartbeatMessage(1234, "0123456789ab"), '{"channel":"publish:heartbeat","data":{"at":1234,"build":"0123456789ab"}}');
  });

  test("names no build when there is none, rather than a null a page would have to read", () => {
    assert.equal(heartbeatMessage(1234, null), '{"channel":"publish:heartbeat","data":{"at":1234}}');
    assert.equal(heartbeatMessage(null, null, 99), '{"channel":"publish:heartbeat","data":{"at":null,"now":99},"replay":true}');
  });

  test("the one replayed on connect carries the edge's clock, so a page can age `at` without one of its own", () => {
    assert.deepEqual(JSON.parse(heartbeatMessage(1000, "0123456789ab", 91_000)), {
      channel: "publish:heartbeat",
      data: { at: 1000, now: 91_000, build: "0123456789ab" },
      replay: true,
    });
    assert.deepEqual(JSON.parse(heartbeatMessage(null, "0123456789ab", 5)).data, { at: null, now: 5, build: "0123456789ab" }, "null before the first heartbeat");
  });

  test("a live one carries no `now`, and is not a replay", () => {
    const live = JSON.parse(heartbeatMessage(1000, "0123456789ab"));
    assert.equal("now" in live.data, false);
    assert.equal("replay" in live, false);
  });
});

describe("docsMessage", () => {
  test("names the docs that changed", () => {
    assert.equal(docsMessage(["state"]), '{"channel":"publish:docs","data":{"keys":["state"]}}');
    assert.deepEqual(JSON.parse(docsMessage(["rundown-1", "service-types"])).data, { keys: ["rundown-1", "service-types"] });
  });

  test("a change too wide to list names the first of them and says `all`", () => {
    const keys = Array.from({ length: DOCS_LIST_MAX + 10 }, (_, i) => `rundown-${i}`);
    const data = JSON.parse(docsMessage(keys)).data;
    assert.equal(data.keys.length, DOCS_LIST_MAX);
    assert.deepEqual(data.keys, keys.slice(0, DOCS_LIST_MAX));
    assert.equal(data.all, true);
  });

  test("exactly as many as it will list is not `all`", () => {
    const keys = Array.from({ length: DOCS_LIST_MAX }, (_, i) => `rundown-${i}`);
    assert.equal("all" in JSON.parse(docsMessage(keys)).data, false);
  });
});

describe("echoableCloseCode", () => {
  test("a code that can be sent is answered with itself", () => {
    for (const code of [1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011, 1012, 1013, 1014, 3000, 4000, 4999]) {
      assert.equal(echoableCloseCode(code), code, String(code));
    }
  });

  test("one that cannot be sent, or that an endpoint may not choose, is answered with a normal close", () => {
    // 1004, 1005, 1006 and 1015 name no close and `close()` throws on them; 1016 to 2999 are not an endpoint's to pick.
    for (const code of [0, 1, 999, 1004, 1005, 1006, 1015, 1016, 2000, 2999, 5000, 65535, -1, Number.NaN]) {
      assert.equal(echoableCloseCode(code), 1000, String(code));
    }
  });
});
