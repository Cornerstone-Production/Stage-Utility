// Registries the server looks up with a key it did not author.
//
// The bug: a plain object inherits Object.prototype, so `TABLE["constructor"]`,
// `TABLE["__proto__"]`, `TABLE["valueOf"]` and `TABLE["toString"]` all answer
// with a TRUTHY member, and the `if (!def) return` under the lookup reads it as
// a registered entry. Measured on the real modules before the fix: a rules file
// carrying `id: "constructor"` on a condition made firstFailingCondition throw
// `def.holds is not a function`, on a path that runs inside a fire-and-forget
// `void`, which on Node's default is the server exiting mid-service.
//
// Everything here probes the REAL exports or drives the REAL function — never
// source text. A table that stops being externKeyed() fails this file whatever
// its source says.
//
// Counts are EXACT. A floor is how a table added later joins the codebase
// uncovered; an exact count forces a decision about where its keys come from.
// The renderer's wrapped tables are in renderer/main/extern-keyed-tables.test.ts.

import assert from "node:assert/strict";
import { describe, it, after } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-extern-keyed-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { externKeyed } = await import("./extern-keyed.js");
const { CAPABILITIES, hasCapability } = await import("./object-capabilities.js");
const { LEGACY_TRANSLUCENT_GROUNDS, opaqueGroundFor } = await import("./readout-types.js");
const { KIND_DRAWS_TOP_BAR } = await import("./views.js");
const { AUTOMATION_ACTIONS } = await import("../services/automation-actions.js");
const { AUTOMATION_CONDITIONS, firstFailingCondition } = await import(
  "../services/automation-conditions.js"
);
const { AUTOMATION_TRIGGERS } = await import("../services/automation-triggers.js");
const { PVP_ACTIONS } = await import("../services/pvp-actions.js");
const { ROSSTALK_COMMANDS, formatCommand } = await import("../services/rosstalk-commands.js");
const { invokeAction } = await import("../services/action-invoke.js");
const { defaultViewName } = await import("../services/layout-clone.js");
const { summarizeChangelog } = await import("../services/changelog.js");
const imageFiles = await import("../services/image-files.js");
const layoutImages = await import("../services/layout-image-store.js");

