// Prep tags: the capsule a person brings to a mic, and whether they wear their own
// in-ears, read from Planning Center person tags. The parse and the fold are pure;
// PrepTagBook is the part that must never blank a slot when Planning Center is down.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PREP_RETRY_MS, PrepTagBook, buildPrepMap, parsePrepTagName, type TaggedPeople } from "./pco-prep-tags.js";
import { pcoService } from "./pco-service.js";

describe("parsePrepTagName", () => {
  it("reads a capsule tag, whatever the case or spacing", () => {
    assert.deepEqual(parsePrepTagName("Capsule: KSM9"), { kind: "capsule", value: "KSM9" });
    assert.deepEqual(parsePrepTagName("  CAPSULE :   B58a  "), { kind: "capsule", value: "B58a" });
    assert.deepEqual(parsePrepTagName("capsule:2028"), { kind: "capsule", value: "2028" });
  });

  it("reads IEMs and IEM alike, and keeps a value that has spaces or colons", () => {
    assert.deepEqual(parsePrepTagName("IEMs: Own"), { kind: "iems", value: "Own" });
    assert.deepEqual(parsePrepTagName("iem: own"), { kind: "iems", value: "own" });
    assert.deepEqual(parsePrepTagName("Capsule: Shure: SM58 beta"), { kind: "capsule", value: "Shure: SM58 beta" });
  });

  it("refuses a name that only looks like one", () => {
    for (const name of ["Capsules: KSM9", "Capsule", "Capsule:", "Capsule:   ", "My Capsule: KSM9", "IEMS Own", "Band", ""]) {
      assert.equal(parsePrepTagName(name), null, name);
    }
  });
});

const tagged = (tagName: string, ...personIds: string[]): TaggedPeople => ({ tagName, personIds });

describe("buildPrepMap", () => {
  it("combines a capsule and own in-ears for the same person", () => {
    const { map, tagCount } = buildPrepMap([tagged("Capsule: KSM9", "1", "2"), tagged("IEMs: Own", "2", "3")]);
    assert.equal(tagCount, 2);
    assert.deepEqual([...map].sort(), [
      ["1", { capsule: "KSM9", ownIems: false }],
      ["2", { capsule: "KSM9", ownIems: true }],
      ["3", { capsule: null, ownIems: true }],
    ]);
  });

  it("takes IEMs: Own in any case", () => {
    const { map } = buildPrepMap([tagged("IEMS: OWN", "1")]);
    assert.deepEqual(map.get("1"), { capsule: null, ownIems: true });
  });

  it("ignores another IEMs value, reports it once, and gives that person nothing", () => {
    const r = buildPrepMap([tagged("IEMs: Rental", "1", "2"), tagged("iems: rental", "3")]);
    assert.equal(r.map.size, 0);
    assert.deepEqual(r.unknownIemValues, ["Rental"]);
  });

  it("gives two capsules on one person to the first alphabetically, and reports it", () => {
    const r = buildPrepMap([tagged("Capsule: KSM9", "1"), tagged("Capsule: B58a", "1"), tagged("Capsule: b58A", "1")]);
    assert.deepEqual(r.map.get("1"), { capsule: "B58a", ownIems: false });
    assert.deepEqual(r.duplicateCapsules, [{ personId: "1", kept: "B58a", ignored: ["KSM9"] }]);
  });

  it("gives the same answer whatever order Planning Center lists the tags in", () => {
    const a = buildPrepMap([tagged("Capsule: KSM9", "1"), tagged("Capsule: B58a", "1")]);
    const b = buildPrepMap([tagged("Capsule: B58a", "1"), tagged("Capsule: KSM9", "1")]);
    assert.deepEqual(a.map.get("1"), b.map.get("1"));
  });

  it("does not count a tag that is not a prep tag", () => {
    const r = buildPrepMap([tagged("Band", "1"), tagged("Capsule: KSM9", "2")]);
    assert.equal(r.tagCount, 1);
    assert.equal(r.map.has("1"), false);
  });
});

/** Capture the console lines a callback writes, at any level. */
async function lines(fn: () => Promise<void>): Promise<string[]> {
  const out: string[] = [];
  const saved = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  const grab = (...a: unknown[]) => void out.push(a.map(String).join(" "));
  console.log = console.info = console.warn = console.error = grab;
  try {
    await fn();
  } finally {
    Object.assign(console, saved);
  }
  return out;
}

function bookRig(reads: Array<TaggedPeople[] | Error>) {
  let now = 1_000_000;
  let calls = 0;
  const book = new PrepTagBook(
    () => async () => {
      const next = reads[Math.min(calls++, reads.length - 1)];
      if (next instanceof Error) throw next;
      return next;
    },
    () => now,
  );
  return { book, advance: (ms: number) => void (now += ms), calls: () => calls };
}

