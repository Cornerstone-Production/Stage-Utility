// A read that FAILED is not an answer of "none". useStatusChannel settles
// `known` on a failure, so useAttentionInput must also consult `failed`: a
// presence read that times out must not make every routed screen "offline",
// and a failed integrations read must not make the tile say All clear.

import { strict as assert } from "node:assert";
import { after, beforeEach, test } from "node:test";

import { eventually, installDom, settle, unmountAndTeardown } from "../../../test-dom.js";
import { FakeEventSource } from "../../../test-fixtures/fake-event-source.js";

const teardown = installDom();
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;

// Every status read fails; only the client log sink answers.
(globalThis as unknown as { fetch: unknown }).fetch = async (input: RequestInfo | URL) => {
  const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.startsWith("/api/log/client") || url.startsWith("/api/events/subscribe")) return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
  throw new Error(`down: ${url}`);
};

const { render, cleanup } = await import("@testing-library/react");
const React = (await import("react")).default;
const { useAttentionInput } = await import("./use-attention.js");
const { __resetReplayCacheForTests } = await import("../../../lib/api.js");

after(() => unmountAndTeardown(cleanup, teardown));
beforeEach(() => {
  cleanup();
  __resetReplayCacheForTests();
});

test("a failed read leaves each source unknown, not answered-with-nothing", async () => {
  let input: ReturnType<typeof useAttentionInput> | null = null;
  function Probe(): React.ReactElement {
    input = useAttentionInput({ mood: "idle", now: 0, state: { slotsByView: {}, slotsByLayoutObject: {} } as never, pcoLive: null });
    return React.createElement("output", null, "x");
  }
  render(React.createElement(Probe));
  await settle();
  await eventually(() => assert.ok(input));
  await settle();
  const i = input!;
  assert.equal(i.onlineKnown, false, "presence read failed");
  assert.equal(i.wirelessKnown, false, "wireless read failed");
  assert.equal(i.integrationsKnown, false, "integrations read failed");
  assert.equal(i.reaperKnown, false, "reaper read failed");
  assert.equal(i.obsKnown, false, "obs read failed");
});
