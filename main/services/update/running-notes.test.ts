// What's new: the release notes of the version RUNNING, at any time.
//
// The after-update dialog is shown once, and Dismiss used to throw its notes
// away with the acknowledgement. These tests pin the two halves apart: the
// acknowledgement still clears, the notes stay, and what the button shows is
// always the running release — never the one an update would install next, and
// never a notice captured for an update that did not land.
//
// Every version and change line below is INVENTED. This is a public repository.

import assert from "node:assert/strict";
import { after, beforeEach, describe, test } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "su-running-notes-"));
process.env.STAGE_UTILITY_DATA = TMP;

const { updateNoticesStore } = await import("../update-notices-store.js");
const { runningReleaseNotes, dismissJustUpdated, sameVersion } = await import("./running-notes.js");
import type { JustUpdated, UpdateNotices } from "../update-notices-store.js";
import type { ReleaseInfo } from "./release-check.js";

after(() => fs.rm(TMP, { recursive: true, force: true }).catch(() => {}));

const FILE = path.join(TMP, "update-notices.json");

/** A release body in the shape the notes generator writes. */
const body = (line: string, intro = "Nothing to do to install this.") =>
  `${intro}\n\n## New\n\n- ${line}\n\n## Install\n\n\`\`\`bash\ncurl example\n\`\`\`\n`;

const rel = (tag: string, line: string): ReleaseInfo => ({
  tag,
  name: tag,
  publishedAt: "2026-01-01T00:00:00Z",
  assets: [],
  body: body(line),
});

const notice = (version: string, line: string): JustUpdated => ({
  version,
  fromVersion: "9.7.0",
  notes: [{ section: "New", lines: [line], omitted: 0 }],
  lines: [],
  intro: "Captured at update time.",
  at: "2026-01-01T00:00:00.000Z",
});

/** Every tag a test asked GitHub for, through either read. */
let asked: string[] = [];
/** Every line the read logged. */
let logged: string[] = [];

function deps(over: {
  version?: string;
  list?: ReleaseInfo[] | Error;
  byTag?: Map<string, ReleaseInfo>;
} = {}) {
  return {
    version: () => over.version ?? "9.8.1",
    fetchReleases: async () => {
      asked.push("<list>");
      if (over.list instanceof Error) throw over.list;
      return over.list ?? [];
    },
    fetchReleaseByTag: async (tag: string) => {
      asked.push(tag);
      return over.byTag?.get(tag) ?? null;
    },
    warn: (line: string) => {
      logged.push(line);
    },
  };
}

async function seed(state: Partial<UpdateNotices>): Promise<void> {
  await updateNoticesStore.save({ announcedTag: null, justUpdated: null, releaseNotes: null, ...state });
}

beforeEach(async () => {
  asked = [];
  logged = [];
  await seed({});
});

describe("which version counts as running", () => {
  test("a stored tag against the plain version the server reports", () => {
    const cases: [string, string, boolean][] = [
      ["v9.8.1", "9.8.1", true],
      ["9.8.1", "v9.8.1", true],
      ["v9.9.0-beta.3", "9.9.0-beta.3", true],
      ["v9.8.1", "9.8.10", false],
      ["v9.9.0-beta.3", "9.9.0", false],
      // A capture with no target tag, against itself as much as anything.
      ["unknown", "9.8.1", false],
      ["unknown", "unknown", false],
    ];
    for (const [a, b, same] of cases) assert.equal(sameVersion(a, b), same, `${a} vs ${b}`);
  });
});

