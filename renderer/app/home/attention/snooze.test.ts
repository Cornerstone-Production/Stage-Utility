import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { HomeSnooze } from "@main/types/home-snoozes";
import { partitionSnoozed, snoozeCovers } from "./snooze.js";
import type { AttentionItem } from "./types.js";

const item = (key: string, severity: AttentionItem["severity"]): AttentionItem => ({ key, severity, title: key, detail: "", fix: { label: "x" } });
const snooze = (key: string, severity: HomeSnooze["severity"]): HomeSnooze => ({ key, severity, at: 0, expiresAt: null });

describe("snoozes", () => {
  it("hides an item at the severity it was snoozed at, and at a lower one", () => {
    assert.equal(snoozeCovers(snooze("a:b", "warn"), item("a:b", "warn")), true);
    assert.equal(snoozeCovers(snooze("a:b", "critical"), item("a:b", "warn")), true);
    assert.equal(snoozeCovers(snooze("a:b", "critical"), item("a:b", "critical")), true);
  });

  it("a severity RISE un-snoozes: a warn snooze does not hide the same key at critical", () => {
    assert.equal(snoozeCovers(snooze("wireless-battery:ch3", "warn"), item("wireless-battery:ch3", "critical")), false);
  });

  it("an item with no snooze is shown", () => {
    assert.equal(snoozeCovers(undefined, item("a:b", "warn")), false);
  });

  it("partitions by key, keeping order, and a snooze for an item not firing hides nothing", () => {
    const { shown, snoozed } = partitionSnoozed(
      [item("a:1", "warn"), item("a:2", "critical"), item("a:3", "warn")],
      [snooze("a:1", "warn"), snooze("a:2", "warn"), snooze("gone:9", "critical")],
    );
    assert.deepEqual(snoozed.map((i) => i.key), ["a:1"]);
    assert.deepEqual(shown.map((i) => i.key), ["a:2", "a:3"]);
  });
});
