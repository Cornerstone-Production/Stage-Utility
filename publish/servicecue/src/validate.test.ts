// validate.test.ts — what a publish body must be before it is stored.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { PUBLISH_MAX_BODY_BYTES, PUBLISH_MAX_VERSION_LENGTH } from "../../../main/types/servicecue-publish.js";
import { MANIFEST_MAX_ENTRIES, docText, frameBody, heartbeatBody, manifestBody, parseJson, publicStateProblem } from "./validate.js";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("parseJson", () => {
  test("returns the value and the exact text, spacing and key order included", () => {
    const text = '{ "b": 1,\n  "a": [1, 2] }';
    const parsed = parseJson(bytes(text));
    assert.deepEqual(parsed, { ok: true, value: { text, json: { b: 1, a: [1, 2] } } });
  });

  test("a byte-order mark is dropped, not read as part of the JSON", () => {
    const parsed = parseJson(new Uint8Array([0xef, 0xbb, 0xbf, ...bytes("[1]")]));
    assert.deepEqual(parsed, { ok: true, value: { text: "[1]", json: [1] } });
  });

  test("null and the other bare values are JSON", () => {
    for (const text of ["null", "0", '"s"', "false", "[]"]) assert.equal(parseJson(bytes(text)).ok, true, text);
  });

  test("text that is not JSON is refused, with the reason", () => {
    for (const text of ["", "not json", "{", "{'a':1}", "[1,]", "undefined", "{} {}"]) {
      const parsed = parseJson(bytes(text));
      assert.equal(parsed.ok, false, JSON.stringify(text));
      if (!parsed.ok) assert.match(parsed.error, /not JSON/);
    }
  });

  test("bytes that are not UTF-8 are refused", () => {
    const parsed = parseJson(new Uint8Array([0x22, 0xff, 0xfe, 0x22]));
    assert.equal(parsed.ok, false);
    if (!parsed.ok) assert.match(parsed.error, /UTF-8/);
  });
});

describe("docText", () => {
  test("a doc that is not also a frame is stored as it was sent", () => {
    const text = '{"a" :  1}';
    for (const key of ["servicecue-layouts", "servicecue-roles", "servicecue-config", "service-types", "rundown-1", "rundown-1-2", "plans-upcoming"]) {
      assert.deepEqual(docText(key, text, JSON.parse(text)), { ok: true, value: text }, key);
    }
  });

  test("the two live docs are an object or null, stored as JSON; anything else is refused", () => {
    for (const key of ["pco-live", "spl-current"]) {
      assert.deepEqual(docText(key, '{"a" :  1}', { a: 1 }), { ok: true, value: '{"a":1}' }, key);
      assert.deepEqual(docText(key, "null", null), { ok: true, value: "null" }, key);
      for (const bad of [[], "x", 3, true, [{}]]) {
        const refused = docText(key, JSON.stringify(bad), bad);
        assert.equal(refused.ok, false, `${key} ${JSON.stringify(bad)}`);
        if (!refused.ok) assert.match(refused.error, /must be an object, or null/);
      }
    }
  });

  test("the state is cut down to the public fields before it is stored", () => {
    const sent = { pcoConfigured: true, timezone: "UTC", lanUrl: "http://192.168.1.2:8788", views: [1] };
    const stored = docText("state", JSON.stringify(sent), sent);
    assert.equal(stored.ok, true);
    if (stored.ok) assert.deepEqual(JSON.parse(stored.value), { pcoConfigured: true, timezone: "UTC" });
  });

  test("a state that is not an object is refused", () => {
    for (const bad of [null, [], "x", 3]) {
      const refused = docText("state", JSON.stringify(bad), bad);
      assert.equal(refused.ok, false, JSON.stringify(bad));
      if (!refused.ok) assert.match(refused.error, /must be an object/);
    }
  });

  test("a doc that grows in being stored is refused as too large, not left for the database to refuse", () => {
    // Five bytes as sent, twenty-one once stored.
    const sent = `{"n":[${"1e20,".repeat(100_000)}1e20]}`;
    assert.ok(bytes(sent).length < PUBLISH_MAX_BODY_BYTES);
    const refused = docText("pco-live", sent, JSON.parse(sent));
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.status, 413);
    // And the same doc, small enough to keep, is kept.
    const small = `{"n":[${"1e20,".repeat(1000)}1e20]}`;
    assert.equal(docText("pco-live", small, JSON.parse(small)).ok, true);
  });

  test("a doc whose characters are more than one byte each is measured in bytes", () => {
    const text = JSON.stringify({ s: "é".repeat(PUBLISH_MAX_BODY_BYTES / 2 + 100) });
    assert.ok(text.length < PUBLISH_MAX_BODY_BYTES, "fewer characters than the cap, more bytes");
    const refused = docText("pco-live", text, JSON.parse(text));
    assert.equal(refused.ok, false, "a million two-byte characters are two megabytes of storage");
  });
});

