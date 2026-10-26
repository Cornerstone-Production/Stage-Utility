// Reading one Planning Center person by ID, for a by-person slot whose person is
// not on the plan. Only the network is stubbed (pcoFetch): the request path, its
// 404 handling and the photo rules are the real ones.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { PCO_API_VERSION, PcoAuthError, PEOPLE_API_VERSION, pcoService } from "./pco-service.js";

type Fetcher = { pcoFetch: (url: string, appId: string, secret: string, init?: RequestInit, apiVersion?: string) => Promise<Response> };
const svc = pcoService as unknown as Fetcher;
const realFetch = svc.pcoFetch;

let urls: string[] = [];
/** The X-PCO-API-Version each request asked for, in order. */
let versions: (string | undefined)[] = [];
/** Answer by product: Services and People can disagree about the same person. */
function respondByProduct(services: [number, unknown], people: [number, unknown]) {
  urls = [];
  versions = [];
  svc.pcoFetch = async (url, _appId, _secret, _init, apiVersion) => {
    urls.push(url);
    versions.push(apiVersion);
    const [status, body] = url.includes("/people/v2/") ? people : services;
    return new Response(JSON.stringify(body), { status });
  };
}
const notFound = { errors: [{ status: "404", title: "Not Found" }] };
function respond(status: number, body: unknown) {
  urls = [];
  svc.pcoFetch = async (url: string) => {
    urls.push(url);
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  };
}
const person = (attributes: Record<string, unknown>) => ({ data: { id: "100000001", type: "Person", attributes } });

describe("a Planning Center person by ID", () => {
  beforeEach(() => pcoService.clearCache());
  afterEach(() => {
    svc.pcoFetch = realFetch;
  });

  it("reads the person's own record", async () => {
    respond(200, person({ first_name: "Alex", last_name: "Rivera" }));
    await pcoService.getPerson("app", "secret", "100000001");
    assert.equal(urls.length, 1);
    assert.match(urls[0] ?? "", /\/services\/v2\/people\/100000001$/);
  });

  it("names them by full name, else first and last", async () => {
    respond(200, person({ full_name: "Alex J. Rivera", first_name: "Alex", last_name: "Rivera" }));
    assert.equal((await pcoService.getPerson("app", "secret", "1"))?.name, "Alex J. Rivera");
    pcoService.clearCache();
    respond(200, person({ first_name: "Alex", last_name: "Rivera" }));
    assert.equal((await pcoService.getPerson("app", "secret", "1"))?.name, "Alex Rivera");
  });

  it("takes a real photo at high resolution, and an initials placeholder as none", async () => {
    respond(200, person({ first_name: "A", photo_thumbnail_url: "https://avatars.planningcenteronline.com/uploads/person/1/x.jpg?g=224x224%23" }));
    assert.match((await pcoService.getPerson("app", "secret", "1"))?.photoUrl ?? "", /g=1000x1000%23/);
    pcoService.clearCache();
    respond(200, person({ first_name: "B", photo_thumbnail_url: "https://avatars.planningcenteronline.com/uploads/initials/B.png" }));
    assert.equal((await pcoService.getPerson("app", "secret", "1"))?.photoUrl, null);
  });

  it("answers null for a person PCO does not have", async () => {
    respond(404, { errors: [{ status: "404", title: "Not Found" }] });
    assert.equal(await pcoService.getPerson("app", "secret", "999"), null);
  });

  it("throws on any other failure, so it is not mistaken for no such person", async () => {
    respond(403, { errors: [{ status: "403", title: "Forbidden" }] });
    await assert.rejects(() => pcoService.getPerson("app", "secret", "1"), /PCO API error 403/);
    // Only a 404 means "not in Services"; a refused Services read is not passed on to People.
    assert.equal(urls.length, 1);
  });

  it("reads a person once, then from cache", async () => {
    respond(200, person({ first_name: "Alex" }));
    await pcoService.getPerson("app", "secret", "100000001");
    await pcoService.getPerson("app", "secret", "100000001");
    assert.equal(urls.length, 1);
  });

  it("asks People when Services has never heard of them", async () => {
    respondByProduct(
      [404, notFound],
      [200, person({ name: "Sam Okoye", first_name: "Sam", last_name: "Okoye", avatar: "https://avatars.planningcenteronline.com/uploads/person/9/x.jpg?g=62x62%23" })],
    );
    const card = await pcoService.getPerson("app", "secret", "115021752");
    assert.equal(card?.name, "Sam Okoye");
    assert.match(card?.photoUrl ?? "", /g=1000x1000%23/);
    assert.equal(urls.length, 2);
    assert.match(urls[0] ?? "", /\/services\/v2\/people\/115021752$/);
    assert.match(urls[1] ?? "", /\/people\/v2\/people\/115021752$/);
  });

  it("pins each product to its own API version", async () => {
    respondByProduct([404, notFound], [200, person({ name: "Sam Okoye" })]);
    await pcoService.getPerson("app", "secret", "115021752");
    assert.equal(versions[0] ?? PCO_API_VERSION, PCO_API_VERSION, "the Services read");
    assert.equal(versions[1], PEOPLE_API_VERSION, "the People read: Services' date resolves to an old People version");
    assert.notEqual(PEOPLE_API_VERSION, PCO_API_VERSION);
  });

  it("does not ask People when Services has them", async () => {
    respondByProduct([200, person({ first_name: "Alex" })], [500, {}]);
    await pcoService.getPerson("app", "secret", "1");
    assert.equal(urls.length, 1);
  });

  it("is nobody when neither product has them", async () => {
    respondByProduct([404, notFound], [404, notFound]);
    assert.equal(await pcoService.getPerson("app", "secret", "999"), null);
  });

  it("says People when the People read is what failed", async () => {
    respondByProduct([404, notFound], [403, { errors: [{ status: "403", title: "Forbidden" }] }]);
    await assert.rejects(() => pcoService.getPerson("app", "secret", "1"), /People API: .*403/);
  });

  it("keeps a refused People credential an auth error, saying it was People", async () => {
    respondByProduct([404, notFound], [401, { errors: [{ status: "401", title: "Unauthorized" }] }]);
    await assert.rejects(
      () => pcoService.getPerson("app", "secret", "1"),
      (err: unknown) => err instanceof PcoAuthError && /^People API: /.test(err.message),
    );
  });
});
