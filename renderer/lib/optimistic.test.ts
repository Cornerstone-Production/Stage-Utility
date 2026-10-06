// writeOptimistic's failure toast: the server's message, without the "Error: "
// that String(err) puts in front of a real Error. Every toast in the operator app
// that names a failed write goes through errorMessage() for the same reason.

import assert from "node:assert/strict";
import { afterEach, describe, mock, test } from "node:test";

import { QueryClient } from "@tanstack/react-query";

import { toast } from "../components/ui/toast.js";
import { writeOptimistic } from "./optimistic.js";

afterEach(() => mock.restoreAll());

describe("writeOptimistic failure toast", () => {
  test("names the failure by its message alone, after the caller's prefix", async () => {
    const errorSpy = mock.method(toast, "error", () => {});
    const queryClient = new QueryClient();
    queryClient.setQueryData(["k"], { n: 1 });

    const result = await writeOptimistic<{ n: number }>(
      queryClient,
      ["k"],
      () => ({ n: 2 }),
      () => Promise.reject(new Error("the server said no")),
      "Failed to save",
    );

    assert.equal(result, null);
    assert.deepEqual(queryClient.getQueryData(["k"]), { n: 1 }, "the refused write is rolled back");
    assert.deepEqual(errorSpy.mock.calls.map((c) => c.arguments[0]), ["Failed to save: the server said no"]);
  });
});