describe("the state's fields", () => {
  const good = { accentColor: "#2e6691", appLogo: "/branding-images/logo-9f3a2c.png", appLogoMonochrome: true, hourCycle: "12h", pcoConfigured: true, timezone: "America/Chicago" } as const;

  test("a state of well-formed fields, nulls where the app has them, and none at all is let through", () => {
    assert.equal(publicStateProblem(good), null);
    assert.equal(publicStateProblem({ accentColor: null, appLogo: null, timezone: null }), null);
    assert.equal(publicStateProblem({}), null);
    assert.equal(publicStateProblem({ hourCycle: "24h", timezone: "UTC" }), null);
  });

  test("every field that is there and wrong is refused by name, and nothing is dropped quietly", () => {
    const bad: [string, unknown][] = [
      ["timezone", "Not/AZone"],
      ["timezone", ""],
      ["timezone", 5],
      ["timezone", "America/Chicago "],
      ["hourCycle", "12"],
      ["hourCycle", "24H"],
      ["hourCycle", null],
      ["pcoConfigured", "true"],
      ["pcoConfigured", 1],
      ["pcoConfigured", null],
      ["appLogoMonochrome", "yes"],
      ["appLogoMonochrome", 0],
      ["accentColor", "red"],
      ["accentColor", "#fff"],
      ["accentColor", "#12345g"],
      ["accentColor", "2e6691"],
      ["accentColor", 3],
      ["appLogo", "http://example.com/x.png"],
      ["appLogo", "/branding-images/"],
      ["appLogo", "/branding-images/a/b.png"],
      ["appLogo", "/branding-images/../state"],
      ["appLogo", "branding-images/logo.png"],
      ["appLogo", 5],
    ];
    for (const [field, value] of bad) {
      const problem = publicStateProblem({ ...good, [field]: value });
      assert.ok(problem?.includes(`state's ${field}`), `${field} = ${JSON.stringify(value)} gave ${problem}`);
    }
  });

  test("a doc and a frame with one are refused with a 400, and the zone that crashed every visitor's clock does not get in", () => {
    for (const state of [{ timezone: "Not/AZone" }, { hourCycle: "9h" }, { appLogo: "/etc/passwd" }]) {
      const doc = docText("state", JSON.stringify(state), state);
      assert.equal(doc.ok, false, JSON.stringify(state));
      if (!doc.ok) assert.equal(doc.status, 400);
      const frame = frameBody({ channel: "stage:state-changed", data: state });
      assert.equal(frame.ok, false, JSON.stringify(state));
    }
  });
});

