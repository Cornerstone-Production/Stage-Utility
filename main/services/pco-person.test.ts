// Reading one Planning Center person by ID, for a by-person slot whose person is
// not on the plan. Only the network is stubbed (pcoFetch): the request path, its
// 404 handling and the photo rules are the real ones.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { pcoService } from "./pco-service.js";

type Fetcher = { pcoFetch: (url: string) => Promise<Response> };
const svc = pcoService as unknown as Fetcher;
const realFetch = svc.pcoFetch;

let urls: string[] = [];
function respond(status: number, body: unknown) {
  urls = [];
  svc.pcoFetch = async (url: string) => {
    urls.push(url);
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  };
}
const person = (attributes: Record<string, unknown>) => ({ data: { id: "113920177", type: "Person", attributes } });

describe("a Planning Center person by ID", () => {
  beforeEach(() => pcoService.clearCache());
  afterEach(() => {
    svc.pcoFetch = realFetch;
  });

  it("reads the person's own record", async () => {
    respond(200, person({ first_name: "Ethan", last_name: "Matthews" }));
    await pcoService.getPerson("app", "secret", "113920177");
    assert.equal(urls.length, 1);
    assert.match(urls[0] ?? "", /\/services\/v2\/people\/113920177$/);
  });

  it("names them by full name, else first and last", async () => {
    respond(200, person({ full_name: "Ethan J. Matthews", first_name: "Ethan", last_name: "Matthews" }));
    assert.equal((await pcoService.getPerson("app", "secret", "1"))?.name, "Ethan J. Matthews");
    pcoService.clearCache();
    respond(200, person({ first_name: "Ethan", last_name: "Matthews" }));
    assert.equal((await pcoService.getPerson("app", "secret", "1"))?.name, "Ethan Matthews");
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
  });

  it("reads a person once, then from cache", async () => {
    respond(200, person({ first_name: "Ethan" }));
    await pcoService.getPerson("app", "secret", "113920177");
    await pcoService.getPerson("app", "secret", "113920177");
    assert.equal(urls.length, 1);
  });
});
