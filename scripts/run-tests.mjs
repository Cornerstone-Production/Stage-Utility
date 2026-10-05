#!/usr/bin/env node
// run-tests.mjs — `npm test`. The one place the test file patterns live.
//
// Extra arguments go to Node's test runner ahead of the patterns, which is how CI
// splits the suite across parallel jobs without repeating them:
//
//   npm test                          every test
//   npm test -- --test-shard=2/4      the second quarter of the files
//
// The patterns used to be written out in package.json and nowhere else. A CI job
// running a shard needs them too, and a second copy is how a new test directory
// ends up run locally and silently skipped in CI.

import { spawnSync } from "node:child_process";

const TEST_PATTERNS = [
  "main/**/*.test.ts",
  "renderer/**/*.test.ts",
  "renderer/**/*.test.tsx",
  "scripts/**/*.test.ts",
];

const result = spawnSync(
  process.execPath,
  ["--import", "tsx", "--test", ...process.argv.slice(2), ...TEST_PATTERNS],
  { stdio: "inherit" },
);
if (result.error) {
  console.error(`could not start the test runner: ${result.error.message}`);
  process.exit(1);
}
// A runner killed by a signal has no exit status; that is a failure, not a pass.
process.exit(result.status ?? 1);
