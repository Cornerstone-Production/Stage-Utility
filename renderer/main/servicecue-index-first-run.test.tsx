// servicecue-index-first-run.test.tsx — the launcher's two empty messages are ways
// forward, not dead ends (design review finding 5).
//
// A fresh install's launcher said "Connect Planning Center to use ServiceCue" as plain
// text, and "Choose them on the ServiceCue layouts page, under Landing page" as plain
// text. Each is now a link: to Integrations, and to the layouts page with Landing page
// open. Edit layouts sits centred under a centred message and stays at the left under
// the list.
//
// NOT unit-tested here, and driven in a browser instead (jsdom loads no stylesheet):
// that the message and the link are actually centred, and how it wraps at 390px.
//
// NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND.

import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";

import { FakeEventSource } from "../test-fixtures/fake-event-source.js";
import { eventually, installRenderDom, settle, unmountAndTeardown, resetClientCaches } from "../test-dom.js";
import { ok, stubFetchWithLog } from "../test-fixtures/fetch-log.js";

const teardown = installRenderDom();
(globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;

const { render, screen, cleanup } = await import("@testing-library/react");
const React = await import("react");
const { ServiceCueIndex } = await import("./servicecue-index-view.js");
const { TooltipProvider } = await import("../components/ui/index.js");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(async () => {
  cleanup();
  await resetClientCaches();
});

function stub(setup: { pcoConfigured: boolean; shown: string[] }) {
  return stubFetchWithLog((url) => {
    if (url.includes("/api/state")) return ok({ pcoConfigured: setup.pcoConfigured });
    if (url.includes("/api/service-types")) return ok([{ id: "st1", name: "Weekend" }]);
    if (url.includes("/api/servicecue/layouts")) return ok([]);
    if (url.includes("/api/servicecue/config")) return ok({ serviceTypeIds: setup.shown });
    return ok({});
  });
}
async function mount(): Promise<void> {
  render(React.createElement(TooltipProvider, null, React.createElement(ServiceCueIndex)));
  for (let i = 0; i < 3; i++) await settle();
}
const hrefOf = (name: RegExp) => screen.getByRole("link", { name }).getAttribute("href");

test("Planning Center not connected: Connect Planning Center links to Integrations, and Edit layouts is centred", async () => {
  const f = stub({ pcoConfigured: false, shown: [] });
  try {
    await mount();
    await eventually(() => assert.equal(hrefOf(/^Connect Planning Center$/), "/settings/integrations"));
    assert.match(document.body.textContent ?? "", /Connect Planning Center to use ServiceCue\./);
    assert.match(screen.getByRole("link", { name: "Edit layouts" }).className, /\bself-center\b/);
  } finally {
    f.restore();
  }
});

test("no service types enabled: the sentence links to the layouts page with Landing page open", async () => {
  const f = stub({ pcoConfigured: true, shown: [] });
  try {
    await mount();
    await eventually(() => assert.equal(hrefOf(/^Choose them on the ServiceCue layouts page, under Landing page\.$/), "/servicecue/presets#landing"));
    assert.match(document.body.textContent ?? "", /No service types enabled\. Choose them/);
    assert.match(screen.getByRole("link", { name: "Edit layouts" }).className, /\bself-center\b/);
  } finally {
    f.restore();
  }
});

test("with service types listed, Edit layouts stays at the left and no message links appear", async () => {
  const f = stub({ pcoConfigured: true, shown: ["st1"] });
  try {
    await mount();
    await eventually(() => assert.equal(!!screen.queryByText("Weekend"), true));
    const cls = screen.getByRole("link", { name: "Edit layouts" }).className;
    assert.match(cls, /\bself-start\b/);
    assert.doesNotMatch(cls, /self-center/);
    assert.equal(!!screen.queryByRole("link", { name: /Connect Planning Center/ }), false);
  } finally {
    f.restore();
  }
});

test("while the service types are still loading, Edit layouts is already at the left, so it does not jump when the rows arrive", async () => {
  // The spinner is not a message: the link was centred under it and moved left with the list.
  const real = globalThis.fetch;
  const f = stubFetchWithLog((url) => {
    if (url.includes("/api/state")) return ok({ pcoConfigured: true });
    if (url.includes("/api/service-types")) return new Promise(() => {});
    return ok([]);
  });
  try {
    render(React.createElement(TooltipProvider, null, React.createElement(ServiceCueIndex)));
    for (let i = 0; i < 4; i++) await settle();
    const cls = screen.getByRole("link", { name: "Edit layouts" }).className;
    assert.match(cls, /\bself-start\b/);
    assert.doesNotMatch(cls, /self-center/);
  } finally {
    f.restore();
    globalThis.fetch = real;
  }
});
