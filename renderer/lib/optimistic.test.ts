// writeOptimistic's failure toast: the server's message, without the "Error: "
// that String(err) puts in front of a real Error. Every toast in the operator app
// that names a failed write goes through errorMessage() for the same reason.

import assert from "node:assert/strict";
import { afterEach, describe, mock, test } from "node:test";

import { QueryClient } from "@tanstack/react-query";

import { toast } from "../components/ui/toast.js";
import { writeOptimistic, writeTo } from "./optimistic.js";

afterEach(() => mock.restoreAll());

/** What reached the server's client-log route: the browser never reads /log, so a
 *  refused write that only toasted leaves nothing to find the next morning. */
function captureLog(): { tag: string; message: string }[] {
  const lines: { tag: string; message: string }[] = [];
  mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    if (url === "/api/log/client") lines.push(JSON.parse(String(init?.body)));
    return new Response("{}");
  });
  return lines;
}

describe("writeOptimistic failure toast", () => {
  test("names the failure by its message alone, after the caller's prefix", async () => {
    const errorSpy = mock.method(toast, "error", () => {});
    const logged = captureLog();
    const queryClient = new QueryClient();
    queryClient.setQueryData(["k"], { n: 1 });

    const result = await writeOptimistic<{ n: number }>(
      queryClient,
      ["k"],
      () => ({ n: 2 }),
      () => Promise.reject(new Error("the server said no")),
      { tag: "settings", fail: "Failed to save" },
    );

    assert.equal(result, null);
    assert.deepEqual(queryClient.getQueryData(["k"]), { n: 1 }, "the refused write is rolled back");
    assert.deepEqual(errorSpy.mock.calls.map((c) => c.arguments[0]), ["Failed to save: the server said no"]);
    assert.deepEqual(logged, [{ tag: "settings", message: "Failed to save: the server said no" }], "the refusal reached /log");
  });

  test("with no prefix, the log line still says which write was refused", async () => {
    mock.method(toast, "error", () => {});
    const logged = captureLog();
    const queryClient = new QueryClient();

    await writeOptimistic<number>(queryClient, ["stage:getState"], (n) => n, () => Promise.reject(new Error("no")), { tag: "screens" });

    assert.deepEqual(logged, [{ tag: "screens", message: "write to stage:getState refused: no" }]);
  });
});

describe("writeTo failure", () => {
  test("toasts the prefixed message and logs it on the caller's tag", async () => {
    const errorSpy = mock.method(toast, "error", () => {});
    const logged = captureLog();

    const result = await writeTo(new QueryClient(), ["k"], () => Promise.reject(new Error("read-only")), { tag: "branding", fail: "Failed to update branding" });

    assert.equal(result, null);
    assert.deepEqual(errorSpy.mock.calls.map((c) => c.arguments[0]), ["Failed to update branding: read-only"]);
    assert.deepEqual(logged, [{ tag: "branding", message: "Failed to update branding: read-only" }]);
  });
});
