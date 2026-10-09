// pco-path.test.ts — a PCO URL path part can only be one pcoId or pcoSegment made.
//
// The type is what stops a raw id reaching a credentialed URL, so it has to be
// nominal: a class with only a public `value` would accept any `{ value }`
// object. Each case below is checked twice, by the type checker
// (@ts-expect-error fails `npm run type-check` the day the line compiles) and
// at run time, for a cast that gets past the type.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { PcoPathPart, PcoUrlRefused, isPcoAttachmentId, pcoAttachmentId, pcoId, pcoSegment, pcoUrl } from "./pco-path.js";

test("a checked id and segment build the URL", () => {
  assert.equal(
    pcoUrl`/service_types/${pcoId("serviceTypeId", "123")}/${pcoSegment("collection", "note_categories")}`,
    "https://api.planningcenteronline.com/services/v2/service_types/123/note_categories",
  );
});

test("a plain { value } object does not pass for a path part", () => {
  const forged = { value: "1/../../../people/v2/people?x=" };
  // @ts-expect-error a structural look-alike is not a PcoPathPart
  assert.throws(() => pcoUrl`/service_types/${forged}/plans`, PcoUrlRefused);
});

test("a path part cannot be made outside pco-path.ts", () => {
  // @ts-expect-error the token is this module's own
  assert.throws(() => new PcoPathPart(Symbol("checked by pcoId or pcoSegment"), "1/../x"), PcoUrlRefused);
});

// Planning Center gives a plan's stage plot an all_attachments id with a word on
// the end ("84892470-stage", seen on a live plan). Accepting that for an
// attachment must not loosen any other id.
test("an attachment id takes digits, or digits and one lowercase word", () => {
  for (const ok of ["31", "84892470", "84892470-stage", "1-a", "1".repeat(20), `1-${"a".repeat(20)}`]) {
    assert.equal(isPcoAttachmentId(ok), true, ok);
    assert.equal(pcoAttachmentId("attachmentId", ok).value, ok);
  }
  const long = [`1-${"a".repeat(21)}`, "1".repeat(21)];
  for (const bad of [
    "", "abc", "-stage", "84892470-", "84892470-Stage", "84892470-stage-x", "84892470_stage", "84892470-st4ge",
    "../x", "84892470-stage/../../x", "84892470/stage", "84892470-stage?x=1", "84892470-stage%2F", " 84892470-stage",
    "84892470-stage\n", "__proto__", ...long, 84892470, null, undefined, {},
  ]) {
    assert.equal(isPcoAttachmentId(bad), false, String(bad));
    assert.throws(() => pcoAttachmentId("attachmentId", bad), PcoUrlRefused);
  }
});

test("a suffixed id is an attachment id only: pcoId still refuses it", () => {
  assert.throws(() => pcoId("planId", "84892470-stage"), PcoUrlRefused);
});

test("the refusal names the parameter and never the value", () => {
  assert.throws(
    () => pcoAttachmentId("attachmentId", "../secret-ish"),
    (e: Error) => e.message === "attachmentId is not a Planning Center attachment id",
  );
});

test("a checked attachment id builds the URL", () => {
  assert.equal(
    pcoUrl`/all_attachments/${pcoAttachmentId("attachmentId", "84892470-stage")}/open`,
    "https://api.planningcenteronline.com/services/v2/all_attachments/84892470-stage/open",
  );
});
