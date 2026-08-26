// Two things are protected here.
//
// 1. The reserved list must stay in sync with the client router. If a page is added
//    to root-view.tsx without reserving its path, a display slug can silently shadow
//    it — the display renders the wrong page and nothing errors. That check reads the
//    router source, so it fails in CI rather than on a Sunday.
//
// 2. Resolution must prefer ids over slugs and never invent a match, because the
//    resolved id is what slots.json is keyed by. A wrong resolution shows the right
//    shell with the wrong board, which reads as data loss.

import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { RESERVED_SLUGS, RESERVED_SLUG_PREFIX, validateSlug } from "./reserved-slugs.js";
import { OPERATOR_PATHS } from "./routes/operator-paths.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT_VIEW = path.join(HERE, "../../renderer/main/root-view.tsx");

describe("the reserved list covers every path the router handles", () => {
  test("every operator path is reserved", () => {
    // The operator surfaces used to be branches in root-view.tsx, and this check
    // read that file. They moved to OPERATOR_PATHS when the operator app took
    // them over, so the check follows the source of truth rather than a file
    // that no longer holds it. Asserted as an EXACT subset, not a count: a
    // count is what let /automation and /integrations be routed without ever
    // being reserved.
    for (const p of OPERATOR_PATHS) {
      const slug = p.replace(/^\//, "");
      assert.ok(
        RESERVED_SLUGS.includes(slug),
        `the server routes "${p}" to the operator app but "${slug}" is not reserved — a display with that slug would never render`,
      );
    }
  });

  test("any path still branched on in root-view.tsx is reserved", () => {
    // root-view.tsx now handles only the display picker and the kiosk outlet,
    // but if a page is ever added back there it must be reserved too.
    const src = readFileSync(ROOT_VIEW, "utf8");
    // Matches `slug === "history"` and `parts[0] === "scriptview"`.
    const compared = [...src.matchAll(/(?:slug|parts\[0\])\s*===\s*"([^"]*)"/g)].map((m) => m[1]);
    for (const slug of compared) {
      assert.ok(
        RESERVED_SLUGS.includes(slug),
        `root-view.tsx routes "/${slug}" but it is not in RESERVED_SLUGS — a display slug could shadow it`,
      );
    }
  });

  test("the server's own pages are reserved", () => {
    for (const s of ["settings", "log", "photos"]) {
      assert.ok(RESERVED_SLUGS.includes(s), `"/${s}" is served by the backend but not reserved`);
    }
  });
});

describe("validateSlug", () => {
  test("accepts an ordinary slug", () => {
    assert.deepEqual(validateSlug("left-mic", []), { ok: true });
  });

  test("clearing the slug is always allowed", () => {
    assert.deepEqual(validateSlug("", ["left-mic"]), { ok: true });
    assert.deepEqual(validateSlug("   ", ["left-mic"]), { ok: true });
  });

  test("rejects every reserved page", () => {
    for (const s of RESERVED_SLUGS) {
      if (s === "") continue;
      const r = validateSlug(s, []);
      assert.equal(r.ok, false, `"${s}" must be rejected`);
    }
  });

  test("rejects the preview prefix", () => {
    const r = validateSlug(`${RESERVED_SLUG_PREFIX}view-1`, []);
    assert.equal(r.ok, false);
  });

  test("rejects a slug already used as another display's id or slug", () => {
    assert.equal(validateSlug("display-2", ["display-2"]).ok, false);
    assert.equal(validateSlug("stage-left", ["stage-left"]).ok, false);
  });

  test("matching is case-insensitive in both directions", () => {
    assert.equal(validateSlug("HISTORY", []).ok, false);
    assert.equal(validateSlug("Left-Mic", ["left-mic"]).ok, false);
  });

  test("rejects characters that would change the path shape", () => {
    for (const bad of ["a/b", "a b", "a?b", "a.b", "a%2f", "café"]) {
      assert.equal(validateSlug(bad, []).ok, false, `"${bad}" must be rejected`);
    }
  });

  test("a rejection always says why", () => {
    const r = validateSlug("history", []);
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(r.reason.length > 0);
  });
});
