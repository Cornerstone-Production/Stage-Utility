import { strict as assert } from "node:assert";
import { test } from "node:test";

// @ts-expect-error — plain .mjs helper shared with the shell update scripts.
import { compareRevs } from "./manifest-changed.mjs";

/** A fake `git show` over a map of rev -> { file: contents }. */
const reader = (revs: Record<string, Record<string, string>>) =>
  (rev: string, file: string): string | null => revs[rev]?.[file] ?? null;

const pkg = (version: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ name: "stage-utility", version, scripts: { build: "vite build" }, ...extra });

const lock = (version: string, deps: Record<string, unknown> = { "node_modules/vite": { version: "7.0.0" } }) =>
  JSON.stringify({
    name: "stage-utility",
    version,
    lockfileVersion: 3,
    packages: { "": { name: "stage-utility", version }, ...deps },
  });

test("a release's version bump needs neither a reinstall nor a rebuild", () => {
  // The exact shape of `chore(release): vX.Y.Z` — three version strings and
  // nothing else. This is the case that made the skip logic dead code.
  const read = reader({
    a: { "package.json": pkg("1.9.2-beta.1"), "package-lock.json": lock("1.9.2-beta.1") },
    b: { "package.json": pkg("1.9.2-beta.2"), "package-lock.json": lock("1.9.2-beta.2") },
  });
  assert.deepEqual(compareRevs("a", "b", read), { deps: false, manifest: false });
});

test("an added dependency needs a reinstall", () => {
  const read = reader({
    a: { "package.json": pkg("1.0.0"), "package-lock.json": lock("1.0.0") },
    b: {
      "package.json": pkg("1.0.0"),
      "package-lock.json": lock("1.0.0", {
        "node_modules/vite": { version: "7.0.0" },
        "node_modules/left-pad": { version: "1.3.0" },
      }),
    },
  });
  assert.equal(compareRevs("a", "b", read).deps, true);
});

test("an upgraded dependency needs a reinstall", () => {
  const read = reader({
    a: { "package.json": pkg("1.0.0"), "package-lock.json": lock("1.0.0") },
    b: {
      "package.json": pkg("1.0.0"),
      "package-lock.json": lock("1.0.0", { "node_modules/vite": { version: "7.1.0" } }),
    },
  });
  assert.equal(compareRevs("a", "b", read).deps, true, "a dependency's own version still counts");
});

test("a changed build script needs a rebuild but not a reinstall", () => {
  const read = reader({
    a: { "package.json": pkg("1.0.0"), "package-lock.json": lock("1.0.0") },
    b: {
      "package.json": JSON.stringify({ name: "stage-utility", version: "1.0.0", scripts: { build: "vite build --mode x" } }),
      "package-lock.json": lock("1.0.0"),
    },
  });
  assert.deepEqual(compareRevs("a", "b", read), { deps: false, manifest: true });
});

test("a version bump alongside a real dependency change still reinstalls", () => {
  // Both changed at once — the version must not mask the dependency.
  const read = reader({
    a: { "package.json": pkg("1.0.0"), "package-lock.json": lock("1.0.0") },
    b: {
      "package.json": pkg("1.1.0"),
      "package-lock.json": lock("1.1.0", { "node_modules/vite": { version: "8.0.0" } }),
    },
  });
  assert.equal(compareRevs("a", "b", read).deps, true);
});

// ── Failing safe ───────────────────────────────────────────────────────────

test("an unreadable manifest does the work rather than skipping it", () => {
  const read = reader({ a: {}, b: {} });
  assert.deepEqual(compareRevs("a", "b", read), { deps: true, manifest: true });
});

test("unparseable JSON does the work rather than skipping it", () => {
  const read = reader({
    a: { "package.json": "{ not json", "package-lock.json": "{ not json" },
    b: { "package.json": pkg("1.0.0"), "package-lock.json": lock("1.0.0") },
  });
  assert.deepEqual(compareRevs("a", "b", read), { deps: true, manifest: true });
});

test("a missing old revision does the work", () => {
  assert.deepEqual(compareRevs("none", "b", reader({})), { deps: true, manifest: true });
  assert.deepEqual(compareRevs("", "b", reader({})), { deps: true, manifest: true });
});

test("an unchanged revision needs nothing", () => {
  assert.deepEqual(compareRevs("a", "a", reader({})), { deps: false, manifest: false });
});

test("a lockfile without a packages block is still compared", () => {
  // lockfileVersion 1 has no `packages` — deleting packages[""] must not throw.
  const v1 = (version: string, d: string) =>
    JSON.stringify({ name: "x", version, lockfileVersion: 1, dependencies: { vite: { version: d } } });
  const read = reader({
    a: { "package.json": pkg("1.0.0"), "package-lock.json": v1("1.0.0", "7.0.0") },
    b: { "package.json": pkg("1.1.0"), "package-lock.json": v1("1.1.0", "7.0.0") },
  });
  assert.equal(compareRevs("a", "b", read).deps, false, "version-only, even on lockfileVersion 1");
});