describe("What's new answers from what the server kept", () => {
  test("after an update, the notice's own notes are shown, with no network", async () => {
    await seed({ justUpdated: notice("v9.8.1", "the captured line") });
    const r = await runningReleaseNotes(deps({ list: new Error("offline") }));
    assert.equal(r.ok, true);
    assert.ok(r.ok && r.notes[0].lines.includes("the captured line"));
    assert.deepEqual(asked, [], "it went to GitHub for notes it already had");
  });

  test("Dismiss clears the acknowledgement and keeps the notes", async () => {
    await seed({ justUpdated: notice("v9.8.1", "kept after dismiss") });
    await dismissJustUpdated("9.8.1");
    const after = await updateNoticesStore.load();
    assert.equal(after.justUpdated, null, "the after-update dialog would come back");
    const r = await runningReleaseNotes(deps({ list: new Error("offline") }));
    assert.ok(r.ok, `the notes went with the dismissal: ${JSON.stringify(r)}`);
    assert.deepEqual(r.notes[0].lines, ["kept after dismiss"]);
    assert.equal(r.intro, "Captured at update time.");
    assert.deepEqual(asked, []);
  });

  test("a tagged checkout's commit subjects are kept and shown the same way", async () => {
    // A checkout whose track has release tags captures its target tag, so the
    // notice names the running version. One on an untagged track captures
    // "unknown", which matches nothing: Dismiss drops its subjects and What's
    // new reads the release for package.json's version instead.
    await seed({
      justUpdated: { ...notice("v9.8.1", "x"), notes: [], lines: ["fix: a subject", "feat: another"], intro: null },
    });
    await dismissJustUpdated("9.8.1");
    const r = await runningReleaseNotes(deps());
    assert.ok(r.ok);
    assert.deepEqual(r.notes, []);
    assert.deepEqual(r.lines, ["fix: a subject", "feat: another"]);
  });

  test("a notice captured for an update that failed is not this version's notes", async () => {
    // The capture runs BEFORE the update, so a failed apply leaves the target's
    // notes while the old version runs. (A deferred restart is different: the
    // running version is read from package.json on disk, which the build has
    // already replaced, so its notice matches, as the card's Running line does.)
    await seed({ justUpdated: notice("v9.9.0", "the target's line") });
    const r = await runningReleaseNotes(deps({ list: [rel("v9.8.1", "the running line")] }));
    assert.ok(r.ok);
    assert.deepEqual(r.notes[0].lines, ["the running line"]);
  });

  test("notes kept for the release before are not this release's: fetched and replaced", async () => {
    // The common case after any update: the kept notes still describe the
    // previous version until the new notice is dismissed.
    await seed({
      releaseNotes: { version: "v9.8.0", notes: notice("v9.8.0", "the release before").notes, lines: [], intro: null },
    });
    const r = await runningReleaseNotes(deps({ list: [rel("v9.8.1", "the running line")] }));
    assert.ok(r.ok);
    assert.deepEqual(r.notes[0].lines, ["the running line"]);
    assert.equal((await updateNoticesStore.load()).releaseNotes?.version, "v9.8.1");
  });

  test("a fetch leaves the after-update notice for the running version exactly as it was", async () => {
    // A notice with nothing in it falls through to GitHub; keeping what comes
    // back must not touch the acknowledgement either way.
    const seeded = { ...notice("v9.8.1", "x"), notes: [], lines: [], intro: null };
    await seed({ justUpdated: seeded });
    const r = await runningReleaseNotes(deps({ list: [rel("v9.8.1", "fetched")] }));
    assert.ok(r.ok);
    assert.equal(r.source, "fetched");
    assert.deepEqual((await updateNoticesStore.load()).justUpdated, seeded);
  });

  test("a fetch leaves a notice for another version exactly as it was", async () => {
    const seeded = notice("v9.9.0", "the target's line");
    await seed({ justUpdated: seeded });
    const r = await runningReleaseNotes(deps({ list: [rel("v9.8.1", "fetched")] }));
    assert.ok(r.ok);
    assert.equal(r.source, "fetched");
    assert.deepEqual((await updateNoticesStore.load()).justUpdated, seeded);
  });

  test("a Dismiss that lands while the fetch is on its way stays dismissed", async () => {
    await seed({ justUpdated: notice("v9.9.0", "the target's line") });
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const reading = runningReleaseNotes({
      ...deps(),
      fetchReleases: async () => {
        await held;
        return [rel("v9.8.1", "fetched while dismissing")];
      },
    });
    await dismissJustUpdated("9.8.1");
    release();
    const r = await reading;
    assert.ok(r.ok);
    const s = await updateNoticesStore.load();
    assert.equal(s.justUpdated, null, "keeping the fetched notes brought the dismissed notice back");
    assert.deepEqual(s.releaseNotes?.notes[0].lines, ["fetched while dismissing"]);
  });

  test("dismissing a notice for a version not running keeps what was kept before", async () => {
    await seed({
      justUpdated: notice("v9.9.0", "the target's line"),
      releaseNotes: { version: "v9.8.1", notes: notice("v9.8.1", "kept").notes, lines: [], intro: null },
    });
    await dismissJustUpdated("9.8.1");
    const s = await updateNoticesStore.load();
    assert.equal(s.justUpdated, null);
    assert.equal(s.releaseNotes?.version, "v9.8.1");
    assert.deepEqual(s.releaseNotes?.notes[0].lines, ["kept"]);
  });
});

