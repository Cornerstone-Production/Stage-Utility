// The shared devices listing: when it reads, what a burst of frames leaves behind,
// who it keeps updated, and what a failed read does to the sidebar's count.
//
// Every id below is INVENTED. This is a public repository.

import { strict as assert } from "node:assert";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { eventually, installDom, unmountAndTeardown } from "../../test-dom.js";
import { ok, stubFetchWithLog } from "../../test-fixtures/fetch-log.js";
import { FakeEventSource } from "../../test-fixtures/fake-event-source.js";

const teardown = installDom();
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;

const { render, cleanup, act } = await import("@testing-library/react");
const React = (await import("react")).default;
const { __resetReplayCacheForTests } = await import("../../lib/api.js");
const { __resetDevicesForTests, refreshDevices, useDevices, useNotSetUpCount } = await import("./use-devices.js");

type SeenDevice = import("@main/types/kiosk").SeenDevice;

const device = (id: string): SeenDevice => ({ id, macs: [], hostname: id, os: "Linux", ip: "192.0.2.10", firstSeen: 1, lastSeen: 2 });
const settle = () => new Promise((r) => setTimeout(r, 0));

/** What the server holds now. */
let server: SeenDevice[];
let reads: number;
let fetchStub: ReturnType<typeof stubFetchWithLog>;
/** When set, each read waits on this before answering, with the list it saw when asked. */
let hold: Promise<void> | null;
let failReads: boolean;

beforeEach(() => {
  server = [];
  reads = 0;
  hold = null;
  failReads = false;
  fetchStub = stubFetchWithLog(async (url) => {
    if (!url.startsWith("/api/devices")) return ok({});
    reads += 1;
    // The answer is what the server held when the read was ASKED, delivered late.
    const asked = [...server];
    if (hold) await hold;
    if (failReads) throw new TypeError("fetch failed");
    return ok({ scanning: false, seen: asked, matches: {}, bound: [], health: [] });
  });
});
afterEach(() => {
  cleanup();
  fetchStub.restore();
  __resetReplayCacheForTests();
  __resetDevicesForTests();
});
after(() => unmountAndTeardown(cleanup, teardown));

function Names({ testId }: { testId: string }) {
  const { seen } = useDevices();
  return React.createElement("p", { "data-testid": testId }, seen.map((d) => d.id).join(","));
}
function Count({ testId }: { testId: string }) {
  return React.createElement("p", { "data-testid": testId }, String(useNotSetUpCount()));
}
const text = (c: HTMLElement, id: string) => c.querySelector(`[data-testid="${id}"]`)?.textContent;
const push = async () => {
  await act(async () => {
    FakeEventSource.last!.push("kiosk:devices", { scanning: false, seen: [], health: [] });
    await settle();
  });
};

describe("a request that arrives while a read is on the wire", () => {
  test("gets a read of its own: two frames mid-flight make exactly one more read, and the last device is shown", async () => {
    // A Mac's outputs are heard a few ms apart, and each is a frame. The read
    // that was already out was asked before the later ones existed.
    let release!: () => void;
    hold = new Promise<void>((r) => { release = r; });
    server = [device("mac-1.sdi-1")];
    const { container } = render(React.createElement(Names, { testId: "names" }));
    await act(async () => { await settle(); });
    assert.equal(reads, 1, "the mount did not read");

    server = [device("mac-1.sdi-1"), device("mac-1.sdi-2")];
    const first = refreshDevices();
    server = [device("mac-1.sdi-1"), device("mac-1.sdi-2"), device("mac-1.sdi-3")];
    const second = refreshDevices();
    hold = null;
    await act(async () => {
      release();
      await Promise.all([first, second]);
      await settle();
    });
    assert.equal(reads, 2, `${reads} reads for one in-flight read and two requests behind it`);
    assert.equal(text(container, "names"), "mac-1.sdi-1,mac-1.sdi-2,mac-1.sdi-3", "the list is short of the last device heard");
  });

  test("a caller waiting on the answer gets one that postdates its request", async () => {
    let release!: () => void;
    hold = new Promise<void>((r) => { release = r; });
    const { container } = render(React.createElement(Names, { testId: "names" }));
    await act(async () => { await settle(); });
    server = [device("late-pi")];
    const waited = refreshDevices();
    hold = null;
    await act(async () => {
      release();
      await waited;
    });
    assert.equal(text(container, "names"), "late-pi", "a refresh asked after the change returned before it was read");
  });

  test("consumers mounting together read once, not twice", async () => {
    server = [device("pi-1")];
    const { container } = render(
      React.createElement(React.Fragment, null,
        React.createElement(Names, { testId: "a" }),
        React.createElement(Names, { testId: "b" }),
        React.createElement(Count, { testId: "n" })),
    );
    await act(async () => { await settle(); await settle(); });
    assert.equal(reads, 1, `${reads} reads for three consumers mounting at once`);
    assert.equal(text(container, "n"), "1");
  });
});

describe("who a frame reaches", () => {
  test("a consumer that stays still hears the frame after another one unmounted", async () => {
    server = [];
    const first = render(React.createElement(Count, { testId: "count-1" }));
    const second = render(React.createElement(Count, { testId: "count-2" }));
    await act(async () => { await settle(); });
    first.unmount();
    server = [device("pi-9")];
    await push();
    await eventually(() => assert.equal(text(second.container, "count-2"), "1", "the remaining consumer was unsubscribed by the other's cleanup"));
  });
});

describe("a read that fails", () => {
  test("keeps the last good count, and says so on /log once per run of failures", async () => {
    server = [device("pi-1"), device("pi-2")];
    const { container } = render(React.createElement(Count, { testId: "n" }));
    await eventually(() => assert.equal(text(container, "n"), "2"));
    const lines = () => fetchStub.logs.filter((l) => l.tag === "screens" && l.message.includes("devices heard on the network"));
    assert.equal(lines().length, 0);

    failReads = true;
    await push();
    await push();
    await push();
    await eventually(() => assert.equal(lines().length, 1, `${lines().length} lines for one run of failures`));
    assert.equal(text(container, "n"), "2", "a failed read dropped the count");
    assert.match(lines()[0].message, /could not read the devices heard on the network: fetch failed/);

    // It recovers, then fails afresh: a second run, a second line.
    failReads = false;
    server = [device("pi-1")];
    await push();
    await eventually(() => assert.equal(text(container, "n"), "1"));
    failReads = true;
    await push();
    await eventually(() => assert.equal(lines().length, 2, "a second run of failures was not reported"));
  });
});
