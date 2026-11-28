// slug.ts must give every existing caller the bytes its own copy gave. The LEGACY
// functions below are those copies as they stood before they were merged; a slug that
// is stored or re-derived (service-type addresses, feed ids, venue addresses, role ids,
// archive ids) must come out identical for every name an install could hold.

import assert from "node:assert/strict";
import { after, test } from "node:test";

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { slugText } from "./slug.js";

// The real callers, reached through their exports, so a caller that changes the options it
// passes is caught. Stores read their data dir on import, so it is an empty one.
const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-slug-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");
const { slugify } = await import("./servicecue-slug.js");
const { filenameSlug } = await import("./export-filename.js");
const { feedIdFor } = await import("./video/feed-id.js");
const { slugFromName } = await import("./stageplots-store.js");
const { idFor } = await import("./servicecue-roles-store.js");
const { titleSlug } = await import("./archive/rebuild.js");
after(() => fs.rm(TMP, { recursive: true, force: true }));

const legacy = {
  servicecue: (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "x",
  feed: (name: string) =>
    name.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 36).replace(/-+$/g, "") || "feed",
  venue: (name: string) =>
    name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "") || "venue",
  role: (name: string) => `role-${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`,
  archive: (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "untitled",
  filename: (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, ""),
  layoutFile: (name: string) => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "layout",
};

const INPUTS = [
  "", " ", "!!!", "The Gathering", "  Sunday  Service  ", "Звук", "Café Lumière", "Ångström & Co.", "naïve résumé",
  "a--b", "-lead-", "UPPER lower 123", "Ａｂｃ full width", "ﬁne ligature", "देवनागरी a", "aाb", "é", "x".repeat(80), `${"ab ".repeat(30)}`,
  `${"a".repeat(35)} b`, `${"a".repeat(36)}-b`, `${"a".repeat(59)} b`, `${"a".repeat(60)}-b`, "Plan: 10/12 (Early) #2", "tab\tnew\nline", "😀 emoji only", "😀 a",
];

test("every caller's slug is byte-identical to its pre-merge copy", () => {
  const rows: string[] = [];
  for (const input of INPUTS) {
    const got = {
      servicecue: slugify(input),
      feed: feedIdFor(input, new Set()),
      venue: slugFromName(input, () => false),
      role: idFor(input, new Set()),
      archive: titleSlug(input),
      filename: filenameSlug(input),
      // renderer/app/mic-slots/download.ts keeps its own copy (a file another branch is
      // changing), so this row pins the option set it will move to, not the file.
      layoutFile: slugText(input, { fallback: "layout" }),
    };
    for (const k of Object.keys(got) as (keyof typeof got)[]) {
      const want = legacy[k](input);
      if (got[k] !== want) rows.push(`${k}(${JSON.stringify(input)}): ${JSON.stringify(got[k])} != ${JSON.stringify(want)}`);
    }
  }
  assert.deepEqual(rows, []);
});

test("the two folds are different rules, on purpose", () => {
  assert.notEqual(slugText("aाb", { fold: "marks" }), slugText("aाb", { fold: "combining" }));
});
