// slug.ts must give every existing caller the bytes its own copy gave. The LEGACY
// functions below are those copies as they stood before they were merged; a slug that
// is stored or re-derived (service-type addresses, feed ids, venue addresses, role ids,
// archive ids) must come out identical for every name an install could hold.

import assert from "node:assert/strict";
import { test } from "node:test";

import { slugText } from "./slug.js";

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
      servicecue: slugText(input, { fallback: "x" }),
      feed: slugText(input, { fold: "marks", max: 36, fallback: "feed" }),
      venue: slugText(input, { fold: "combining", max: 60, fallback: "venue" }),
      role: `role-${slugText(input)}`,
      archive: slugText(input, { fallback: "untitled" }),
      filename: slugText(input, { max: 60 }),
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
