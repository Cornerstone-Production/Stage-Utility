import { strict as assert } from "node:assert";
import { after, beforeEach, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

const { act, cleanup, renderHook } = await import("@testing-library/react");
const { useCopyFeedback } = await import("./use-copy-feedback.js");

after(() => teardown());

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function clipboard(result: "ok" | "reject") {
  Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: () => (result === "ok" ? Promise.resolve() : Promise.reject(new Error("no"))) },
  });
  // The legacy path must not rescue a refused write in these tests.
  document.execCommand = () => false;
}

describe("useCopyFeedback", () => {
  beforeEach(() => {
    cleanup();
    clipboard("ok");
  });

  test("copied, then back to idle after the duration", async () => {
    const { result } = renderHook(() => useCopyFeedback(60));
    await act(async () => void (await result.current.copy("x")));
    assert.equal(result.current.state, "copied");
    await act(async () => void (await wait(110)));
    assert.equal(result.current.state, "idle");
  });

  test("a refused copy reads failed", async () => {
    clipboard("reject");
    const { result } = renderHook(() => useCopyFeedback(60));
    let ok = true;
    await act(async () => void (ok = await result.current.copy("x")));
    assert.equal(ok, false);
    assert.equal(result.current.state, "failed");
  });

  // On a mocked clock: with real waits, a loaded machine that ran the second 70 ms wait 30 ms late let the
  // second copy's own timer fire, and the test read that as the first one. The other cases' real waits only
  // ever run long, which they allow.
  test("a second copy restarts the timer", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { result } = renderHook(() => useCopyFeedback(100));
    await act(async () => void (await result.current.copy("x")));
    act(() => t.mock.timers.tick(70));
    await act(async () => void (await result.current.copy("x")));
    act(() => t.mock.timers.tick(99));
    assert.equal(result.current.state, "copied", "the first timer must not fire against the second copy");
    act(() => t.mock.timers.tick(1));
    assert.equal(result.current.state, "idle", "the second copy's timer runs its full duration and no longer");
  });

  test("ms null stays until reset", async () => {
    const { result } = renderHook(() => useCopyFeedback(null));
    await act(async () => void (await result.current.copy("x")));
    await act(async () => void (await wait(60)));
    assert.equal(result.current.state, "copied");
    act(() => result.current.reset());
    assert.equal(result.current.state, "idle");
  });

  describe("unmounting", () => {
    // Every timer the hook sets and has not cleared or seen fire.
    const pending = new Set<unknown>();
    const realSet = globalThis.setTimeout;
    const realClear = globalThis.clearTimeout;
    beforeEach(() => {
      pending.clear();
      globalThis.setTimeout = ((fn: () => void, ms?: number) => {
        const h = realSet(() => {
          pending.delete(h);
          fn();
        }, ms);
        pending.add(h);
        return h;
      }) as typeof setTimeout;
      globalThis.clearTimeout = ((h: Parameters<typeof clearTimeout>[0]) => {
        pending.delete(h);
        realClear(h);
      }) as typeof clearTimeout;
    });
    after(() => {
      globalThis.setTimeout = realSet;
      globalThis.clearTimeout = realClear;
    });

    test("cancels the timer a finished copy left running", async () => {
      const { result, unmount } = renderHook(() => useCopyFeedback(5_000));
      await act(async () => void (await result.current.copy("x")));
      assert.equal(pending.size, 1, "a copy starts one timer");
      unmount();
      assert.equal(pending.size, 0, "unmounting must clear it");
    });

    test("a copy that resolves after unmount sets no state and starts no timer", async () => {
      let resolveWrite!: () => void;
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: () => new Promise<void>((r) => (resolveWrite = r)) },
      });
      const { result, unmount } = renderHook(() => useCopyFeedback(5_000));
      const late = result.current.copy("x");
      unmount();
      resolveWrite();
      assert.equal(await late, true, "the copy itself still reports what happened");
      assert.equal(pending.size, 0, "a late copy must not schedule a timer on an unmounted card");
    });
  });
});
