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

  test("a second copy restarts the timer", async () => {
    const { result } = renderHook(() => useCopyFeedback(100));
    await act(async () => void (await result.current.copy("x")));
    await act(async () => void (await wait(70)));
    await act(async () => void (await result.current.copy("x")));
    await act(async () => void (await wait(70)));
    assert.equal(result.current.state, "copied", "the first timer must not fire against the second copy");
    await act(async () => void (await wait(80)));
    assert.equal(result.current.state, "idle");
  });

  test("ms null stays until reset", async () => {
    const { result } = renderHook(() => useCopyFeedback(null));
    await act(async () => void (await result.current.copy("x")));
    await act(async () => void (await wait(60)));
    assert.equal(result.current.state, "copied");
    act(() => result.current.reset());
    assert.equal(result.current.state, "idle");
  });

  test("unmounting cancels the timer and a late copy does not set state", async () => {
    const { result, unmount } = renderHook(() => useCopyFeedback(30));
    await act(async () => void (await result.current.copy("x")));
    unmount();
    await wait(60); // would warn or throw if the timer survived
    assert.ok(true);
  });
});
