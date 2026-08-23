// signage-routes.ts — the media library, and the assets a display fetches.
//
// Two things here are unlike every other route module.
//
// The upload is a RAW STREAM, not a JSON body. readBody would parse it and
// readRawBody would hold a 200 MB video in memory twice; signage-upload streams
// it to disk instead. That is also why the metadata travels in headers — the
// body is the file.
//
// The asset route serves bytes off disk to anything on the LAN. The filename is
// checked before any lookup, and every response carries nosniff plus a sandbox
// CSP so a file opened directly in a tab is inert whatever it turns out to hold.

import type { DataStore } from "../data-store.js";
import { errorMessage } from "../errors.js";
import { andList, groupUsage, mediaUsage, playlistUsage } from "../signage-integrity.js";
import { signageGroupsStore } from "../signage-groups-store.js";
import { clearOverride, listOverrides, setOverride } from "../signage-overrides-store.js";
import { resolveItemDurations } from "../signage-playlist-items.js";
import { signagePlaylistsStore } from "../signage-playlists-store.js";
import { reorderSchedules, signageSchedulesStore } from "../signage-schedules-store.js";
import {
  addMedia,
  clampMeasured,
  deleteMedia,
  listMedia,
  readMediaFile,
  renameMedia,
} from "../signage-media-store.js";
import { signagePcoWindows } from "../signage-pco-windows.js";
import { signageScheduler } from "../signage-scheduler.js";
import { streamUploadToMedia, UploadTooLargeError } from "../signage-upload.js";
import { error, json, readBody, type RouteCtx } from "./context.js";

/** The longest a media name may be after cleaning. Long enough for a real
 *  filename, short enough that a list stays readable. */
const MAX_NAME = 200;

/**
 * Clean operator-supplied text arriving in a header.
 *
 * Control characters are stripped rather than escaped: this value ends up in a
 * JSON response, in the UI and in log lines, and a CRLF surviving into a log
 * line is how a forged entry reaches the LAN-visible /log page.
 */
function cleanName(raw: string | undefined, fallback: string): string {
  let decoded = raw ?? "";
  try {
    // The browser percent-encodes the name, because header values are latin-1 on
    // the wire and fetch() throws on a raw accented character. curl and any
    // hand-written client send it plain, and decoding a plain name is a no-op —
    // so both work. A malformed sequence falls back to the raw text rather than
    // failing the upload over a filename.
    decoded = decodeURIComponent(decoded);
  } catch {
    /* keep the raw text */
  }
  const s = decoded
    // eslint-disable-next-line no-control-regex -- stripping control chars is the point
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NAME);
  return s || fallback;
}