describe("PrepTagBook", () => {
  it("logs a read only when the result changes", async () => {
    const r = bookRig([[tagged("Capsule: KSM9", "1")]]);
    const first = await lines(async () => {
      assert.deepEqual(await r.book.refresh(), { changed: true, failed: false });
    });
    assert.deepEqual(first, ["[pco-tags] read 1 tagged people from 1 tags"]);
    const second = await lines(async () => {
      assert.deepEqual(await r.book.refresh(), { changed: false, failed: false });
    });
    assert.deepEqual(second, []);
  });

  it("keeps the last good map through a failure and says so once per outage", async () => {
    const r = bookRig([[tagged("Capsule: KSM9", "1")], new Error("boom"), new Error("boom")]);
    await lines(async () => void (await r.book.refresh()));
    const out = await lines(async () => {
      for (let i = 0; i < 2; i++) {
        r.advance(PREP_RETRY_MS + 1);
        const res = await r.book.refresh();
        assert.equal(res.failed, true);
        assert.equal(res.changed, false);
      }
    });
    assert.deepEqual(out, ["[pco-tags] read failed: boom"]);
    assert.deepEqual(r.book.map.get("1"), { capsule: "KSM9", ownIems: false });
  });

  it("does not ask again inside the retry floor after a failure", async () => {
    const r = bookRig([new Error("down")]);
    await lines(async () => {
      await r.book.refresh();
      await r.book.refresh();
      await r.book.refresh();
    });
    assert.equal(r.calls(), 1);
    r.advance(PREP_RETRY_MS + 1);
    await lines(async () => void (await r.book.refresh()));
    assert.equal(r.calls(), 2);
  });

  it("starts with no prep when the first read fails", async () => {
    const r = bookRig([new Error("down")]);
    await lines(async () => void (await r.book.refresh()));
    assert.equal(r.book.map.size, 0);
  });

  it("logs an odd value once, not on every read", async () => {
    const r = bookRig([[tagged("IEMs: Rental", "1")], [tagged("IEMs: Rental", "1"), tagged("Capsule: KSM9", "2")]]);
    const a = await lines(async () => void (await r.book.refresh()));
    const b = await lines(async () => void (await r.book.refresh()));
    assert.ok(a.some((l) => l.includes("ignoring the IEMs tag value Rental")));
    assert.ok(!b.some((l) => l.includes("ignoring")));
  });

  it("logs one line per person with two capsules", async () => {
    const r = bookRig([[tagged("Capsule: KSM9", "1"), tagged("Capsule: B58a", "1")]]);
    const out = await lines(async () => void (await r.book.refresh()));
    assert.equal(out.filter((l) => l.includes("more than one capsule")).length, 1);
  });

  it("asks nothing without credentials", async () => {
    const book = new PrepTagBook(() => null);
    assert.deepEqual(await book.refresh(), { changed: false, failed: false });
  });
});

describe("pcoService.listPersonPrepTags", () => {
  type Requester = { request: (url: string, appId: string, secret: string) => Promise<unknown> };
  const svc = pcoService as unknown as Requester;
  const realRequest = svc.request;

  it("reads tag groups, then only person groups' prep tags, then those tags' people", async () => {
    pcoService.clearCache();
    const urls: string[] = [];
    svc.request = async (url: string) => {
      urls.push(url.replace("https://api.planningcenteronline.com/services/v2", ""));
      if (url.endsWith("/tag_groups?per_page=100")) {
        return { data: [
          { id: "10", attributes: { tags_for: "person" } },
          { id: "11", attributes: { tags_for: "song" } },
        ] };
      }
      if (url.includes("/tag_groups/10/tags?")) {
        return { data: [
          { id: "100", attributes: { name: "Capsule: KSM9" } },
          { id: "101", attributes: { name: "IEMs: Own" } },
          { id: "102", attributes: { name: "Drummer" } },
        ] };
      }
      if (url.includes("/tags/100/people")) return { data: [{ id: "1" }, { id: "2" }] };
      if (url.includes("/tags/101/people")) return { data: [{ id: "2" }] };
      throw new Error(`unexpected ${url}`);
    };
    try {
      const out = await pcoService.listPersonPrepTags("app", "secret");
      assert.deepEqual(out, [
        { tagName: "Capsule: KSM9", personIds: ["1", "2"] },
        { tagName: "IEMs: Own", personIds: ["2"] },
      ]);
      assert.deepEqual(urls, [
        "/tag_groups?per_page=100",
        "/tag_groups/10/tags?per_page=100",
        "/tag_groups/10/tags/100/people?per_page=100",
        "/tag_groups/10/tags/101/people?per_page=100",
      ]);
      // Cached on the LONG tier: a second call is no request at all.
      await pcoService.listPersonPrepTags("app", "secret");
      assert.equal(urls.length, 4);
    } finally {
      svc.request = realRequest;
      pcoService.clearCache();
    }
  });
});
