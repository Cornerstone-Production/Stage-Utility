// unclaimed-screens-scan.test.tsx — the Screens page's "Not set up yet" list,
// when the scan it holds open cannot be started.
//
// The section renders nothing until a device is heard, so a scan that never
// started looked exactly like a network with nothing on it. Driven through the
// real component with a stubbed fetch. No DOM node is passed as an assert
// operand (see recent-services-reads.test.tsx for why).

import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";

import { installRenderDom, settle, unmountAndTeardown } from "../../test-dom.js";
import { alerts, ok, stubFetchWithLog } from "../../test-fixtures/fetch-log.js";

const teardown = installRenderDom();

const { render, cleanup } = await import("@testing-library/react");
const React = await import("react");
const { UnclaimedScreens } = await import("./unclaimed-screens.js");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => cleanup());

const NOTHING_HEARD = { scanning: false, seen: [], matches: {}, bound: [] };

test("a scan that cannot start says so, rather than reading as an empty network", async () => {
  const f = stubFetchWithLog((url) => {
    if (url.endsWith("/api/devices/scan")) throw new TypeError("fetch failed");
    return ok(NOTHING_HEARD);
  });
  try {
    render(React.createElement(UnclaimedScreens, { outputs: [] }));
    await settle();
    await settle();
    assert.match(alerts(), /Couldn't look for screens on the network/, `no error shown: "${alerts()}"`);
    assert.ok(
      f.logs.some((l) => l.tag === "screens" && l.message.includes("scan")),
      `the failure never reached /log: ${JSON.stringify(f.logs)}`,
    );
  } finally {
    f.restore();
  }
});

test("a scan that starts shows nothing while nothing has been heard", async () => {
  const f = stubFetchWithLog(() => ok(NOTHING_HEARD));
  try {
    render(React.createElement(UnclaimedScreens, { outputs: [] }));
    await settle();
    await settle();
    assert.equal(alerts(), "");
  } finally {
    f.restore();
  }
});
