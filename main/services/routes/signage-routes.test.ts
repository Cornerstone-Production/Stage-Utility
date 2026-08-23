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

  test("REFUSES to delete a playlist a schedule uses, and names it", async () => {
    // The same rule the app applies to a view screens are showing. A count
    // rather than a name leaves the operator hunting for why a wall went blank.
    await save("playlists", "playlist", {
      id: "p-used", name: "Weekend", items: [], defaultDurationMs: 8000,
      fit: "contain", transition: { kind: "cut", ms: 0 }, createdAt: "",
    });
    await save("schedules", "schedule", {
      id: "s-uses-p", name: "Weekend mornings", enabled: true, groupIds: [],
      playlistId: "p-used", window: { kind: "always" }, createdAt: "",
    });
    const r = await callRoute(signageRoutes, "/api/signage/playlists/p-used", { method: "DELETE" });
    assert.equal(r.status, 409, "a playlist in use was deleted");
    assert.match(String((r.json as { error: string }).error), /Weekend mornings/);
  });

  test("REFUSES to delete a playlist that is only a tag's default", async () => {
    // Nothing in the schedule list points at it, so a check that walked only
    // schedules would report it free - and deleting it silently blanks that tag,
    // including on a Pi that boots with no server.
    //
    // The claim is on the PLAYLIST (`defaultForGroupIds`), which is what the
    // editor writes. This test used to put `defaultPlaylistId` on the group
    // instead - a field nothing has written since groups became tags - so it was
    // green while the real path returned 200 and deleted the playlist.
    await save("playlists", "playlist", {
      id: "p-default", name: "House loop", items: [], defaultDurationMs: 8000,
      fit: "contain", transition: { kind: "cut", ms: 0 }, defaultForGroupIds: ["g-default"],
      createdAt: "",
    });
    await save("groups", "group", {
      id: "g-default", name: "Cafe", outputIds: [], createdAt: "",
    });
    const r = await callRoute(signageRoutes, "/api/signage/playlists/p-default", { method: "DELETE" });
    assert.equal(r.status, 409);
    assert.match(String((r.json as { error: string }).error), /Cafe/);
  });

  test("and offline-assets names the tag default of the SCREEN asking", async () => {
    // The other half of the same rule, and the other reader that was asking the
    // deprecated field: this route answered "no default playlist" for every tag
    // that had one, on the screen whose whole job is confirming a Pi can boot
    // with the server off.
    //
    // Keyed on the screen because that is the question - a screen can be in
    // several tags, and what it plays offline is whichever of their defaults
    // wins.
    // A REAL upload, because the media library has no plain POST - the manifest
    // is written by the upload path, and a hand-saved record is not in it.
    const up = await upload(
      { "content-type": "image/png", "x-signage-name": "card.png", "x-signage-w": "8", "x-signage-h": "8" },
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02, 0x03]),
    );
    assert.equal(up.status, 200);
    const media = (up.json as { media: { id: string; file: string } }).media;
    await save("playlists", "playlist", {
      id: "p-offline", name: "Foyer loop", items: [{ mediaId: media.id }],
      defaultDurationMs: 8000, fit: "contain", transition: { kind: "cut", ms: 0 },
      defaultForGroupIds: ["g-offline"], createdAt: "",
    });
    await save("groups", "group", {
      id: "g-offline", name: "Foyer", outputIds: ["display-offline"], createdAt: "",
    });
    const r = await callRoute(signageRoutes, "/api/signage/outputs/display-offline/offline-assets", { method: "GET" });
    assert.equal(r.status, 200);
    const body = r.json as { assets: { url: string }[]; reason?: string; playlist?: string };
    assert.equal(body.reason, undefined, `still reporting no default: ${body.reason}`);
    assert.equal(body.playlist, "Foyer loop");
    assert.deepEqual(body.assets.map((a) => a.url), [`/signage-media/${media.file}`]);
  });

  test("and says so plainly when the screen is in no tags", async () => {
    const r = await callRoute(signageRoutes, "/api/signage/outputs/display-untagged/offline-assets", { method: "GET" });
    assert.equal(r.status, 200);
    const body = r.json as { assets: unknown[]; reason?: string };
    assert.deepEqual(body.assets, []);
    assert.match(String(body.reason), /no tags/);
  });

  test("REFUSES to delete a group a schedule targets, and names it", async () => {
    await save("groups", "group", { id: "g-used", name: "Foyer", outputIds: [], createdAt: "" });
    await save("schedules", "schedule", {
      id: "s-uses-g", name: "Office hours", enabled: true, groupIds: ["g-used"],
      playlistId: "p-used", window: { kind: "always" }, createdAt: "",
    });
    const r = await callRoute(signageRoutes, "/api/signage/groups/g-used", { method: "DELETE" });
    assert.equal(r.status, 409);
    assert.match(String((r.json as { error: string }).error), /Office hours/);
  });

  test("allows deleting one nothing uses", async () => {
    await save("playlists", "playlist", {
      id: "p-free", name: "Spare", items: [], defaultDurationMs: 8000,
      fit: "contain", transition: { kind: "cut", ms: 0 }, createdAt: "",
    });
    const r = await callRoute(signageRoutes, "/api/signage/playlists/p-free", { method: "DELETE" });
    assert.equal(r.status, 200);
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

  test("clearing a name gives a readable one, never the record id", async () => {
    // Deleting the text in a name field filled it with "gr-mt4zqllvhkqd9f".
    // The fallback was the record's own id, which is a random string an
    // operator has no way to read as anything but corruption — and it is the id
    // they then have to select and delete before they can type a real name.
    for (const [segment, key, extra] of [
      ["playlists", "playlist", { items: [] }],
      ["groups", "group", { outputIds: [] }],
      ["schedules", "schedule", { groupIds: [] }],
    ] as const) {
      const r = await save(segment, key, { id: `blank-${key}`, name: "   ", ...extra });
      const name = (r.json as Record<string, { name: string }>)[key].name;
      assert.ok(!name.includes(`blank-${key}`), `a cleared ${key} name became its id: ${name}`);
      assert.equal(name, `Untitled ${key}`);
    }
  });

  test("a record without the list the resolver walks is refused", async () => {
    // The poison pill. `{"playlist":{"id":"x"}}` used to be stored happily, and
    // the moment anything pointed at it the resolver threw inside the
    // scheduler's catch — freezing the horizon for EVERY screen at its last good
    // value, until the server was restarted. Found by POSTing it at a live
    // server and watching /api/signage/now go stale.
    for (const [segment, key, field] of [
      ["playlists", "playlist", "items"],
      ["groups", "group", "outputIds"],
      ["schedules", "schedule", "groupIds"],
    ] as const) {
      const missing = await save(segment, key, { id: `poison-${key}`, name: "poison" });
      assert.equal(missing.status, 400, `a ${key} with no ${field} was accepted`);

      // Not an array is the same refusal — JSON.parse is happy to hand over a
      // string, and a string is iterable, so this one would have got through a
      // truthiness check and produced items of single characters.
      const wrongType = await save(segment, key, { id: `poison-${key}`, name: "poison", [field]: "nope" });
      assert.equal(wrongType.status, 400, `a ${key} whose ${field} is a string was accepted`);
    }
  });

  test("each collection is separate", async () => {
    // Asserted on the ids each collection holds rather than on counts: the
    // helper is generic, and the failure worth catching is one collection's
    // records landing in another's store.
    const groups = await callRoute(signageRoutes, "/api/signage/groups");
    const playlists = await callRoute(signageRoutes, "/api/signage/playlists");
    const groupIds = (groups.json as { groups: { id: string }[] }).groups.map((g) => g.id);
    const playlistIds = (playlists.json as { playlists: { id: string }[] }).playlists.map((p) => p.id);
    assert.ok(groupIds.includes("g1"), "a saved group is missing from the groups store");
    assert.ok(!playlistIds.includes("g1"), "a group leaked into the playlists store");
    assert.equal(groupIds.filter((id) => playlistIds.includes(id)).length, 0);
  });
});

