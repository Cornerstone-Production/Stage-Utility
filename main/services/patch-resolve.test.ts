// A field an operator can type into, that the override diff does not know about,
// is a field whose edits are silently discarded.
//
// diffEndpoints builds a variant's (or a week's) overrides from CONTENT_FIELDS
// alone. `owner` was absent: typing an ownership band into a variant produced a
// diff of {}, the overrides were written empty, and the text vanished on the
// next render with no error. endpointsEqual reads the same list, so the /patch
// "what changed" highlight missed it too.
//
// The real guard here is the TYPE, below: identity + content must together
// account for every key of PatchEndpoint, so adding a field to the interface
// without classifying it fails the type check rather than waiting to be noticed
// by an operator whose work disappeared.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { PatchEndpoint } from "../types/patch.js";
import { CONTENT_FIELDS, diffEndpoints, endpointsEqual } from "./patch-resolve.js";

/** What identifies an endpoint rather than describing it. Never diffed. */
type IdentityField = "rackId" | "dir" | "index";

// ── The compile-time half ─────────────────────────────────────────────────────
// If PatchEndpoint gains a key that is in neither list, `Unclassified` stops
// being `never` and this assignment fails to compile.
type Unclassified = Exclude<keyof PatchEndpoint, (typeof CONTENT_FIELDS)[number] | IdentityField>;
const _everyFieldIsClassified: Unclassified extends never ? true : never = true;
void _everyFieldIsClassified;

const base = (over: Partial<PatchEndpoint> = {}): PatchEndpoint => ({
  rackId: "rack-1",
  dir: "in",
  index: 1,
  label: "Kick",
  ...over,
});

describe("patch override diffing", () => {
  it("records an owner edit", () => {
    // The exact regression: base has no owner, the operator types one in.
    const diff = diffEndpoints([base({ owner: "338 @ FOH" })], [base()]);
    const only = Object.values(diff)[0];
    assert.ok(only, "an owner edit must produce an override");
    assert.equal(only.owner, "338 @ FOH");
  });

  it("treats an owner change as a content change", () => {
    assert.equal(endpointsEqual(base({ owner: "A" }), base({ owner: "B" })), false);
    assert.equal(endpointsEqual(base({ owner: "A" }), base({ owner: "A" })), true);
  });

  it("still records an edit to every other content field", () => {
    // Field-by-field rather than a spot check, so a future removal from
    // CONTENT_FIELDS fails here and not in production.
    const samples: Partial<Record<(typeof CONTENT_FIELDS)[number], unknown>> = {
      label: "Snare",
      mic: "SM57",
      phantom: true,
      feedType: "wedge",
      consoleChannel: "12",
      path: [{ deviceId: "d1", connector: "1" }],
      unused: true,
      notes: "taped down",
      micSlotRef: "slot-2",
      pcoPosition: "Drums",
      owner: "338 @ FOH",
    };
    for (const field of CONTENT_FIELDS) {
      const diff = diffEndpoints([base({ [field]: samples[field] } as Partial<PatchEndpoint>)], [base({ label: undefined })]);
      const only = Object.values(diff)[0] ?? {};
      assert.ok(field in only, `an edit to "${field}" must survive the diff`);
    }
  });

  it("an unchanged endpoint diffs to nothing", () => {
    assert.deepEqual(diffEndpoints([base()], [base()]), {});
  });
});
