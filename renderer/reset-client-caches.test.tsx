// resetClientCaches must clear BOTH module-level caches the renderer keeps: the
// stage state and the SSE replay cache. Each case below leaves one of them warm,
// proves it is warm (so the case cannot pass by there being nothing to clear), then
// resets and proves it is cold. Removing either reset from resetClientCaches turns
// the matching case red.

import { strict as assert } from "node:assert";
import { after, afterEach, describe, test } from "node:test";

import { act } from "react";

import { eventually, installRenderDom, resetClientCaches, settle, unmountAndTeardown } from "./test-dom.js";
import { FakeEventSource } from "./test-fixtures/fake-event-source.js";

const teardown = installRenderDom();
(globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;
// The stage state's hydrate read: any answer will do, a broadcast is what the cases push.
globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "{}" })) as unknown as typeof fetch;

const { render, cleanup } = await import("@testing-library/react");
const React = await import("react");
const { onNotification } = await import("./lib/api.js");
const { useStageState } = await import("./main/use-stage-state.js");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => cleanup());

type Seen = { loading: boolean; appName: string | null };

/** Reports what it was handed on every committed render, the first one included. */
function Probe({ onRender }: { onRender: (seen: Seen) => void }) {
  const { state, isLoading } = useStageState();
  const appName = (state as { appName?: string } | null)?.appName ?? null;
  React.useEffect(() => {
    onRender({ loading: isLoading, appName });
  });
  return null;
}

/** Mount a consumer and report what its first render was handed: what a consumer mounting RIGHT NOW reads. */
function mountFirstRender(): Seen {
  const seen: Seen[] = [];
  render(React.createElement(Probe, { onRender: (s) => seen.push(s) })).unmount();
  return seen[0];
}

/** Subscribe to a hydrated channel and report whether the first delivery was a replay. */
async function firstDeliveryReplayed(channel: string): Promise<boolean | null> {
  let replayed: boolean | null = null;
  const off = onNotification(channel, (_payload, wasReplayed) => {
    replayed ??= wasReplayed;
  });
  await settle();
  off();
  return replayed;
}

describe("resetClientCaches", () => {
  test("clears the stage state", async () => {
    // One consumer stays mounted to receive the broadcast.
    let latest: string | null = null;
    const first = render(React.createElement(Probe, { onRender: (seen) => (latest = seen.appName) }));
    await settle();
    await act(async () => FakeEventSource.last!.push("stage:state-changed", { appName: "Chapel" }));
    await eventually(() => assert.equal(latest, "Chapel"));
    first.unmount();

    // Warm: a consumer mounting now reads the state with nothing left to wait for.
    assert.deepEqual(mountFirstRender(), { loading: false, appName: "Chapel" });

    await resetClientCaches();
    assert.deepEqual(mountFirstRender(), { loading: true, appName: null }, "the stage state survived the reset");
  });

  test("clears the SSE replay cache", async () => {
    const channel = "pvp:status";
    const off = onNotification(channel, () => {});
    await settle();
    await act(async () => FakeEventSource.last!.push(channel, { layers: 3 }));
    off();

    // Warm: the next subscriber is handed the cached frame as a replay.
    assert.equal(await firstDeliveryReplayed(channel), true, "the frame was never cached, so the reset has nothing to prove");

    await resetClientCaches();
    assert.equal(await firstDeliveryReplayed(channel), null, "a frame from the last case was replayed after the reset");
  });
});
