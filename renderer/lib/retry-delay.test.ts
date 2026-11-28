import assert from "node:assert/strict";
import { test } from "node:test";

import { nextRetryDelay } from "./retry-delay.js";

test("starts at first, doubles, and stops at max", () => {
  const seen: number[] = [];
  let d = 0;
  for (let i = 0; i < 6; i++) seen.push((d = nextRetryDelay(d, 2000, 30_000)));
  assert.deepEqual(seen, [2000, 4000, 8000, 16_000, 30_000, 30_000]);
});
