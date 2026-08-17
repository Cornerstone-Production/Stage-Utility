import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  encodeProbe, decodeProbe, encodeReply, decodeReply, decideProbe, MAX_DATAGRAM,
} from "./kiosk-discovery.js";

// The discovery exchange. Two things are worth testing here and they are not the
// JSON: what this server ANSWERS, and what it SHOWS.
//
// Everything arrives on a broadcast port, so the decoders are fed rubbish on
// purpose — anything on the LAN can send anything, and a parse that throws takes
// the listener down with it.

const probe = (over: Partial<Parameters<typeof encodeProbe>[0]> = {}) => ({
  id: "d4f19c2a", macs: ["b8:27:eb:41:9c:2a"], hostname: "raspberrypi", os: "Linux", ...over,
});

describe("the wire format survives a broadcast port", () => {
  test("a probe round-trips", () => {
    const p = probe({ boundTo: "srv-1", unreachable: true });
    assert.deepEqual(decodeProbe(encodeProbe(p)), p);
  });

  test("a reply round-trips", () => {
    const r = { serverId: "srv-1", name: "FOH — Stage Utility", url: "http://192.168.16.61" };
    assert.deepEqual(decodeReply(encodeReply(r)), r);
  });

  test("rubbish decodes to null instead of throwing", () => {
    // Every one of these is something a real LAN will eventually send at us.
    for (const junk of ["", "not json", "{", "[]", "null", "42", '{"hello":"world"}', "\0\0\0"]) {
      assert.equal(decodeProbe(junk), null, `probe: ${JSON.stringify(junk)}`);
      assert.equal(decodeReply(junk), null, `reply: ${JSON.stringify(junk)}`);
    }
  });

  test("another app's datagram on the same port is not ours", () => {
    assert.equal(decodeProbe(JSON.stringify({ stageUtility: "discover", v: 99, id: "x" })), null);
    assert.equal(decodeProbe(JSON.stringify({ somethingElse: "discover", v: 1, id: "x" })), null);
  });

  test("a probe with no id is rejected", () => {
    // The id is the whole point; without it there is nothing to key on.
    assert.equal(decodeProbe(JSON.stringify({ stageUtility: "discover", v: 1 })), null);
    assert.equal(decodeProbe(JSON.stringify({ stageUtility: "discover", v: 1, id: "" })), null);
  });

  test("an oversized datagram is dropped without parsing", () => {
    // A flood should be cheap to reject, and nothing on the LAN gets to decide
    // how much memory a Map of seen devices keeps.
    const huge = JSON.stringify({ stageUtility: "discover", v: 1, id: "x".repeat(MAX_DATAGRAM) });
    assert.ok(huge.length > MAX_DATAGRAM);
    assert.equal(decodeProbe(huge), null);
  });

  test("strings and arrays are bounded", () => {
    const decoded = decodeProbe(
      JSON.stringify({
        stageUtility: "discover", v: 1, id: "a".repeat(500),
        macs: Array.from({ length: 50 }, (_, i) => `mac-${i}`),
        hostname: "h".repeat(500),
      }),
    )!;
    assert.ok(decoded.id.length <= 128, `id was ${decoded.id.length}`);
    assert.ok(decoded.macs.length <= 8, `kept ${decoded.macs.length} macs`);
    assert.ok((decoded.hostname ?? "").length <= 128);
  });

  test("a malformed macs field does not break the probe", () => {
    const d = decodeProbe(JSON.stringify({ stageUtility: "discover", v: 1, id: "x", macs: [1, null, "ok"] }))!;
    assert.deepEqual(d.macs, ["ok"]);
  });
});

describe("what this server answers", () => {
  const ME = "srv-me";

  test("a device bound to US is answered even when not scanning", () => {
    // THE rule that matters. This is how a display re-finds its server after an
    // IP change with nobody present; gating it behind a scan would leave a screen
    // dark until somebody opened settings.
    const d = decideProbe(probe({ boundTo: ME }), ME, { scanning: false, bound: true });
    assert.equal(d.answer, true, "a bound display could not re-find its own server");
  });

  test("an unclaimed device is answered only while scanning", () => {
    assert.equal(decideProbe(probe(), ME, { scanning: false, bound: false }).answer, false);
    assert.equal(decideProbe(probe(), ME, { scanning: true, bound: false }).answer, true);
  });

  test("a device bound elsewhere is never answered", () => {
    // Not ours to serve, scanning or not, reachable or not.
    for (const scanning of [false, true]) {
      for (const unreachable of [false, true]) {
        const d = decideProbe(probe({ boundTo: "srv-other", unreachable }), ME, { scanning, bound: false });
        assert.equal(d.answer, false, `scanning=${scanning} unreachable=${unreachable}`);
      }
    }
  });
});

describe("what this server shows", () => {
  const ME = "srv-me";

  test("claiming on one server hides it from every other", () => {
    // THE property, and it needs no server-to-server protocol: the device carries
    // its own binding and everyone else leaves it alone.
    const d = decideProbe(probe({ boundTo: "srv-other" }), ME, { scanning: true, bound: false });
    assert.equal(d.list, "none", "a device claimed elsewhere still showed up here");
  });

  test("unless it cannot reach the server that owns it", () => {
    // The recovery path off a decommissioned server. Shown, never answered, and
    // reclaiming stays an explicit act.
    const d = decideProbe(probe({ boundTo: "srv-other", unreachable: true }), ME, { scanning: true, bound: false });
    assert.equal(d.list, "elsewhere");
    assert.equal(d.answer, false, "showing it is not the same as serving it");
  });

  test("nothing new appears unless someone is looking", () => {
    assert.equal(decideProbe(probe(), ME, { scanning: false, bound: false }).list, "none");
    assert.equal(decideProbe(probe(), ME, { scanning: true, bound: false }).list, "unclaimed");
  });

  test("our own bound device is not offered as something to claim", () => {
    const d = decideProbe(probe({ boundTo: ME }), ME, { scanning: true, bound: true });
    assert.equal(d.list, "mine");
  });

  test("a device claiming us that we have no record of reads as unclaimed", () => {
    // A restored config, or one claimed on an install that has since been wiped.
    // It must not be treated as bound — there is nothing to bind it to — but it
    // must still be answerable so it can be re-claimed rather than going dark.
    const d = decideProbe(probe({ boundTo: ME }), ME, { scanning: false, bound: false });
    assert.equal(d.list, "unclaimed");
    assert.equal(d.answer, true);
  });
});
