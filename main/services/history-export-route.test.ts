// GET /api/history/export through RemoteServer's real handler on a real socket.
//
// `from` and `to` are query values, and the download's name is built from them,
// so they reach a quoted Content-Disposition header. Driven over a socket because
// the failure is in what the client is told: a quote in the value breaks the
// header open, and a CR/LF makes Node's writeHead throw after the workbook has
// already been built.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";

import { serveOnSocket, type SocketServer } from "./fixtures/socket-server.js";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-history-export-route-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { RemoteServer } = await import("./remote-server.js");

let server: SocketServer;
const get = (query: string) => server.send("GET", `/api/history/export?include=services&${query}`);

before(async () => {
  server = await serveOnSocket(new RemoteServer().handle);
});

after(async () => {
  await server.close();
  await fs.rm(TMP, { recursive: true, force: true });
});

describe("GET /api/history/export: from and to", () => {
  // Each refused value must answer 400 BEFORE the attachment header is written:
  // no Content-Disposition on the reply, and an error the caller can read.
  const refused: [string, string][] = [
    ["a quote in from", "from=a%22b"],
    ["a CR/LF in to", "to=a%0D%0Ab"],
    ["a day that does not exist", "from=2026-02-31"],
    ["a date in another shape", "to=11/27/2026"],
  ];
  for (const [what, query] of refused) {
    test(`${what} answers 400 and never reaches the attachment header`, async () => {
      const r = await get(query);
      assert.equal(r.status, 400, `${query} answered ${r.status}, content-disposition ${String(r.headers["content-disposition"])}`);
      assert.equal(r.headers["content-disposition"], undefined, `${query} reached writeHead: ${String(r.headers["content-disposition"])}`);
      assert.match(String(JSON.parse(r.body).error), /YYYY-MM-DD/);
    });
  }

  test("a real range downloads, named for what is in it", async () => {
    const r = await get("from=2026-01-04&to=2026-02-01");
    assert.equal(r.status, 200);
    assert.equal(r.headers["content-disposition"], 'attachment; filename="stage-utility-history-2026-01-04_to_2026-02-01.xlsx"');
  });

  test("an empty bound is no bound, as the History page sends it", async () => {
    const r = await get("from=&to=");
    assert.equal(r.status, 200);
    assert.equal(r.headers["content-disposition"], 'attachment; filename="stage-utility-history-all-dates.xlsx"');
  });
});
