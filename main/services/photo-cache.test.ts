// /photos?u= is reachable unauthenticated from the LAN and returns the fetched
// body to the caller. Without a host check it is an open proxy into the church
// network: the appliance fetches an internal host on the caller's behalf and
// hands back the response. Every real photo URL comes from a PCO Person record.

import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { before, describe, it } from "node:test";

import { getPhotoPath, isAllowedPhotoUrl, readCapped } from "./photo-cache.js";

describe("photo proxy host allowlist", () => {
  it("allows the avatars production actually serves", () => {
    // The shape a live /api/state serves, for a person who does not exist.
    assert.ok(
      isAllowedPhotoUrl(
        "https://avatars.planningcenteronline.com/uploads/person/100000001-1600000000/avatar.3.png?g=220x1000%23",
      ),
    );
  });

  it("allows other planningcenteronline.com subdomains", () => {
    assert.ok(isAllowedPhotoUrl("https://api.planningcenteronline.com/x.jpg"));
    assert.ok(isAllowedPhotoUrl("https://planningcenteronline.com/x.jpg"));
  });

  it("refuses internal and loopback hosts", () => {
    for (const u of [
      "http://127.0.0.1:9090/metrics",
      "http://192.168.1.1/admin/config",
      "http://10.0.0.5/",
      "http://169.254.169.254/latest/meta-data/",
      "https://192.168.16.61:8788/api/log",
    ]) {
      assert.equal(isAllowedPhotoUrl(u), false, u);
    }
  });

  it("refuses plain http, which could reach an internal host on port 80", () => {
    assert.equal(isAllowedPhotoUrl("http://avatars.planningcenteronline.com/x.jpg"), false);
  });

  it("refuses a lookalike host that merely ends with the domain text", () => {
    assert.equal(isAllowedPhotoUrl("https://planningcenteronline.com.evil.test/x.jpg"), false);
    assert.equal(isAllowedPhotoUrl("https://notplanningcenteronline.com/x.jpg"), false);
    assert.equal(isAllowedPhotoUrl("https://evil.test/?planningcenteronline.com"), false);
  });

  it("refuses non-http schemes and junk", () => {
    for (const u of ["file:///etc/passwd", "gopher://x/", "not a url", ""]) {
      assert.equal(isAllowedPhotoUrl(u), false, u);
    }
  });

  it("is not fooled by userinfo pointing at another host", () => {
    // https://allowed@evil.test/ has hostname evil.test, not the allowed domain.
    assert.equal(isAllowedPhotoUrl("https://avatars.planningcenteronline.com@evil.test/x.jpg"), false);
  });
});

describe("readCapped", () => {
  // The cap used to be checked against content-length only. A chunked response
  // has none, Number(null) is 0, and the guard passed — so the whole body was
  // materialised in a Pi's heap before its size was ever looked at, which is the
  // opposite of what the comment on that hunk claimed.
  const streamOf = (chunks: Uint8Array[], headers: Record<string, string> = {}): Response =>
    new Response(
      new ReadableStream({
        start(c) {
          for (const ch of chunks) c.enqueue(ch);
          c.close();
        },
      }),
      { headers },
    );

  it("returns a body that fits", async () => {
    const buf = await readCapped(streamOf([new Uint8Array(10), new Uint8Array(10)]), 100);
    assert.equal(buf?.byteLength, 20);
  });

  it("refuses an over-cap body that declares no length", async () => {
    // No content-length header at all — the case the old check could not see.
    const res = streamOf([new Uint8Array(60), new Uint8Array(60)]);
    assert.equal(res.headers.get("content-length"), null, "fixture must not declare a length");
    assert.equal(await readCapped(res, 100), null);
  });

  it("stops reading rather than draining the whole body", async () => {
    let produced = 0;
    const res = new Response(
      new ReadableStream({
        pull(c) {
          produced += 1;
          if (produced > 50) return c.close();
          c.enqueue(new Uint8Array(32));
        },
      }),
    );
    assert.equal(await readCapped(res, 64), null);
    assert.ok(produced < 10, `kept pulling after the cap: ${produced} chunks`);
  });

  it("is exact at the boundary", async () => {
    assert.equal((await readCapped(streamOf([new Uint8Array(100)]), 100))?.byteLength, 100);
    assert.equal(await readCapped(streamOf([new Uint8Array(101)]), 100), null);
  });
});

describe("getPhotoPath", () => {
  // The cache writes under the data directory, which is resolved on first use.
  // Point it somewhere disposable before that — never at ~/.stage-utility.
  before(async () => {
    process.env.STAGE_UTILITY_DATA = await fsp.mkdtemp(path.join(os.tmpdir(), "photo-cache-"));
  });

  /** A photo URL of its own per test, so one test's cached file cannot answer another's. */
  const photo = (n: number) => `https://avatars.planningcenteronline.com/uploads/person/10000000${n}-1600000000/avatar.2.png?g=256x256`;

  it("fetches once for simultaneous requests for one photo", async (t) => {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return new Response("photo-bytes", { status: 200 });
    });

    const paths = await Promise.all([1, 2, 3, 4].map(() => getPhotoPath(photo(6))));

    assert.equal(calls, 1, "each request fetched and wrote the same file");
    for (const p of paths) assert.equal(await fsp.readFile(p!, "utf8"), "photo-bytes");
  });

  it("leaves no torn file behind when a write fails halfway", async (t) => {
    // The disk filling mid-write, or the power going. What is on disk is served
    // immutable, so a torn file written in place would be the photo for a year.
    t.mock.method(globalThis, "fetch", async () => new Response("photo-bytes", { status: 200 }));
    t.mock.method(console, "error", () => {});
    const realWrite = fsp.writeFile;
    fsp.writeFile = (async (file: Parameters<typeof realWrite>[0], data: Buffer) => {
      await realWrite(file, data.subarray(0, 3));
      throw new Error("ENOSPC: no space left on device");
    }) as unknown as typeof realWrite;
    syncBuiltinESMExports();
    t.after(() => {
      fsp.writeFile = realWrite;
      syncBuiltinESMExports();
    });

    assert.equal(await getPhotoPath(photo(7)), null, "a failed write reported success");

    fsp.writeFile = realWrite;
    syncBuiltinESMExports();
    const again = await getPhotoPath(photo(7));
    assert.equal(await fsp.readFile(again!, "utf8"), "photo-bytes", "served the torn file");
  });
});
