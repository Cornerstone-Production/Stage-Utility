import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  kioskDevicesStore, authorise, claim, release, touch, matchByMac, newClaimToken,
} from "./kiosk-devices-store.js";
import { configFilenames } from "./store-registry.js";
import type { BoundDevice } from "../types/kiosk.js";

// Binding a machine to a display. The rules worth pinning are the ones that
// decide what an operator loses when something goes wrong: whether a wrong token
// can be served a claimed screen, whether two machines can fight over one output,
// and whether a device probing every two seconds rewrites a config file at the
// same rate.

const dev = (over: Partial<BoundDevice> = {}): BoundDevice => ({
  id: "d1", token: "tok-1", outputId: "display-1", macs: ["aa:bb:cc:00:11:22"], ...over,
});

describe("the store declares itself", () => {
  test("it is config, so a binding survives a restore", () => {
    // Not cosmetic: a store that is not declared config is silently missing from
    // every backup, which this repo has been bitten by before.
    // Asserted through the registry, which is what config-snapshot actually
    // reads — a store that declares itself and is never registered would still
    // be missing from every backup.
    assert.ok(kioskDevicesStore, "the store must be imported for it to register");
    assert.ok(
      configFilenames().includes("kiosk-devices.json"),
      "kiosk-devices.json is not in the config snapshot, so bindings would not be backed up",
    );
  });
});

describe("authorising an enrolment", () => {
  const devices = [dev()];

  test("the right id and token is served its display", () => {
    assert.equal(authorise(devices, "d1", "tok-1")?.outputId, "display-1");
  });

  test("a WRONG token is a different device, not an error", () => {
    // THE security guard. A device id is self-asserted — anything on the LAN can
    // send one — so without this, claiming to be d1 is enough to be handed the
    // Left Mic Display's content.
    assert.equal(authorise(devices, "d1", "wrong"), null);
  });

  test("a MISSING token is refused too", () => {
    // The easy hole: treating "no token supplied" as "nothing to check".
    assert.equal(authorise(devices, "d1", undefined), null);
    assert.equal(authorise(devices, "d1", ""), null);
  });

  test("an unknown device is refused", () => {
    assert.equal(authorise(devices, "nobody", "tok-1"), null);
  });

  test("tokens are not guessable", () => {
    const a = newClaimToken();
    assert.ok(a.length >= 24, `token is only ${a.length} chars`);
    assert.notEqual(a, newClaimToken());
  });
});

describe("claiming", () => {
  test("binds to an existing output and issues a token", () => {
    const { devices, token } = claim([], "d9", "display-2", { hostname: "stage-pi-2" });
    assert.equal(devices.length, 1);
    assert.equal(devices[0].outputId, "display-2");
    assert.equal(devices[0].token, token);
    assert.equal(devices[0].label, "stage-pi-2", "the hostname should name it until renamed");
  });

  test("claiming an output that already has a device MOVES the binding", () => {
    // Two machines fighting over one screen is not a state worth reaching.
    const before = [dev({ id: "old", outputId: "display-1" })];
    const { devices, displaced } = claim(before, "new", "display-1");
    assert.equal(displaced?.id, "old");
    assert.deepEqual(devices.map((d) => d.id), ["new"], "the old device is still bound");
  });

  test("re-claiming the same device keeps its token", () => {
    // Otherwise the agent currently showing that screen is locked out of it by an
    // operator adjusting the very binding it is serving.
    const before = [dev()];
    const { devices, token } = claim(before, "d1", "display-3");
    assert.equal(token, "tok-1");
    assert.equal(devices[0].outputId, "display-3");
  });

  test("a device can be moved to another output without losing its identity", () => {
    const { devices } = claim([dev({ macs: ["aa"], hostname: "pi" })], "d1", "display-9");
    assert.deepEqual(devices[0].macs, ["aa"]);
    assert.equal(devices[0].hostname, "pi");
  });
});

describe("releasing", () => {
  test("unbinds the device and leaves the output alone", () => {
    const after = release([dev(), dev({ id: "d2", outputId: "display-2" })], "d1");
    assert.deepEqual(after.map((d) => d.id), ["d2"]);
  });

  test("releasing something unknown changes nothing", () => {
    const before = [dev()];
    assert.deepEqual(release(before, "nope"), before);
  });
});

describe("recording what a probe saw", () => {
  test("new hardware facts are stored", () => {
    const after = touch([dev()], "d1", { ip: "192.168.16.61", hostname: "pi-1", now: 1000 });
    assert.equal(after[0].ip, "192.168.16.61");
    assert.equal(after[0].hostname, "pi-1");
  });

  test("an unchanged probe returns the SAME array", () => {
    // THE churn guard. A device probes every two seconds; without this the config
    // file is rewritten every two seconds, forever, on every install.
    const before = [dev({ ip: "1.2.3.4", hostname: "pi", os: "Linux" })];
    const after = touch(before, "d1", { ip: "1.2.3.4", hostname: "pi", os: "Linux", now: 9999 });
    assert.equal(after, before, "an identical probe caused a write");
  });

  test("a device we do not know is not added by a probe", () => {
    // Probes do not create bindings. Claiming does.
    const before = [dev()];
    assert.equal(touch(before, "stranger", { now: 1 }), before);
  });
});

describe("recognising the same hardware coming back", () => {
  const devices = [
    dev({ id: "left", outputId: "display-1", macs: ["3c:52:82:0d:11:af"] }),
    dev({ id: "right", outputId: "display-2", macs: ["b8:27:eb:07:f9:31"] }),
  ];

  test("a MAC match finds the device that used to be that box", () => {
    assert.deepEqual(matchByMac(devices, ["3c:52:82:0d:11:af"]).map((d) => d.id), ["left"]);
  });

  test("case does not matter", () => {
    assert.deepEqual(matchByMac(devices, ["3C:52:82:0D:11:AF"]).map((d) => d.id), ["left"]);
  });

  test("no MACs matches nothing rather than everything", () => {
    assert.deepEqual(matchByMac(devices, []), []);
  });

  test("a device with NO recorded MACs is never a match", () => {
    // The plausible bug, and the reason the test above is not enough on its own:
    // written with `.every()` instead of `.some()`, a device whose macs array is
    // empty matches ANY probe — vacuous truth — and the app offers to re-bind a
    // brand new screen to one it has never been.
    const withUnknown = [...devices, dev({ id: "never-seen", outputId: "display-3", macs: [] })];
    const hits = matchByMac(withUnknown, ["3c:52:82:0d:11:af"]).map((d) => d.id);
    assert.deepEqual(hits, ["left"], "a device with no known MACs was offered as a match");
  });

  test("an unknown MAC matches nothing", () => {
    assert.deepEqual(matchByMac(devices, ["00:00:00:00:00:00"]), []);
  });
});
