import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { formatBytes, type BytesOptions } from "./bytes-format.js";

describe("formatBytes", () => {
  const MiB = 1024 * 1024;
  const rows: [string, number, BytesOptions, string][] = [
    ["nothing", 0, {}, "0 KB"],
    ["a few bytes is never 0 KB", 10, {}, "1 KB"],
    ["kilobytes", 412 * 1024, {}, "412 KB"],
    ["just under a megabyte", MiB - 1, {}, "1024 KB"],
    ["a megabyte", MiB, {}, "1.0 MB"],
    ["one decimal", 3.14 * MiB, {}, "3.1 MB"],
    ["binary, to match the caps written as n * 1024 * 1024", 12 * MiB, {}, "12.0 MB"],
    ["whole, for a limit", 64 * MiB, { whole: true }, "64 MB"],
    ["whole rounds", 25.4 * MiB, { whole: true }, "25 MB"],
    ["decimal, for a vendor's published size", 27_000_000, { whole: true, decimal: true }, "27 MB"],
    ["decimal kilobytes", 412_000, { decimal: true }, "412 KB"],
  ];
  for (const [name, bytes, opts, want] of rows) {
    test(name, () => assert.equal(formatBytes(bytes, opts), want));
  }
});
