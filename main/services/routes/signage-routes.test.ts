// The LAN-facing surface of the media library.
//
// Two classes of thing are pinned here, and both are about what an untrusted
// caller can make the server do.
//
// SERVING: the filename is the whole check and it runs before any lookup, so
// traversal is refused without consulting the manifest. Everything served also
// carries nosniff and a sandbox CSP, so a file opened directly in a tab is inert
// whatever its bytes turn out to be — belt and braces beside excluding SVG.
//
// UPLOADING: the mime allowlist, and the fact that a measurement the server
// cannot trust is REJECTED rather than defaulted. A video with no duration would
// otherwise become a playlist item of some invented length.

import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, test } from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-utility-signage-routes-"));
process.env.STAGE_UTILITY_DATA = path.join(TMP, "data");
process.env.HOME = path.join(TMP, "home");

const { callRoute } = await import("./route-harness.js");
const { signageRoutes } = await import("./signage-routes.js");

after(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

const upload = (headers: Record<string, string>, body: Buffer) =>
  callRoute(signageRoutes, "/api/signage/media", { method: "POST", headers, rawBytes: body });

describe("serving signage media", () => {
  test("refuses a name we did not write", async () => {
    for (const bad of [
      "..%2F..%2Fsettings.json",
      "welcome.png",
      "0123456789abcdef.svg",
      "0123456789ABCDEF.png",
      "0123456789abcde.png",
    ]) {
      const r = await callRoute(signageRoutes, `/signage-media/${bad}`);
      assert.equal(r.status, 404, `${bad} was not refused`);
    }
  });

  test("a real file comes back with its bytes intact", async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10]);
    const up = await upload(
      { "content-type": "image/png", "x-signage-name": "px.png", "x-signage-w": "8", "x-signage-h": "8" },
      bytes,
    );
    assert.equal(up.status, 200);
    const file = (up.json as { media: { file: string } }).media.file;

    const r = await callRoute(signageRoutes, `/signage-media/${file}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.bytes, bytes, "the served bytes were not the stored bytes");
  });

  test("a served file cannot execute in the app's origin", async () => {
    const up = await upload(
      { "content-type": "image/png", "x-signage-name": "b.png", "x-signage-w": "8", "x-signage-h": "8" },
      Buffer.from("second image"),
    );
    const file = (up.json as { media: { file: string } }).media.file;
    const r = await callRoute(signageRoutes, `/signage-media/${file}`);
    assert.equal(r.headers["X-Content-Type-Options"], "nosniff");
    assert.match(String(r.headers["Content-Security-Policy"]), /default-src 'none'/);
    assert.match(String(r.headers["Content-Security-Policy"]), /sandbox/);
  });

  test("and is cached forever, which the content-addressed name makes safe", async () => {
    const up = await upload(
      { "content-type": "image/png", "x-signage-name": "c.png", "x-signage-w": "8", "x-signage-h": "8" },
      Buffer.from("third image"),
    );
    const file = (up.json as { media: { file: string } }).media.file;
    const r = await callRoute(signageRoutes, `/signage-media/${file}`);
    assert.match(String(r.headers["Cache-Control"]), /immutable/);
  });
});

describe("uploading media", () => {
  test("rejects a mime that is not on the allowlist", async () => {
    const r = await upload(
      { "content-type": "image/svg+xml", "x-signage-name": "logo.svg", "x-signage-w": "8", "x-signage-h": "8" },
      Buffer.from("<svg/>"),
    );
    assert.equal(r.status, 400);
    assert.match(String((r.json as { error: string }).error), /not accepted/i);
  });

  test("rejects a video whose duration was never measured", async () => {
    const r = await upload(
      { "content-type": "video/mp4", "x-signage-name": "clip.mp4", "x-signage-w": "1920", "x-signage-h": "1080" },
      Buffer.from("fake mp4"),
    );
    assert.equal(r.status, 400, "a video with no measured duration was accepted");
    assert.match(String((r.json as { error: string }).error), /duration/i);
  });

  test("rejects a missing dimension rather than inventing one", async () => {
    const r = await upload(
      { "content-type": "image/png", "x-signage-name": "d.png" },
      Buffer.from("no dimensions"),
    );
    assert.equal(r.status, 400);
    assert.match(String((r.json as { error: string }).error), /dimension/i);
  });

  test("rejects a request with no content-type at all", async () => {
    const r = await upload({ "x-signage-name": "e.png", "x-signage-w": "8", "x-signage-h": "8" }, Buffer.from("x"));
    assert.equal(r.status, 400);
  });

  test("a duplicate says so instead of making a second record", async () => {
    const bytes = Buffer.from("a duplicated graphic");
    const h = { "content-type": "image/png", "x-signage-name": "dup.png", "x-signage-w": "8", "x-signage-h": "8" };
    const first = await upload(h, bytes);
    const second = await upload({ ...h, "x-signage-name": "dup-again.png" }, bytes);
    assert.equal((first.json as { deduped: boolean }).deduped, false);
    assert.equal((second.json as { deduped: boolean }).deduped, true);
    assert.equal(
      (first.json as { media: { id: string } }).media.id,
      (second.json as { media: { id: string } }).media.id,
    );
  });

  test("a name carrying a newline cannot forge a header or a log line", async () => {
    // Operator text that ends up in a JSON response and in the log. A CRLF here
    // is how a forged entry reaches the LAN-visible /log page.
    const r = await upload(
      {
        "content-type": "image/png",
        "x-signage-name": "ok.png\r\n[stage-controller] everything is fine",
        "x-signage-w": "8",
        "x-signage-h": "8",
      },
      Buffer.from("newline name"),
    );
    assert.equal(r.status, 200);
    const name = (r.json as { media: { name: string } }).media.name;
    assert.ok(!/[\r\n]/.test(name), "a newline survived into the stored name");
  });

  test("decodes the name the browser percent-encoded", async () => {
    // The browser has to encode it (header values are latin-1 and fetch throws
    // on a raw accented character). If the server does not decode, an operator's
    // library fills up with names like "Foyer%20welcome.png".
    const r = await upload(
      {
        "content-type": "image/png",
        "x-signage-name": encodeURIComponent("Bienvenido á casa.png"),
        "x-signage-w": "8",
        "x-signage-h": "8",
      },
      Buffer.from("encoded name"),
    );
    assert.equal((r.json as { media: { name: string } }).media.name, "Bienvenido á casa.png");
  });

  test("a plain name from curl still works", async () => {
    // Decoding a name with no escapes in it is a no-op, so a hand-written client
    // is unaffected.
    const r = await upload(
      { "content-type": "image/png", "x-signage-name": "Foyer welcome.png", "x-signage-w": "8", "x-signage-h": "8" },
      Buffer.from("plain name"),
    );
    assert.equal((r.json as { media: { name: string } }).media.name, "Foyer welcome.png");
  });

  test("a malformed escape does not fail the upload", async () => {
    const r = await upload(
      { "content-type": "image/png", "x-signage-name": "100%-cotton.png", "x-signage-w": "8", "x-signage-h": "8" },
      Buffer.from("malformed escape"),
    );
    assert.equal(r.status, 200);
    assert.equal((r.json as { media: { name: string } }).media.name, "100%-cotton.png");
  });

  test("an absurdly long name is bounded", async () => {
    const r = await upload(
      {
        "content-type": "image/png",
        "x-signage-name": "x".repeat(5000),
        "x-signage-w": "8",
        "x-signage-h": "8",
      },
      Buffer.from("long name"),
    );
    assert.equal(r.status, 200);
    assert.ok((r.json as { media: { name: string } }).media.name.length <= 200);
  });
});

describe("listing, renaming and deleting", () => {
  test("lists what has been uploaded", async () => {
    const r = await callRoute(signageRoutes, "/api/signage/media");
    assert.equal(r.status, 200);
    assert.ok(Array.isArray((r.json as { media: unknown[] }).media));
  });

  test("renames by id", async () => {
    const list = await callRoute(signageRoutes, "/api/signage/media");
    const id = (list.json as { media: { id: string }[] }).media[0].id;
    const r = await callRoute(signageRoutes, `/api/signage/media/${id}`, {
      method: "PATCH",
      body: { name: "Foyer welcome" },
    });
    assert.equal(r.status, 200);
    assert.equal((r.json as { media: { name: string } }).media.name, "Foyer welcome");
  });

  test("renaming something gone is a 404, not a silent success", async () => {
    const r = await callRoute(signageRoutes, "/api/signage/media/no-such-id", {
      method: "PATCH",
      body: { name: "x" },
    });
    assert.equal(r.status, 404);
  });

  test("deletes by id", async () => {
    const list = await callRoute(signageRoutes, "/api/signage/media");
    const id = (list.json as { media: { id: string }[] }).media[0].id;
    const r = await callRoute(signageRoutes, `/api/signage/media/${id}`, { method: "DELETE" });
    assert.equal(r.status, 200);
  });

  test("falls through for a path it does not own", async () => {
    // A route module that swallowed everything under /api would break every
    // module after it in the chain.
    const r = await callRoute(signageRoutes, "/api/state");
    assert.equal(r.responded, false, "signageRoutes answered a path belonging to another module");
  });
});

describe("playlists, groups and schedules", () => {
  const save = (segment: string, key: string, record: unknown) =>
    callRoute(signageRoutes, `/api/signage/${segment}`, { method: "POST", body: { [key]: record } });

  test("a create appends, so schedule order is never silently reshuffled", async () => {
    // Position in this array IS priority. Inserting a new schedule anywhere but
    // the end would change which schedule wins for displays nobody touched.
    await save("schedules", "schedule", { id: "s1", name: "First", groupIds: [], playlistId: "p1" });
    await save("schedules", "schedule", { id: "s2", name: "Second", groupIds: [], playlistId: "p1" });
    const r = await callRoute(signageRoutes, "/api/signage/schedules");
    assert.deepEqual((r.json as { schedules: { id: string }[] }).schedules.map((s) => s.id), ["s1", "s2"]);
  });

  test("saving an existing record replaces it in place, keeping its position", async () => {
    await save("schedules", "schedule", { id: "s1", name: "Renamed", groupIds: [], playlistId: "p1" });
    const r = await callRoute(signageRoutes, "/api/signage/schedules");
    const all = (r.json as { schedules: { id: string; name: string }[] }).schedules;
    assert.deepEqual(all.map((s) => s.id), ["s1", "s2"], "an edit moved the schedule");
    assert.equal(all[0].name, "Renamed");
  });

  test("reorder changes priority", async () => {
    const r = await callRoute(signageRoutes, "/api/signage/schedules/reorder", {
      method: "POST",
      body: { ids: ["s2", "s1"] },
    });
    assert.equal(r.status, 200);
    assert.deepEqual((r.json as { schedules: { id: string }[] }).schedules.map((s) => s.id), ["s2", "s1"]);
  });

  test("reorder refuses a body that is not a list of ids", async () => {
    const r = await callRoute(signageRoutes, "/api/signage/schedules/reorder", {
      method: "POST",
      body: { ids: "s1" },
    });
    assert.equal(r.status, 400);
  });

  test("a record with no id is refused rather than stored unaddressable", async () => {
    const r = await save("groups", "group", { name: "Foyer", outputIds: [] });
    assert.equal(r.status, 400);
  });

  test("deleting something that is gone is a 404", async () => {
    const r = await callRoute(signageRoutes, "/api/signage/groups/no-such-id", { method: "DELETE" });
    assert.equal(r.status, 404);
  });

  test("a group name is cleaned the same way a media name is", async () => {
    // The same operator text reaching the same log lines. One cleaner, applied
    // everywhere a name is stored, rather than remembering it per route.
    const r = await save("groups", "group", { id: "g1", name: "Foyer\r\n[stage] fake", outputIds: [] });
    assert.ok(!/[\r\n]/.test((r.json as { group: { name: string } }).group.name));
  });

  test("each collection is separate", async () => {
    const groups = await callRoute(signageRoutes, "/api/signage/groups");
    const playlists = await callRoute(signageRoutes, "/api/signage/playlists");
    assert.equal((groups.json as { groups: unknown[] }).groups.length, 1);
    assert.equal((playlists.json as { playlists: unknown[] }).playlists.length, 0);
  });
});
