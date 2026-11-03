import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import { thenRefresh } from "./use-home-snoozes.js";

describe("thenRefresh", () => {
  it("a failed re-read does not make a saved snooze read as failed; it is warned", async () => {
    const warn = mock.method(console, "warn", () => {});
    try {
      await thenRefresh(Promise.resolve("saved"), async () => {
        throw new Error("network");
      });
      assert.equal(warn.mock.calls.length, 1);
      assert.match(String(warn.mock.calls[0].arguments[0]), /^\[home\] saved, but re-reading/);
    } finally {
      warn.mock.restore();
    }
  });

  it("the action's own failure still rejects, and the re-read is not attempted", async () => {
    let read = false;
    await assert.rejects(
      thenRefresh(Promise.reject(new Error("disk full")), async () => void (read = true)),
      /disk full/,
    );
    assert.equal(read, false);
  });

  it("refreshes after a success", async () => {
    let read = false;
    await thenRefresh(Promise.resolve(), async () => void (read = true));
    assert.equal(read, true);
  });
});
