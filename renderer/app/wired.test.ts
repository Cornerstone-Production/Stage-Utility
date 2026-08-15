import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// reachable.test.ts asks whether every settings SECTION is routed. This asks a
// different question that the audit showed nothing was asking: is each behaviour
// the shell promises actually WIRED UP?
//
// Both gaps the audit found were of this shape. `withViewTransition` was written,
// tested by eye, listed as "carried" in two consecutive phase plans — and
// imported by nothing, so navigation never crossfaded. Reset-on-re-select was
// listed as carried in both plans too, and the rail simply called navigate() to
// the path it was already on, which is a no-op.
//
// Neither failed anything. The module existed, the helper worked in isolation,
// and the plan said it was done. So this asserts the CONNECTION — a named helper
// is imported by a file that is itself reachable — rather than that the helper
// exists.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RENDERER = path.join(HERE, "..");

/** Behaviours the shell promises, and the module that must be using each. */
const WIRING: { what: string; helper: string; usedBy: string }[] = [
  {
    what: "crossfade between destinations",
    helper: "withViewTransition",
    usedBy: "app/rail.tsx",
  },
  {
    what: "re-selecting the active rail item resets that route",
    helper: "resetCurrentRoute",
    usedBy: "app/rail.tsx",
  },
  {
    what: "the shell remounts route content when reset is asked for",
    helper: "useRouteResetKey",
    usedBy: "app/shell.tsx",
  },
  {
    what: "the church's accent colour is applied",
    helper: "applyAccentVar",
    usedBy: "app/live-wiring.ts",
  },
];

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ")
    .replace(/\s\/\/[^\n"'`]*$/gm, " ");
}

function sourceOf(rel: string): string {
  const full = path.join(RENDERER, rel);
  return stripComments(readFileSync(full, "utf8"));
}

describe("shell behaviours are wired, not merely written", () => {
  for (const { what, helper, usedBy } of WIRING) {
    test(`${what} — ${helper} is used by ${usedBy}`, () => {
      const src = sourceOf(usedBy);
      // Imported AND called. An import alone is how an unused helper survives a
      // lint pass in a file that has other reasons to exist.
      assert.match(src, new RegExp(`\\b${helper}\\b`), `${usedBy} does not reference ${helper}`);
      assert.match(
        src,
        new RegExp(`${helper}\\s*\\(`),
        `${usedBy} imports ${helper} but never calls it — the behaviour is still not wired`,
      );
    });
  }

  test("no module under lib/ is imported by nothing", () => {
    // The shape of the withViewTransition bug, generalised: a helper written for
    // a feature, then never hooked up. Comments are stripped so a mention in
    // prose cannot satisfy it — the exact failure reachable.test.ts already hit.
    const libDir = path.join(RENDERER, "lib");
    const modules = readdirSync(libDir)
      .filter((f) => /\.tsx?$/.test(f) && !f.endsWith(".test.ts") && !f.endsWith(".test.tsx"))
      .map((f) => f.replace(/\.tsx?$/, ""));
    assert.ok(modules.length > 5, `only found ${modules.length} lib modules — this scan is broken`);

    const all: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "node_modules") continue;
          walk(full);
        } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
          all.push(full);
        }
      }
    };
    walk(RENDERER);

    // Entry points loaded by URL rather than imported. Each needs a reason, and
    // the test below proves the reason is still true - an exemption nobody
    // re-checks is how the next real orphan hides.
    const BY_URL = new Map([
      ["sse-shared-worker", "a SharedWorker entry point: new SharedWorker(new URL(...)), never imported"],
    ]);

    const orphans: string[] = [];
    for (const mod of modules) {
      if (BY_URL.has(mod)) {
        assert.ok(
          all.some((f) => new RegExp(`new URL\\(["'][^"']*${mod}`).test(readFileSync(f, "utf8"))),
          `${mod} is exempted as a URL-loaded entry point, but nothing loads it by URL any more`,
        );
        continue;
      }
      const importers = all.filter((f) => {
        if (path.basename(f).replace(/\.tsx?$/, "") === mod && path.dirname(f) === libDir) return false;
        return new RegExp(`from\\s+["'][^"']*\\b${mod}["']`).test(stripComments(readFileSync(f, "utf8")));
      });
      if (importers.length === 0) orphans.push(`lib/${mod}`);
    }

    assert.deepEqual(
      orphans,
      [],
      `these modules are imported by nothing — wire them up or delete them:\n    ${orphans.join("\n    ")}`,
    );
  });
});