describe("a save says whether the walls picked it up", () => {
  test("every write reports horizonUpdated", async () => {
    // The scheduler deliberately never throws — it runs from a timer, and an
    // exception escaping would take it down silently. But six route handlers
    // awaited it and then answered 200 regardless, so a failed rebuild left the
    // operator looking at a green Save while the walls stayed on the previous
    // horizon. The flag is how the UI can tell.
    const save = await callRoute(signageRoutes, "/api/signage/playlists", {
      method: "POST",
      body: {
        playlist: {
          id: "p-flag", name: "Flagged", items: [], defaultDurationMs: 8000,
          fit: "contain", transition: { kind: "cut", ms: 0 }, createdAt: "",
        },
      },
    });
    assert.equal(save.status, 200);
    assert.equal((save.json as { horizonUpdated?: boolean }).horizonUpdated, true);

    const del = await callRoute(signageRoutes, "/api/signage/playlists/p-flag", { method: "DELETE" });
    assert.equal(del.status, 200);
    assert.equal((del.json as { horizonUpdated?: boolean }).horizonUpdated, true);
  });

  test("and a reorder does too", async () => {
    const r = await callRoute(signageRoutes, "/api/signage/schedules/reorder", {
      method: "POST",
      body: { ids: [] },
    });
    assert.equal(r.status, 200);
    assert.equal((r.json as { horizonUpdated?: boolean }).horizonUpdated, true);
  });
});
