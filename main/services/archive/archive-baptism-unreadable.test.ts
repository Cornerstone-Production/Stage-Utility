// baptism.json there and unreadable, for the data archive.
//
// An export took it for "nothing recorded yet" and shipped without it. An
// import adds its sessions last, after every record and raw file, so a save
// refused there (data-store.ts refuses saves to a file it could not read)
// came after the rest of the import was already written. A directory where
// the file should be is the unreadable case, without depending on file
// permissions. Its own file: the store is a singleton that keeps the failure.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { strToU8, zipSync } from "fflate";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-arc-baptism-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");
await fs.mkdir(path.join(TMP, "baptism.json"));

const { buildArchive, importArchive } = await import("./archive-bundle.js");
const { splHistoryStore } = await import("../spl-history-store.js");

const KEY = "st1:p1:t1";
const DATE = "2026-10-18";

function archive(sessions: { id: string }[]): Uint8Array {
  const manifest = {
    kind: "stage-utility-archive",
    version: 1,
    appVersion: "0.0.0",
    createdAt: `${DATE}T20:00:00.000Z`,
    services: [{ serviceKey: KEY, serviceDate: DATE, dir: null }],
  };
  const rec = { serviceKey: KEY, serviceDate: DATE, startedAt: `${DATE}T14:00:00.000Z`, items: [] };
  return zipSync({
    "manifest.json": strToU8(JSON.stringify(manifest)),
    "stores/spl-history.json": strToU8(JSON.stringify({ services: { [KEY]: rec } })),
    "stores/baptism.json": strToU8(JSON.stringify({ current: null, sessions })),
  });
}

async function quietly<R>(fn: () => Promise<R>): Promise<R> {
  const orig = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = orig;
  }
}

describe("with baptism.json there and unreadable", () => {
  it("an export fails rather than shipping without it", async () => {
    await assert.rejects(buildArchive(), { name: "StoreReadError", code: "EISDIR", message: /^baptism\.json could not be read/ });
  });

  it("an import that would add sessions refuses before writing anything", async () => {
    await assert.rejects(
      quietly(() => importArchive(archive([{ id: "b1" }]))),
      /baptism\.json/,
    );
    assert.equal(await splHistoryStore.get(KEY), null, "a record was written before the refusal");
  });

  it("an import with no sessions to add still runs", async () => {
    const res = await quietly(() => importArchive(archive([])));
    assert.deepEqual(res.added, [KEY]);
  });
});