describe("with nothing kept, the running release is fetched", () => {
  test("from the release list, then kept for next time", async () => {
    const r = await runningReleaseNotes(deps({ list: [rel("v9.8.1", "from GitHub")] }));
    assert.ok(r.ok);
    assert.equal(r.source, "fetched");
    assert.deepEqual(r.notes[0].lines, ["from GitHub"]);
    assert.equal(r.intro, "Nothing to do to install this.");

    asked = [];
    const again = await runningReleaseNotes(deps({ list: new Error("offline") }));
    assert.ok(again.ok, "what was fetched was not kept");
    assert.equal(again.source, "kept");
    assert.deepEqual(asked, []);
  });

  test("by its tag when the list no longer carries it", async () => {
    // The list is the 30 newest plus the newest stable. A stable box one
    // release behind, with 30 betas since, is on neither.
    const list = Array.from({ length: 30 }, (_, i) => rel(`v9.9.0-beta.${30 - i}`, "a beta"));
    list.push(rel("v9.8.2", "the newer stable"));
    const r = await runningReleaseNotes(
      deps({ list, byTag: new Map([["v9.8.1", rel("v9.8.1", "found by tag")]]) }),
    );
    assert.ok(r.ok);
    assert.deepEqual(r.notes[0].lines, ["found by tag"]);
    assert.deepEqual(asked, ["<list>", "v9.8.1"]);
  });

  test("always the RUNNING release, never the one waiting to install", async () => {
    // With v9.9.0 waiting, the list carries both. Its notes describe the next
    // release, which is the bug the card warns about.
    const r = await runningReleaseNotes(
      deps({ list: [rel("v9.9.0", "the waiting release"), rel("v9.8.1", "the running release")] }),
    );
    assert.ok(r.ok);
    assert.deepEqual(r.notes[0].lines, ["the running release"]);
  });

  test("a beta shows that beta's own notes", async () => {
    const r = await runningReleaseNotes(
      deps({
        version: "9.9.0-beta.3",
        list: [rel("v9.9.0-beta.4", "the next beta"), rel("v9.9.0-beta.3", "this beta"), rel("v9.9.0-beta.2", "the beta before")],
      }),
    );
    assert.ok(r.ok);
    assert.deepEqual(r.notes[0].lines, ["this beta"]);
  });
});

describe("when the notes cannot be had", () => {
  test("offline: a failure naming the tag, one log line, nothing kept", async () => {
    const r = await runningReleaseNotes(deps({ list: new Error("getaddrinfo ENOTFOUND api.github.com") }));
    assert.equal(r.ok, false);
    assert.equal(r.version, "9.8.1");
    assert.match(r.releaseUrl, /\/releases\/tag\/v9\.8\.1$/);
    assert.equal(logged.length, 1, `expected exactly one line, got:\n${logged.join("\n")}`);
    assert.match(logged[0], /^\[updater\] .*v9\.8\.1.*ENOTFOUND/);
    // A failure is not an answer to keep: the next press, online, must fetch.
    assert.equal((await updateNoticesStore.load()).releaseNotes, null);
    const online = await runningReleaseNotes(deps({ list: [rel("v9.8.1", "back online")] }));
    assert.ok(online.ok, "a failure was remembered and served again once GitHub was back");
    assert.deepEqual(online.notes[0].lines, ["back online"]);
  });

  test("a release GitHub does not have is a failure, not an empty dialog", async () => {
    const r = await runningReleaseNotes(deps({ list: [] }));
    assert.equal(r.ok, false);
    assert.equal(logged.length, 1);
    assert.match(logged[0], /v9\.8\.1/);
  });

  test("a release whose notes list nothing is a failure, not an empty dialog", async () => {
    const empty: ReleaseInfo = { ...rel("v9.8.1", "x"), body: "## Install\n\n```bash\ncurl example\n```\n" };
    const r = await runningReleaseNotes(deps({ list: [empty] }));
    assert.equal(r.ok, false);
    assert.equal(logged.length, 1);
    assert.equal((await updateNoticesStore.load()).releaseNotes, null);
  });

  test("a version that is no release tag fails without asking GitHub", async () => {
    const r = await runningReleaseNotes(deps({ version: "0.0.0", list: [rel("v9.8.1", "x")] }));
    assert.equal(r.ok, false);
    assert.deepEqual(asked, []);
    assert.equal(logged.length, 1);
  });
});