describe("frameBody", () => {
  test("a frame is a write of the doc its channel is stored as, with its data as JSON", () => {
    assert.deepEqual(frameBody({ channel: "pco:live", data: { mode: "item" } }), { ok: true, value: { docKey: "pco-live", text: '{"mode":"item"}' } });
    assert.deepEqual(frameBody({ channel: "spl:history", data: { serviceKey: "k" } }), { ok: true, value: { docKey: "spl-current", text: '{"serviceKey":"k"}' } });
  });

  test("a channel that can be empty may carry null", () => {
    for (const channel of ["pco:live", "spl:history"]) {
      assert.deepEqual(frameBody({ channel, data: null }), { ok: true, value: { docKey: channel === "pco:live" ? "pco-live" : "spl-current", text: "null" } });
    }
  });

  test("a state frame is cut down to the public fields", () => {
    const framed = frameBody({ channel: "stage:state-changed", data: { hourCycle: "24h", appName: "Example", lanUrl: "http://192.168.1.2:8788" } });
    assert.equal(framed.ok, true);
    if (framed.ok) {
      assert.equal(framed.value.docKey, "state");
      assert.deepEqual(JSON.parse(framed.value.text), { hourCycle: "24h" });
    }
  });

  test("a state frame must carry an object", () => {
    for (const data of [null, [], "x", 1]) assert.equal(frameBody({ channel: "stage:state-changed", data }).ok, false, JSON.stringify(data));
  });

  test("a channel that is not one of the three is refused, the heartbeat's and the docs' included", () => {
    for (const channel of ["publish:heartbeat", "publish:docs", "views:changed", "", "PCO:LIVE", 1, null, undefined]) {
      assert.equal(frameBody({ channel, data: {} }).ok, false, String(channel));
    }
  });

  test("a frame without data, or that is not an object, is refused", () => {
    assert.equal(frameBody({ channel: "pco:live" }).ok, false);
    for (const bad of [null, [], "x", 1, true]) assert.equal(frameBody(bad).ok, false, JSON.stringify(bad));
  });

  test("a live frame carries an object or null, not a bare value", () => {
    for (const data of [1, "x", true, [1]]) assert.equal(frameBody({ channel: "pco:live", data }).ok, false, JSON.stringify(data));
  });

  test("a frame that grows in being stored is too large, and says which frame", () => {
    const data = JSON.parse(`{"n":[${"1e20,".repeat(100_000)}1e20]}`);
    const refused = frameBody({ channel: "pco:live", data });
    assert.equal(refused.ok, false);
    if (!refused.ok) {
      assert.equal(refused.status, 413);
      assert.match(refused.error, /^pco:live data is over 2000000 bytes once it is stored$/);
    }
  });
});

describe("heartbeatBody", () => {
  test("a time and a version", () => {
    assert.deepEqual(heartbeatBody({ at: 1_760_000_000_000, version: "1.27.0" }), { ok: true, value: { sentAt: 1_760_000_000_000, version: "1.27.0" } });
  });

  test("anything else is refused", () => {
    for (const bad of [
      null,
      [],
      {},
      { at: 1 },
      { version: "1" },
      { at: "1", version: "1" },
      { at: -1, version: "1" },
      { at: Number.NaN, version: "1" },
      { at: 1, version: "" },
      { at: 1, version: 1 },
      { at: 1, version: "v".repeat(PUBLISH_MAX_VERSION_LENGTH + 1) },
    ]) {
      assert.equal(heartbeatBody(bad).ok, false, JSON.stringify(bad));
    }
    assert.equal(heartbeatBody({ at: 1, version: "v".repeat(PUBLISH_MAX_VERSION_LENGTH) }).ok, true);
  });
});

describe("manifestBody", () => {
  test("the docs and assets to keep", () => {
    assert.deepEqual(manifestBody({ docs: ["state", "rundown-1-2"], assets: ["logo.png"] }), {
      ok: true,
      value: { docs: ["state", "rundown-1-2"], assets: ["logo.png"] },
    });
    assert.deepEqual(manifestBody({ docs: [], assets: [] }), { ok: true, value: { docs: [], assets: [] } });
  });

  test("one bad entry refuses the whole manifest, so nothing is deleted on a typo", () => {
    for (const bad of [
      { docs: ["state", "stat"], assets: [] },
      { docs: [], assets: ["a b.png"] },
      { docs: ["state", 3], assets: [] },
      { docs: [], assets: ["../x"] },
      { docs: ["rundown-a"], assets: [] },
    ]) {
      assert.equal(manifestBody(bad).ok, false, JSON.stringify(bad));
    }
  });

  test("both lists are required, and are lists", () => {
    for (const bad of [null, [], {}, { docs: [] }, { assets: [] }, { docs: "state", assets: [] }, { docs: [], assets: {} }]) {
      assert.equal(manifestBody(bad).ok, false, JSON.stringify(bad));
    }
  });

  test("a list is bounded", () => {
    const docs = Array.from({ length: MANIFEST_MAX_ENTRIES + 1 }, (_, i) => `rundown-${i}`);
    assert.equal(manifestBody({ docs, assets: [] }).ok, false);
    assert.equal(manifestBody({ docs: docs.slice(0, MANIFEST_MAX_ENTRIES), assets: [] }).ok, true);
  });
});

describe("every refusal says what must be", () => {
  test("in the same words", () => {
    const refusals = [frameBody(null), heartbeatBody(null), manifestBody(null), docText("state", "null", null), docText("pco-live", "[]", [])];
    for (const r of refusals) {
      assert.equal(r.ok, false);
      if (!r.ok) assert.match(r.error, /must be|must carry|must both/, r.error);
    }
  });
});
