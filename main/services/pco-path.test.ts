// pco-path.test.ts — a PCO URL path part can only be one pcoId or pcoSegment made.
//
// The type is what stops a raw id reaching a credentialed URL, so it has to be
// nominal: a class with only a public `value` would accept any `{ value }`
// object. Each case below is checked twice, by the type checker
// (@ts-expect-error fails `npm run type-check` the day the line compiles) and
// at run time, for a cast that gets past the type.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { PcoPathPart, PcoUrlRefused, pcoId, pcoSegment, pcoUrl } from "./pco-path.js";

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