describe("the stored file, as older builds wrote it", () => {
  test("a file with no kept notes reads, and the first Dismiss keeps them", async () => {
    // The first update INTO this build: the notice was written by the old
    // server, which knew nothing of the kept field.
    await fs.writeFile(
      FILE,
      JSON.stringify({ announcedTag: "v9.8.1", justUpdated: notice("v9.8.1", "written by the old server") }),
    );
    await updateNoticesStore.reload();
    const s = await updateNoticesStore.load();
    assert.equal(s.releaseNotes, null);
    assert.equal(s.announcedTag, "v9.8.1");

    await dismissJustUpdated("9.8.1");
    const r = await runningReleaseNotes(deps({ list: new Error("offline") }));
    assert.ok(r.ok);
    assert.deepEqual(r.notes[0].lines, ["written by the old server"]);
  });

  test("a notice missing its lists reads, and What's new and Dismiss still work", async () => {
    // A notice is written by the server BEFORE the update, so whatever shape the
    // older build wrote is what this one reads.
    const { lines: _lines, ...noLines } = notice("v9.8.1", "a notice with no lines field");
    await fs.writeFile(FILE, JSON.stringify({ announcedTag: null, justUpdated: { ...noLines, notes: "junk" } }));
    await updateNoticesStore.reload();
    const s = await updateNoticesStore.load();
    assert.deepEqual(s.justUpdated?.lines, []);
    assert.deepEqual(s.justUpdated?.notes, []);
    // Nothing usable in it, so What's new goes to GitHub rather than throwing.
    const r = await runningReleaseNotes(deps({ list: [rel("v9.8.1", "from GitHub")] }));
    assert.ok(r.ok);
    await dismissJustUpdated("9.8.1");
    assert.equal((await updateNoticesStore.load()).justUpdated, null);
  });

  test("a notice with no version reads as no notice, so What's new and Dismiss do not throw", async () => {
    const { version: _v, ...noVersion } = notice("v9.8.1", "no version");
    await fs.writeFile(FILE, JSON.stringify({ announcedTag: null, justUpdated: { ...noVersion, version: 7 } }));
    await updateNoticesStore.reload();
    assert.equal((await updateNoticesStore.load()).justUpdated, null);
    const r = await runningReleaseNotes(deps({ list: [rel("v9.8.1", "from GitHub")] }));
    assert.ok(r.ok);
    await dismissJustUpdated("9.8.1");
  });

  test("a section's note and omitted are kept only when they are the right type", async () => {
    await fs.writeFile(
      FILE,
      JSON.stringify({
        announcedTag: null,
        justUpdated: {
          ...notice("v9.8.1", "x"),
          notes: [
            { section: "New", lines: ["a"], omitted: "3", note: 5 },
            { section: "Fixed", lines: ["b"], omitted: 2, note: "held back" },
          ],
        },
        releaseNotes: { version: "v9.8.1", notes: [{ section: "New", lines: ["c"], note: ["x"] }], lines: [] },
      }),
    );
    await updateNoticesStore.reload();
    const s = await updateNoticesStore.load();
    assert.deepEqual(s.justUpdated?.notes, [
      { section: "New", lines: ["a"], omitted: 0 },
      { section: "Fixed", lines: ["b"], omitted: 2, note: "held back" },
    ]);
    assert.deepEqual(s.releaseNotes?.notes, [{ section: "New", lines: ["c"], omitted: 0 }]);
  });

  test("a malformed kept entry reads as nothing kept rather than throwing", async () => {
    await fs.writeFile(
      FILE,
      JSON.stringify({ announcedTag: null, justUpdated: null, releaseNotes: { version: 4, notes: "no" } }),
    );
    await updateNoticesStore.reload();
    assert.equal((await updateNoticesStore.load()).releaseNotes, null);
  });

  test("junk sections inside a kept entry are dropped, the rest kept", async () => {
    await fs.writeFile(
      FILE,
      JSON.stringify({
        announcedTag: null,
        justUpdated: null,
        releaseNotes: {
          version: "v9.8.1",
          notes: [null, { section: "New", lines: ["good"], omitted: 0 }, { section: "Fixed", lines: [3] }],
          lines: "no",
        },
      }),
    );
    await updateNoticesStore.reload();
    const kept = (await updateNoticesStore.load()).releaseNotes;
    assert.deepEqual(kept, {
      version: "v9.8.1",
      notes: [{ section: "New", lines: ["good"], omitted: 0 }],
      lines: [],
      intro: null,
    });
  });

  test("a file that is not an object at all reads as the defaults", async () => {
    await fs.writeFile(FILE, JSON.stringify(["not", "a", "store"]));
    await updateNoticesStore.reload();
    assert.deepEqual(await updateNoticesStore.load(), { announcedTag: null, justUpdated: null, releaseNotes: null });
  });
});