function header(c: RouteCtx, name: string): string | undefined {
  const v = c.req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/** A number from a header, or undefined when absent — clampMeasured decides
 *  whether undefined is acceptable for this mime, so the rejection message is
 *  written in one place. */
function numHeader(c: RouteCtx, name: string): number | undefined {
  const raw = header(c, name);
  if (raw === undefined || raw.trim() === "") return undefined;
  return Number(raw);
}

export async function signageRoutes(c: RouteCtx): Promise<void> {
  // ── Assets ────────────────────────────────────────────────────────────────
  if (c.pathname.startsWith("/signage-media/") && c.method === "GET") {
    // decodeURIComponent so an encoded traversal ("..%2F") is rejected by the
    // name check rather than slipping past it as a literal string.
    let file: string;
    try {
      file = decodeURIComponent(c.pathname.slice("/signage-media/".length));
    } catch {
      return error(c.res, "not found", 404);
    }
    const found = await readMediaFile(file);
    if (!found) return error(c.res, "not found", 404);
    c.res.writeHead(200, {
      "Content-Type": found.mime,
      "Content-Length": String(found.data.length),
      // Safe precisely because the name IS the hash: the bytes at a name can
      // never change, so there is nothing to revalidate.
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    });
    c.res.end(found.data);
    return;
  }

  // ── Media collection ──────────────────────────────────────────────────────
  if (c.pathname === "/api/signage/media") {
    if (c.method === "GET") return json(c.res, { media: await listMedia() });

    if (c.method === "POST") {
      const mime = (header(c, "content-type") ?? "").split(";")[0].trim().toLowerCase();
      if (!mime) return error(c.res, "a content-type is required", 400);

      let stored: { file: string; bytes: number; existed: boolean };
      try {
        // Streams to disk. Anything wrong with the type or the size is refused
        // here, before a record exists.
        stored = await streamUploadToMedia(c.req, mime);
      } catch (err) {
        if (err instanceof UploadTooLargeError) return error(c.res, err.message, 413);
        return error(c.res, errorMessage(err), 400);
      }

      let measured: { w: number; h: number; durationMs?: number };
      try {
        measured = clampMeasured({
          w: numHeader(c, "x-signage-w"),
          h: numHeader(c, "x-signage-h"),
          durationMs: numHeader(c, "x-signage-duration-ms"),
          mime,
        });
      } catch (err) {
        // The FILE is deliberately left on disk: it is content-addressed and
        // unreferenced, so the next prune reaps it. Unlinking here would delete
        // bytes a different, valid record might already point at.
        return error(c.res, errorMessage(err), 400);
      }

      const result = await addMedia({
        file: stored.file,
        name: cleanName(header(c, "x-signage-name"), stored.file),
        mime,
        bytes: stored.bytes,
        ...measured,
      });
      return json(c.res, { media: result.media, deduped: result.deduped });
    }
  }

  // ── One media item ────────────────────────────────────────────────────────
  const mediaItem = /^\/api\/signage\/media\/([^/]+)$/.exec(c.pathname);
  if (mediaItem) {
    const id = decodeURIComponent(mediaItem[1]);

    if (c.method === "PATCH") {
      const body = (await readBody(c.req)) as { name?: unknown };
      if (typeof body?.name !== "string") return error(c.res, "a name is required", 400);
      const media = await renameMedia(id, cleanName(body.name, id));
      if (!media) return error(c.res, "no such media", 404);
      return json(c.res, { media });
    }

    if (c.method === "DELETE") {
      // Media does NOT refuse. A file removed from the library should go; what
      // must not happen is the operator discovering later which playlists lost
      // an item, so the affected playlists are returned and the item is taken
      // out of them here rather than left dangling.
      const affected = mediaUsage(id, await signagePlaylistsStore.load());
      const media = await deleteMedia(id);
      if (!media) return error(c.res, "no such media", 404);
      if (affected.length) {
        await signagePlaylistsStore.update((all) =>
          all.map((p) => ({ ...p, items: p.items.filter((i) => i.mediaId !== id) })),
        );
        await signageScheduler.recompute();
      }
      return json(c.res, { media, removedFrom: affected });
    }
  }

  // ── Playlists, groups and schedules ───────────────────────────────────────
  // Three collections with identical mechanics, so one helper rather than three
  // copies that drift. Schedules additionally own their ORDER, which is the
  // conflict-resolution rule, so a create appends and never reshuffles.
  //
  // The base path is spelled out at each call site rather than built from the
  // segment name. route-coverage.test.ts scans source TEXT for the paths the
  // client calls, so a templated `/api/signage/${segment}` is invisible to it and
  // reads as an unhandled route. Spelling them out also means this list greps.
  if (await collection(c, "/api/signage/playlists", signagePlaylistsStore, "playlist")) return;
  if (await collection(c, "/api/signage/groups", signageGroupsStore, "group")) return;
  if (await collection(c, "/api/signage/schedules", signageSchedulesStore, "schedule")) return;

  // ── Overrides ─────────────────────────────────────────────────────────────
  if (c.pathname === "/api/signage/overrides" && c.method === "GET") {
    return json(c.res, { overrides: await listOverrides() });
  }

  const override = /^\/api\/signage\/groups\/([^/]+)\/override$/.exec(c.pathname);
  if (override) {
    const groupId = decodeURIComponent(override[1]);

    if (c.method === "POST") {
      const body = (await readBody(c.req)) as { playlistId?: unknown; blank?: unknown; note?: unknown };
      const playlistId = typeof body?.playlistId === "string" ? body.playlistId : null;
      const blank = body?.blank === true;

      // Exactly one. Neither would resolve as "nothing", which on a dark wall is
      // indistinguishable from a bug - and the operator pressed a button that
      // appeared to work.
      if ((playlistId && blank) || (!playlistId && !blank)) {
        return error(c.res, "an override needs a playlist or blank, not both", 400);
      }

      // Both existence checks happen here rather than at resolve time: a stale
      // page could otherwise store an override nothing will ever read, and the
      // banner would name a group that is not there.
      if (!(await signageGroupsStore.load()).some((g) => g.id === groupId)) {
        return error(c.res, "no such group", 404);
      }
      if (playlistId && !(await signagePlaylistsStore.load()).some((p) => p.id === playlistId)) {
        return error(c.res, "no such playlist", 400);
      }

      const record = {
        groupId,
        ...(blank ? { blank: true } : { playlistId: playlistId as string }),
        startedAt: Date.now(),
        ...(typeof body?.note === "string" ? { note: cleanName(body.note, "") } : {}),
      };
      await setOverride(record);
      await signageScheduler.recompute();
      return json(c.res, { override: record });
    }

    if (c.method === "DELETE") {
      // Not an error when there is nothing to release: the operator's intent is
      // "no override on this group", and that is already true. Failing would be
      // noise on a screen someone is trying to fix.
      await clearOverride(groupId);
      await signageScheduler.recompute();
      return json(c.res, { released: groupId });
    }
  }

  // Everything a group needs to play with no server: its DEFAULT playlist in
  // full, resolved to urls. A display asks the service worker to hold these and
  // reports back what it actually holds, so "ready" is a fact rather than an
  // intention.
  const prepare = /^\/api\/signage\/groups\/([^/]+)\/offline-assets$/.exec(c.pathname);
  if (prepare && c.method === "GET") {
    const groupId = decodeURIComponent(prepare[1]);
    const group = (await signageGroupsStore.load()).find((g) => g.id === groupId);
    if (!group) return error(c.res, "no such group", 404);
    if (!group.defaultPlaylistId) {
      // Not an error, but not silence either: a group with no default has
      // nothing to play offline, and the operator needs to be told that BEFORE
      // unplugging the Pi rather than after.
      return json(c.res, { assets: [], reason: "this group has no default playlist" });
    }
    const [playlists, media] = await Promise.all([
      signagePlaylistsStore.load(),
      listMedia(),
    ]);
    const playlist = playlists.find((p) => p.id === group.defaultPlaylistId);
    if (!playlist) return json(c.res, { assets: [], reason: "its default playlist is missing" });

    const items = resolveItemDurations(playlist, media);
    return json(c.res, {
      assets: items.map((r) => ({ url: `/signage-media/${r.media.file}`, bytes: r.media.bytes })),
      playlist: playlist.name,
    });
  }

  // What every display is showing, and why. The SAME resolver output the SSE
  // channel carries — read from the scheduler rather than recomputed here, so
  // the board and a wall cannot disagree about which schedule is winning.
  if (c.pathname === "/api/signage/now" && c.method === "GET") {
    return json(c.res, {
      horizons: signageScheduler.getHorizons(),
      // A stale window is USED rather than ignored, so the only way an operator
      // learns PCO is unreachable is by being told here.
      staleWindows: signagePcoWindows.isStale(),
      pcoError: signagePcoWindows.error(),
    });
  }

  if (c.pathname === "/api/signage/schedules/reorder" && c.method === "POST") {
    const body = (await readBody(c.req)) as { ids?: unknown };
    if (!Array.isArray(body?.ids) || body.ids.some((i) => typeof i !== "string")) {
      return error(c.res, "ids must be an array of schedule ids", 400);
    }
    const schedules = await reorderSchedules(body.ids as string[]);
    // Reordering IS the priority rule, so this changes what walls show.
    await signageScheduler.recompute();
    return json(c.res, { schedules });
  }
}

/**
 * Why this record cannot be deleted, in words an operator can act on.
 *
 * Empty when it is free to go. Only playlists and groups can be blocked; media
 * is deleted and reported (see the media DELETE arm above).
 */
async function deleteBlockers(key: string, id: string): Promise<string[]> {
  if (key === "playlist") {
    const [schedules, groups] = await Promise.all([
      signageSchedulesStore.load(),
      signageGroupsStore.load(),
    ]);
    const u = playlistUsage(id, schedules, groups);
    const out: string[] = [];
    if (u.schedules.length) out.push(`it is scheduled by ${andList(u.schedules)}`);
    if (u.groups.length) out.push(`it is the default playlist for ${andList(u.groups)}`);
    return out;
  }
  if (key === "group") {
    const used = groupUsage(id, await signageSchedulesStore.load());
    return used.length ? [`it is targeted by ${andList(used)}`] : [];
  }
  return [];
}

/** A stored record with an id — everything the collection helper handles. */
interface Identified {
  id: string;
  name?: string;
}

/**
 * GET / POST / DELETE for one signage collection.
 *
 * Returns true when it responded, so the caller can stop. POST is an upsert
 * keyed on id: the editor sends the whole record back, and a create simply has
 * an id nothing matches yet. Appending on create matters for schedules, where
 * position in the array is priority — inserting anywhere else would silently
 * change which schedule wins.
 */
async function collection<T extends Identified>(
  c: RouteCtx,
  base: string,
  store: DataStore<T[]>,
  key: string,
): Promise<boolean> {
  // The response wraps the list under its plural name ("playlists"), which is the
  // last path segment.
  const segment = base.slice(base.lastIndexOf("/") + 1);

  if (c.pathname === base) {
    if (c.method === "GET") {
      json(c.res, { [segment]: await store.load() });
      return true;
    }
    if (c.method === "POST") {
      const body = (await readBody(c.req)) as Record<string, unknown>;
      const record = body?.[key] as T | undefined;
      if (!record || typeof record !== "object" || typeof record.id !== "string" || !record.id) {
        error(c.res, `a ${key} with an id is required`, 400);
        return true;
      }
      if (typeof record.name === "string") {
        record.name = cleanName(record.name, record.id);
      }
      const saved = await store.update((all) =>
        all.some((r) => r.id === record.id)
          ? all.map((r) => (r.id === record.id ? record : r))
          : [...all, record],
      );
      // Push the new horizon at once rather than waiting for the safety tick:
      // an operator who just edited a schedule expects the wall to follow. A
      // new PCO-driven schedule also needs its windows fetched now rather than
      // up to half an hour later, which would look like the schedule not working.
      if (segment === "schedules") await signagePcoWindows.refresh();
      await signageScheduler.recompute();
      json(c.res, { [key]: record, [segment]: saved });
      return true;
    }
  }

  const item = new RegExp(`^${base}/([^/]+)$`).exec(c.pathname);
  if (item && c.method === "DELETE") {
    const id = decodeURIComponent(item[1]);

    // Refused, and NAMED. The same rule the app already applies to a view that
    // screens are showing: "in use by 1 schedule" leaves the operator hunting,
    // and what they are hunting for is why a wall went blank. 409 rather than
    // 400 - it is a conflict with the current state, not a malformed request.
    const blockers = await deleteBlockers(key, id);
    if (blockers.length) {
      error(c.res, `${blockers.join("; ")}. Change ${blockers.length > 1 ? "those" : "that"} first.`, 409);
      return true;
    }
    let removed: T | null = null;
    const remaining = await store.update((all) =>
      all.filter((r) => {
        if (r.id !== id) return true;
        removed = r;
        return false;
      }),
    );
    if (!removed) {
      error(c.res, `no such ${key}`, 404);
      return true;
    }
    await signageScheduler.recompute();
    json(c.res, { [key]: removed, [segment]: remaining });
    return true;
  }

  return false;
}
