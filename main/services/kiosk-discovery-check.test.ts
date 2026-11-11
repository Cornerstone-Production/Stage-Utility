// The duplicate-id check, as pure decisions.
//
// A server finds out that another one answers discovery with its id by sending a
// probe of its own: today's probe, naming its own id as the server it is bound
// to, marked `check`. Every server with another id ignores it (rule 1), and one
// with the same id answers it, whatever its build (rule 3). A server new enough
// to read `check` answers it without listing it as a screen, and takes the probe
// itself as the evidence.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { broadcastAddresses, decideCheck, decideProbe, decodeProbe, encodeProbe } from "./kiosk-discovery.js";
import type { DiscoveryProbe } from "../types/kiosk.js";

const OWN = "3f2a9c1e-5b7d-4e21-9a0c-6d8e2f41b7a3";
const OTHER = "7c1e04ab-92f3-4d6a-b1e8-0f5c3a9d2e64";
const MY_CHECK = "server-check-aaaaaaaaaaaa";

const check = (over: Partial<DiscoveryProbe> = {}): DiscoveryProbe => ({
  id: "server-check-bbbbbbbbbbbb",
  macs: ["02:00:00:00:00:bb"],
  hostname: "other-box",
  os: "Stage Utility server",
  boundTo: OWN,
  check: true,
  ...over,
});

describe("the check on the wire", () => {
  test("survives encoding", () => {
    assert.equal(decodeProbe(encodeProbe(check()))?.check, true);
  });

  test("a plain probe carries no check at all, so it decodes as it always has", () => {
    const d = decodeProbe(JSON.stringify({ stageUtility: "discover", v: 1, id: "pi-1", macs: [] }))!;
    assert.equal(Object.hasOwn(d, "check"), false);
  });

  test("only a literal true is a check", () => {
    for (const v of ["true", 1, {}, null]) {
      const d = decodeProbe(JSON.stringify({ stageUtility: "discover", v: 1, id: "x", check: v }))!;
      assert.equal(d.check, undefined, JSON.stringify(v));
    }
  });
});

describe("decideCheck", () => {
  test("ANOTHER SERVER CHECKING FOR THIS SERVER'S ID is a duplicate", () => {
    assert.equal(decideCheck(check(), OWN, MY_CHECK), "duplicate");
  });

  test("a check for another server's id is ignored", () => {
    assert.equal(decideCheck(check({ boundTo: OTHER }), OWN, MY_CHECK), "ignore");
    assert.equal(decideCheck(check({ boundTo: undefined }), OWN, MY_CHECK), "ignore");
  });

  test("this server's own check, heard back off the broadcast, is its own", () => {
    // By the per-start id, not by MAC: a box that reports no MAC, or two servers
    // on one machine, would otherwise read their own check as somebody else's.
    assert.equal(decideCheck(check({ id: MY_CHECK }), OWN, MY_CHECK), "own");
  });
});

describe("an older server, which knows nothing of check", () => {
  test("still answers a check for its own id, which is what makes it detectable", () => {
    // decideProbe is what a build without decideCheck runs: rule 3.
    assert.equal(decideProbe(check(), OWN, { scanning: false, bound: false }).answer, true);
  });

  test("ignores a check for another id", () => {
    assert.deepEqual(decideProbe(check({ boundTo: OTHER }), OWN, { scanning: true, bound: false }), { answer: false, list: "none" });
  });
});

describe("where the check is broadcast", () => {
  const nic = (address: string, netmask: string, over: Partial<{ family: string | number; internal: boolean }> = {}) => ({
    address, netmask, family: "IPv4", internal: false, ...over,
  });

  test("EACH INTERFACE'S DIRECTED BROADCAST, not the limited one macOS refuses", () => {
    assert.deepEqual(
      broadcastAddresses({ en0: [nic("192.168.1.50", "255.255.255.0")], en1: [nic("10.0.0.7", "255.255.255.0")] }),
      ["10.0.0.255", "192.168.1.255"],
    );
  });

  test("skips loopback, host routes, IPv6, and repeats", () => {
    assert.deepEqual(
      broadcastAddresses({
        lo0: [nic("127.0.0.1", "255.0.0.0", { internal: true })],
        utun4: [nic("10.0.0.9", "255.255.255.255")],
        en0: [nic("192.168.1.50", "255.255.255.0"), { address: "fe80::1", netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", internal: false }],
        bridge0: [nic("192.168.1.51", "255.255.255.0")],
      }),
      ["192.168.1.255"],
    );
  });

  test("an older Node's numeric family still counts", () => {
    assert.deepEqual(broadcastAddresses({ eth0: [nic("192.168.1.50", "255.255.255.0", { family: 4 })] }), ["192.168.1.255"]);
  });

  test("with no usable interface, the limited broadcast", () => {
    assert.deepEqual(broadcastAddresses({}), ["255.255.255.255"]);
  });
});
