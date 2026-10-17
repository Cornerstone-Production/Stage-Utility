import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  encodeProbe, decodeProbe, encodeReply, decodeReply, decideProbe, listedBoundTo, isFromThisMachine, MAX_DATAGRAM,
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
    const p = probe({ boundTo: "srv-1", unreachable: true, mode: "1920x1080" });
    assert.deepEqual(decodeProbe(encodeProbe(p)), p);
  });

  test("a probe from a device that could not read its mode still decodes", () => {
    // Only Linux can read /sys/class/drm. macOS and Windows send no mode at all
    // and must not be dropped for it.
    assert.equal(decodeProbe(encodeProbe(probe()))?.id, "d4f19c2a");
    assert.equal(decodeProbe(encodeProbe(probe()))?.mode, undefined);
  });

  test("a reply round-trips", () => {
    const r = { serverId: "srv-1", name: "FOH — Stage Utility", url: "http://192.168.1.50" };
    assert.deepEqual(decodeReply(encodeReply(r)), r);
    for (const claimed of [true, false]) assert.deepEqual(decodeReply(encodeReply({ ...r, claimed })), { ...r, claimed });
  });

  test("a reply's claimed is a boolean or absent", () => {
    // Absent from a server older than the field; anything else is not an answer.
    const base = { stageUtility: "server", v: 1, serverId: "srv-1", url: "http://192.168.1.50" };
    assert.equal("claimed" in decodeReply(JSON.stringify(base))!, false);
    for (const claimed of [1, "true", null]) {
      assert.equal("claimed" in decodeReply(JSON.stringify({ ...base, claimed }))!, false, JSON.stringify(claimed));
    }
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
    // Answering is the commitment: a device binds to the first server that
    // answers it, so a server that answered every new device at all times would
    // race any other Stage Utility on the network for it.
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

  test("a new device is listed whether or not anyone is looking", () => {
    // Listing is what lets the sidebar count and the Screens banner show a device
    // the moment someone looks, with no scan to open first. It answers nothing.
    for (const scanning of [false, true]) {
      assert.equal(decideProbe(probe(), ME, { scanning, bound: false }).list, "unclaimed", `scanning=${scanning}`);
    }
  });

  test("our own bound device is not offered as something to claim", () => {
    const d = decideProbe(probe({ boundTo: ME }), ME, { scanning: true, bound: true });
    assert.equal(d.list, "mine");
  });

  test("a device bound here is answered and never listed, whatever its probe says", () => {
    // Includes the probe already on the wire when it was claimed, which does not
    // carry the binding yet: listing it would offer a screen that is set up.
    for (const scanning of [false, true]) {
      for (const boundTo of [undefined, ME]) {
        const d = decideProbe(probe({ boundTo }), ME, { scanning, bound: true });
        assert.deepEqual(d, { answer: true, list: "mine" }, `scanning=${scanning} boundTo=${boundTo}`);
      }
    }
  });

  test("a device bound here but now carrying another server's binding is that server's", () => {
    const d = decideProbe(probe({ boundTo: "srv-other" }), ME, { scanning: true, bound: true });
    assert.deepEqual(d, { answer: false, list: "none" }, "two servers would fight over one screen");
  });

  test("a listed device shows only a binding to ANOTHER server", () => {
    assert.equal(listedBoundTo({ boundTo: ME }, ME), undefined, "a device naming this server read as set up elsewhere");
    assert.equal(listedBoundTo({ boundTo: "srv-other" }, ME), "srv-other");
    assert.equal(listedBoundTo({}, ME), undefined);
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

// The whole policy as one table, so a change to any cell is a visible edit rather
// than a missing assertion. One entry per line.
describe("the decision table", () => {
  const ME = "srv-me";
  type Case = {
    name: string;
    probe: Partial<Parameters<typeof encodeProbe>[0]>;
    scanning: boolean;
    bound: boolean;
    want: ReturnType<typeof decideProbe>;
  };
  const CASES: Case[] = [
    { name: "unbound, not scanning", probe: {}, scanning: false, bound: false, want: { answer: false, list: "unclaimed" } },
    { name: "unbound, scanning", probe: {}, scanning: true, bound: false, want: { answer: true, list: "unclaimed" } },
    { name: "bound here, not scanning", probe: { boundTo: ME }, scanning: false, bound: true, want: { answer: true, list: "mine" } },
    { name: "bound here, scanning", probe: { boundTo: ME }, scanning: true, bound: true, want: { answer: true, list: "mine" } },
    { name: "bound here, probe not yet carrying it", probe: {}, scanning: false, bound: true, want: { answer: true, list: "mine" } },
    { name: "names us, no record, not scanning", probe: { boundTo: ME }, scanning: false, bound: false, want: { answer: true, list: "unclaimed" } },
    { name: "names us, no record, scanning", probe: { boundTo: ME }, scanning: true, bound: false, want: { answer: true, list: "unclaimed" } },
    { name: "bound elsewhere, not scanning", probe: { boundTo: "srv-other" }, scanning: false, bound: false, want: { answer: false, list: "none" } },
    { name: "bound elsewhere, scanning", probe: { boundTo: "srv-other" }, scanning: true, bound: false, want: { answer: false, list: "none" } },
    { name: "unreachable elsewhere, not scanning", probe: { boundTo: "srv-other", unreachable: true }, scanning: false, bound: false, want: { answer: false, list: "elsewhere" } },
    { name: "unreachable elsewhere, scanning", probe: { boundTo: "srv-other", unreachable: true }, scanning: true, bound: false, want: { answer: false, list: "elsewhere" } },
    { name: "held here but now naming another server", probe: { boundTo: "srv-other" }, scanning: true, bound: true, want: { answer: false, list: "none" } },
  ];

  for (const c of CASES) {
    test(c.name, () => {
      assert.deepEqual(decideProbe(probe(c.probe), ME, { scanning: c.scanning, bound: c.bound }), c.want);
    });
  }
});

// The Mac output helper announces one device per output, each probe carrying an
// `output`. It arrives on the same broadcast port as everything else, so every
// field of it is as untrusted as the rest.
describe("a helper output on the wire", () => {
  const wire = (output: unknown, over: Record<string, unknown> = {}) =>
    JSON.stringify({ stageUtility: "discover", v: 1, id: "mac1.sdi-1", macs: ["02:00:00:00:00:01"], output, ...over });

  test("an output round-trips, modes and all", () => {
    const p = probe({
      id: "mac1.sdi-1",
      output: { kind: "decklink" as const, name: "SDI 1 · Card A", port: "SDI 1", modes: ["1080p59.94", "720p50"] },
    });
    const d = decodeProbe(encodeProbe(p))!;
    assert.equal(d.id, "mac1.sdi-1");
    assert.deepEqual(d.output, p.output);
  });

  test("a display output has no modes and says none", () => {
    const d = decodeProbe(wire({ kind: "display", name: "HDMI · Monitor", port: "HDMI 1" }))!;
    assert.deepEqual(d.output, { kind: "display", name: "HDMI · Monitor", port: "HDMI 1" });
  });

  test("a probe without an output has no output key at all", () => {
    // "Behaves exactly as today": not even an undefined property to trip a deep
    // comparison or a spread that copies it over a stored value.
    assert.equal("output" in decodeProbe(encodeProbe(probe()))!, false);
  });

  test("an unknown kind drops the output and keeps the probe", () => {
    // A newer helper announcing a kind this server cannot name. The device is
    // still a device, so it is not lost; it just reads as a plain one.
    const d = decodeProbe(wire({ kind: "ndi", name: "NDI 1", port: "NDI 1" }))!;
    assert.equal(d.id, "mac1.sdi-1");
    assert.equal("output" in d, false, "an output of an unknown kind was kept");
  });

  test("an output with no name or no port is not one", () => {
    for (const bad of [
      { kind: "display", port: "HDMI 1" },
      { kind: "display", name: "", port: "HDMI 1" },
      { kind: "display", name: "HDMI 1" },
    ]) {
      assert.equal("output" in decodeProbe(wire(bad))!, false, JSON.stringify(bad));
    }
  });

  test("a field that is not an object is not an output", () => {
    for (const bad of ["decklink", 7, null, true, ["decklink"]]) {
      assert.equal("output" in decodeProbe(wire(bad))!, false, JSON.stringify(bad));
    }
  });

  test("an output is bounded like every other field", () => {
    const d = decodeProbe(wire({
      kind: "decklink",
      name: "n".repeat(500),
      port: "p".repeat(500),
      modes: [...Array.from({ length: 60 }, (_, i) => `m${i}`), "x".repeat(200), 7, null, ""],
    }))!;
    assert.equal(d.output?.name.length, 128);
    assert.equal(d.output?.port.length, 128);
    assert.equal(d.output?.modes?.length, 24, "the modes list was not capped");
    assert.deepEqual(d.output?.modes?.slice(0, 3), ["m0", "m1", "m2"]);
  });

  test("a mode longer than the cap is cut, not kept whole", () => {
    const d = decodeProbe(wire({ kind: "decklink", name: "SDI", port: "SDI", modes: ["x".repeat(200)] }))!;
    assert.equal(d.output?.modes?.[0].length, 32);
  });
});

describe("a probe from this machine", () => {
  const MINE = new Set(["aa:bb:cc:00:11:22"]);

  test("a plain device on this machine's MAC is this machine", () => {
    assert.equal(isFromThisMachine(probe({ macs: ["AA:BB:CC:00:11:22"] }), MINE), true);
  });

  test("a helper output on this machine's MAC is let through", () => {
    // The helper on the server's own Mac is a supported setup: what it announces
    // are that Mac's displays and SDI ports, which are screens on the wall.
    const p = probe({
      macs: ["aa:bb:cc:00:11:22"],
      output: { kind: "display" as const, name: "HDMI 1", port: "HDMI 1" },
    });
    assert.equal(isFromThisMachine(p, MINE), false);
  });

  test("another machine's probe is not this machine", () => {
    assert.equal(isFromThisMachine(probe({ macs: ["02:00:00:00:00:09"] }), MINE), false);
  });
});
