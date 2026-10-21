// The public page asks for exactly the documents the server sends.
//
// The page is the same code as the in-building ServiceCue pages, so what it reads is
// whatever those pages read through invoke(). The contract (main/types/
// servicecue-publish.ts) names each document by the public GET it answers. This runs
// the REAL invoke() for every read a ServiceCue page makes and holds the URL it fetches
// to the contract's path for that document, and to the document the page's own side
// would look that URL up as: a read whose address drifts, or a document that nothing
// asks for, shows here and not as a blank page on a phone.
//
// One entry per line, sorted by document key.

import { strict as assert } from "node:assert";
import { after, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();
after(() => teardown());

const { invoke } = await import("./api.js");
const { FIXED_DOCS, PUBLISH_UPCOMING_DAYS, docKeyForRequest, docPublicPath } = await import("../../main/types/servicecue-publish.js");

type Params = Record<string, unknown> | undefined;

const READS: [key: string, channel: Parameters<typeof invoke>[0], params: Params][] = [
  ["pco-live", "pco:getLive", undefined],
  ["plans-upcoming", "plans:upcoming", { days: PUBLISH_UPCOMING_DAYS }],
  ["rundown-100", "servicecue:rundown", { serviceTypeId: "100" }],
  ["rundown-100-1001", "servicecue:rundown", { serviceTypeId: "100", planId: "1001" }],
  ["service-types", "stage:listServiceTypes", undefined],
  ["servicecue-config", "servicecue:getConfig", undefined],
  ["servicecue-layouts", "servicecue:listLayouts", undefined],
  ["servicecue-roles", "servicecue:listRoles", undefined],
  ["spl-current", "spl:getHistoryCurrent", undefined],
  ["state", "stage:getState", undefined],
];

/** The URL invoke() fetches for a read. */
async function fetched(channel: Parameters<typeof invoke>[0], params: Params): Promise<string> {
  const real = globalThis.fetch;
  let url = "";
  globalThis.fetch = (async (input: unknown) => {
    url = String(input);
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    await invoke(channel, params);
  } finally {
    globalThis.fetch = real;
  }
  return url;
}

describe("the documents the page is sent", () => {
  for (const [key, channel, params] of READS) {
    test(`${key} is what ${channel} reads`, async () => {
      const url = await fetched(channel, params);
      assert.equal(url, docPublicPath(key), `${channel} no longer fetches the path ${key} is stored under`);
      // And the page's side, given that URL, finds the same document.
      const parsed = new URL(url, "http://page.invalid");
      assert.equal(docKeyForRequest(parsed.pathname, parsed.search), key, `the page would not look ${url} up as ${key}`);
    });
  }

  test("every document in the contract has a read behind it, and every read has a document", () => {
    const covered = READS.map(([key]) => key).filter((k) => !k.startsWith("rundown-"));
    assert.deepEqual(covered, FIXED_DOCS.map(([key]) => key));
    assert.deepEqual(
      READS.filter(([k]) => k.startsWith("rundown-")).map(([k]) => k),
      ["rundown-100", "rundown-100-1001"],
    );
  });

  test("the switcher asks for the window the page is given", () => {
    assert.equal(docPublicPath("plans-upcoming"), `/api/plans/upcoming?days=${PUBLISH_UPCOMING_DAYS}`);
  });
});