after(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

/** The names JavaScript hands back for free on any object with a prototype. */
const INHERITED = [
  "constructor",
  "__proto__",
  "valueOf",
  "toString",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
];

/** Every wrapped table the server EXPORTS, under the name it has in its module. */
const EXPORTED: Record<string, object> = {
  AUTOMATION_CONDITIONS,
  AUTOMATION_ACTIONS,
  AUTOMATION_TRIGGERS,
  PVP_ACTIONS,
  ROSSTALK_COMMANDS,
  CAPABILITIES,
  LEGACY_TRANSLUCENT_GROUNDS,
  KIND_DRAWS_TOP_BAR,
};

describe("server tables keyed from outside this process", () => {
  it("covers exactly the exported ones", () => {
    // Not a floor. Change this only alongside the list above, having decided
    // whether the new table's keys arrive off disk, off HTTP or off the LAN.
    assert.equal(Object.keys(EXPORTED).length, 8);
  });

  for (const [name, table] of Object.entries(EXPORTED)) {
    it(`${name} answers nothing for an inherited member name`, () => {
      const t = table as Record<string, unknown>;
      for (const key of INHERITED) {
        assert.equal(
          t[key],
          undefined,
          `${name}["${key}"] answered with a prototype member, which every ` +
            "`if (!def)` guard downstream reads as a registered entry",
        );
        assert.equal(key in t, false, `"${key}" in ${name} — an \`in\` test passes on it`);
      }
    });

    it(`${name} still answers for its own keys`, () => {
      // So the case above cannot pass by the table being empty or broken.
      const keys = Object.keys(table);
      assert.ok(keys.length > 0, `${name} has no entries at all`);
      for (const k of keys) {
        assert.notEqual(
          (table as Record<string, unknown>)[k],
          undefined,
          `${name}["${k}"] vanished`,
        );
      }
    });
  }
});

// Driven through the function that does the lookup rather than by reading the
// table — the better test either way: it asserts the answer the caller gets.
// The four module-private tables (DEFAULT_VIEW_NAMES, image-files MIME_BY_EXT,
// layout-image-store MIME_BY_EXT, SCOPE_LABELS) have no other coverage, so each
// one has a case below and is named in its comment.
describe("server tables keyed from outside, reached through their callers", () => {
  it("a condition id that is a prototype member is REFUSED, not called", () => {
    // The crash this whole change exists for. Before: TypeError, def.holds is
    // not a function. After: the id comes back as the condition that failed,
    // which is how an unknown id has always been reported.
    const ctx = {
      pcoLive: null,
      pcoConfigured: false,
      serviceTypeId: null,
      integrations: {},
      obsRecording: false,
      reaperRecording: false,
      resiStreaming: false,
      youtubeStreaming: false,
      baptismPhase: null,
      pvpLayers: null,
    };
    for (const id of INHERITED) {
      assert.equal(
        firstFailingCondition([{ id, params: {} }], ctx, Date.now()),
        id,
        `a condition id of "${id}" did not fail closed`,
      );
    }
    // And a real condition still evaluates, so this is not passing by refusing
    // everything.
    assert.equal(firstFailingCondition([{ id: "time.day-of-week", params: {} }], ctx, 0), null);
  });

  it("an action id that is a prototype member reports UNKNOWN, not a provider error", async () => {
    for (const id of INHERITED) {
      const r = await invokeAction(id, {});
      assert.equal(r.ok, false);
      assert.equal(
        r.detail,
        `unknown action "${id}"`,
        `invoking "${id}" reported ${JSON.stringify(r.detail)} instead of "unknown action"`,
      );
    }
  });

  it("a RossTalk commandId that is a prototype member reports UNKNOWN COMMAND", () => {
    for (const id of INHERITED) {
      assert.throws(
        () => formatCommand(id, {}),
        new RegExp(`unknown command "${id.replace(/[$]/g, "\\$&")}"`),
        `formatCommand("${id}") did not report an unknown command`,
      );
    }
    // A real one still formats.
    assert.equal(formatCommand("cc", { bank: 1, cc: 2 }), "CC 1:02");
  });

  it("a view kind that is a prototype member gets the fallback NAME", () => {
    // DEFAULT_VIEW_NAMES. The comment on defaultViewName already said the kind
    // "reaches here from a request body and from views.json"; the `?? "View"`
    // never fired for these because a function is not nullish.
    for (const kind of INHERITED) {
      assert.equal(
        defaultViewName(kind as never),
        "View",
        `defaultViewName("${kind}") did not fall back`,
      );
    }
    assert.equal(defaultViewName("slots"), "Slots");
  });

  it("an object type that is a prototype member has no capabilities", () => {
    // CAPABILITIES, through hasCapability — `CAPABILITIES[type]?.includes(cap)`
    // threw `includes is not a function` on a layout object typed "constructor".
    for (const type of INHERITED) {
      assert.equal(hasCapability(type as never, "control"), false, `${type} claimed control`);
    }
    assert.equal(hasCapability("osc-button" as never, "control"), true);
  });

  it("a background that is a prototype member has no legacy ground", () => {
    for (const bg of INHERITED) {
      assert.equal(opaqueGroundFor(bg), null, `opaqueGroundFor("${bg}") answered with something`);
    }
    assert.equal(opaqueGroundFor("rgba(255,255,255,0.04)"), "#141414");
  });

  it("a commit scope that is a prototype member prints as itself", () => {
    // SCOPE_LABELS. Scopes come off a GitHub release body, so they are not ours.
    for (const scope of INHERITED) {
      const [line] = summarizeChangelog([`fix(${scope}): a thing that changed`]);
      assert.equal(
        line,
        `${scope} — a thing that changed`,
        `a "${scope}" scope rendered as ${JSON.stringify(line)}`,
      );
    }
  });

  it("a stored image whose extension is a prototype member is not served", async () => {
    // image-files MIME_BY_EXT. The file is PLANTED first: without it both
    // answers are null and the case would pass on the missing file rather than
    // on the lookup.
    const d = path.join(TMP, "branding-images");
    await fs.mkdir(d, { recursive: true });
    await fs.writeFile(path.join(d, "planted.constructor"), Buffer.from("not an image"));
    await fs.writeFile(path.join(d, "planted.png"), Buffer.from("pretend png"));
    assert.equal(await imageFiles.readImage("branding-images", "planted.constructor"), null);
    // The planted control: a real extension IS served, so the case above is
    // about the lookup and not about the directory.
    assert.equal(
      (await imageFiles.readImage("branding-images", "planted.png"))?.mime,
      "image/png",
    );
  });

  it("an archive entry whose extension is a prototype member is not written", async () => {
    // Same table, the write side. `if (!MIME_BY_EXT[ext]) return false` is the
    // extension allowlist a restore bundle has to clear.
    assert.equal(
      await imageFiles.restoreImage("branding-images", "evil.constructor", Buffer.from("x")),
      false,
    );
    await assert.rejects(fs.stat(path.join(TMP, "branding-images", "evil.constructor")));
  });

  it("a layout image whose extension is a prototype member is not served", async () => {
    // layout-image-store MIME_BY_EXT. Its name filter is /^[a-f0-9]{16}\.[a-z]+$/
    // — and "constructor" is [a-z]+.
    const d = path.join(TMP, "layout-images");
    await fs.mkdir(d, { recursive: true });
    await fs.writeFile(path.join(d, "0123456789abcdef.constructor"), Buffer.from("x"));
    await fs.writeFile(path.join(d, "0123456789abcdef.png"), Buffer.from("x"));
    assert.equal(await layoutImages.readLayoutImage("0123456789abcdef.constructor"), null);
    assert.equal(
      (await layoutImages.readLayoutImage("0123456789abcdef.png"))?.mime,
      "image/png",
    );
  });
});

describe("externKeyed", () => {
  it("copies the entries and drops the prototype", () => {
    const t = externKeyed({ a: 1, b: 2 });
    assert.equal(t.a, 1);
    assert.equal(t.b, 2);
    assert.deepEqual(Object.keys(t), ["a", "b"]);
    assert.equal(Object.getPrototypeOf(t), null);
  });

  it("leaves iteration, spread and JSON exactly as they were", () => {
    // This is why these are null-prototype records rather than Maps: call sites
    // in files outside this change iterate the tables with Object.values, which
    // a Map would answer [] for.
    const t = externKeyed({ a: 1, b: 2 });
    assert.deepEqual(Object.values(t), [1, 2]);
    assert.deepEqual(Object.entries(t), [
      ["a", 1],
      ["b", 2],
    ]);
    assert.deepEqual({ ...t }, { a: 1, b: 2 });
    assert.equal(JSON.stringify(t), '{"a":1,"b":2}');
  });

  it("does not copy anything off the source literal's own prototype", () => {
    assert.equal((externKeyed({ a: 1 }) as Record<string, unknown>).toString, undefined);
  });
});
