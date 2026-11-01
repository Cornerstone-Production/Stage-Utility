import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SNOOZE_KEY } from "@main/types/home-snoozes";
import { attentionKey } from "./types.js";

describe("attentionKey", () => {
  it("leaves a clean subject exactly as it is", () => {
    assert.equal(attentionKey("screen-offline", "display-1"), "screen-offline:display-1");
    assert.equal(attentionKey("wireless-battery", "rx::3"), "wireless-battery:rx::3");
  });

  it("two subjects that differ only in a replaced character stay two keys", () => {
    const a = attentionKey("screen-offline", "a b");
    const b = attentionKey("screen-offline", "a_b");
    assert.notEqual(a, b);
    assert.notEqual(attentionKey("x", "a b"), attentionKey("x", "a/b"));
  });

  it("two long subjects sharing their first 100 characters stay two keys", () => {
    const base = "k".repeat(100);
    assert.notEqual(attentionKey("x", `${base}1`), attentionKey("x", `${base}2`));
  });

  it("is deterministic, and every key it makes is one the server accepts", () => {
    for (const subject of ["a b", "é ü", "x".repeat(500), "a/b/c", "ok", "ok ".repeat(60)]) {
      const key = attentionKey("integration-down", subject);
      assert.equal(key, attentionKey("integration-down", subject));
      assert.ok(SNOOZE_KEY.test(key), `${key.length}: ${key}`);
    }
  });
});
