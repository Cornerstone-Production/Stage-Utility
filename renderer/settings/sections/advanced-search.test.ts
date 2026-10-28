// advanced-search.test.ts — the Advanced search matcher, over its own small list
// and over the real registry for the cases the maintainer named.

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { damerauLevenshtein, RANK, searchSettings, typoBudget, wordsOf, type Searchable } from "./advanced-search.js";
import { ADVANCED_SETTINGS, ADVANCED_TABS } from "./advanced-settings.js";

const TAB_ORDER = ADVANCED_TABS.map((t) => t.id);

function s(id: string, name: string, description = "", keywords: string[] = [], tab = "general"): Searchable {
  return { id, tab, name, description, keywords };
}

const ids = (hits: { setting: { id: string } }[]) => hits.map((h) => h.setting.id);
const real = (q: string) => ids(searchSettings(ADVANCED_SETTINGS, q, TAB_ORDER));

describe("words and distance", () => {
  test("words are lowercase alphanumeric runs", () => {
    assert.deepEqual(wordsOf("Public address (DNS), re-enter 12h"), ["public", "address", "dns", "re", "enter", "12h"]);
  });

  test("a swap of neighbours is one edit", () => {
    assert.equal(damerauLevenshtein("snapshot", "snapshto"), 1);
    assert.equal(damerauLevenshtein("kitten", "sitting"), 3);
    assert.equal(damerauLevenshtein("", "abc"), 3);
  });

  test("the typo budget grows with the word", () => {
    assert.deepEqual([3, 4, 7, 8, 12].map((n) => typoBudget("x".repeat(n))), [0, 1, 1, 2, 2]);
  });
});

describe("matching", () => {
  const list = [
    s("a", "Reconnects", "Retry when gear is off."),
    s("b", "Config snapshot", "Save or restore everything.", ["backup", "export"]),
    s("c", "Upload and restore", "Pick a file.", ["backup"]),
  ];

  test("is case-insensitive", () => {
    assert.deepEqual(ids(searchSettings(list, "RECONNECTS", TAB_ORDER)), ["a"]);
  });

  test("every query word must match, in any order", () => {
    assert.deepEqual(ids(searchSettings(list, "restore backup", TAB_ORDER)).sort(), ["b", "c"]);
    assert.deepEqual(ids(searchSettings(list, "backup restore", TAB_ORDER)).sort(), ["b", "c"]);
    assert.deepEqual(ids(searchSettings(list, "restore reconnects", TAB_ORDER)), []);
  });

  test("a word matches the start of a word, never the middle", () => {
    assert.deepEqual(ids(searchSettings(list, "recon", TAB_ORDER)), ["a"]);
    assert.deepEqual(ids(searchSettings(list, "snap", TAB_ORDER)), ["b"]);
    assert.deepEqual(ids(searchSettings(list, "nect", TAB_ORDER)), []);
  });

  test("an empty or blank query matches nothing", () => {
    assert.deepEqual(searchSettings(list, "", TAB_ORDER), []);
    assert.deepEqual(searchSettings(list, "  ?! ", TAB_ORDER), []);
  });

  test("hidden keywords match", () => {
    assert.deepEqual(ids(searchSettings(list, "export", TAB_ORDER)), ["b"]);
  });
});

describe("typo tolerance", () => {
  const list = [s("a", "Reconnects", "Retry."), s("b", "Time zone", "Which zone."), s("c", "Context bar", "The bar.")];

  test("a name word is matched one edit away at five to seven letters", () => {
    assert.deepEqual(ids(searchSettings(list, "contxt", TAB_ORDER)), ["c"]);
    assert.deepEqual(ids(searchSettings(list, "conetxt", TAB_ORDER)), ["c"]);
  });

  test("two edits are allowed from eight letters, and not before", () => {
    assert.deepEqual(ids(searchSettings(list, "recnonects", TAB_ORDER)), ["a"]);
    assert.deepEqual(ids(searchSettings(list, "recnoncts", TAB_ORDER)), ["a"]);
    assert.deepEqual(ids(searchSettings(list, "cntxet", TAB_ORDER)), []);
  });

  test("a typo can be of the start of a longer name word", () => {
    assert.deepEqual(ids(searchSettings(list, "reconect", TAB_ORDER)), ["a"]);
    assert.deepEqual(ids(searchSettings(list, "reconn3", TAB_ORDER)), ["a"]);
  });

  test("words under four letters never fuzzy-match", () => {
    assert.deepEqual(ids(searchSettings(list, "tmie", TAB_ORDER)), ["b"]);
    assert.deepEqual(ids(searchSettings(list, "zon", TAB_ORDER)), ["b"]);
    assert.deepEqual(ids(searchSettings(list, "zno", TAB_ORDER)), []);
    assert.deepEqual(ids(searchSettings(list, "bat", TAB_ORDER)), []);
  });

  test("never in descriptions or keywords", () => {
    const only = [s("d", "Alpha", "Describes everything thoroughly.", ["keyword"])];
    assert.deepEqual(ids(searchSettings(only, "thorughly", TAB_ORDER)), []);
    assert.deepEqual(ids(searchSettings(only, "keywrd", TAB_ORDER)), []);
    assert.deepEqual(ids(searchSettings(only, "alpah", TAB_ORDER)), ["d"]);
  });
});

describe("ranking", () => {
  test("exact name word, name prefix, keyword, description, in that order", () => {
    const list = [
      s("desc", "Other", "Mentions zebras here."),
      s("kw", "Another", "", ["zebras"]),
      s("prefix", "Zebras forever"),
      s("exact", "Zebra"),
    ];
    assert.deepEqual(
      searchSettings(list, "zebra", TAB_ORDER).map((h) => [h.setting.id, h.rank]),
      [
        ["exact", RANK.nameWord],
        ["prefix", RANK.namePrefix],
        ["kw", RANK.keyword],
        ["desc", RANK.description],
      ],
    );
  });

  test("a typo ranks below a description match", () => {
    const list = [s("typo", "Reconnects"), s("desc", "Other", "We recnnect things.")];
    const hits = searchSettings(list, "recnnect", TAB_ORDER);
    assert.deepEqual(hits.map((h) => [h.setting.id, h.rank]), [["desc", RANK.description], ["typo", RANK.typo]]);
  });

  test("results stay grouped by tab in tab order, ranked within each tab", () => {
    const list = [
      s("n-desc", "Other", "has zebra inside", [], "network"),
      s("g-name", "Zebra", "", [], "general"),
      s("n-name", "Zebra", "", [], "network"),
      s("g-desc", "Other", "has zebra inside", [], "general"),
    ];
    assert.deepEqual(ids(searchSettings(list, "zebra", TAB_ORDER)), ["g-name", "g-desc", "n-name", "n-desc"]);
  });
});

describe("the real registry", () => {
  test("restore backup finds Upload and restore under Backups", () => {
    assert.ok(real("restore backup").includes("config-snapshot"));
  });

  test("the words people type find their setting", () => {
    const cases: [string, string][] = [
      ["timezone", "timezone"],
      ["tz", "timezone"],
      ["dns", "public-address"],
      ["url", "public-address"],
      ["domain", "public-address"],
      ["rtsp", "video-relay-ports"],
      ["webrtc", "video-relay-ports"],
      ["ice", "video-relay-ports"],
      ["ports", "video-relay-ports"],
      ["branch", "update-track"],
      ["channel", "update-track"],
      ["beta", "update-track"],
      ["recon", "reconnect-wake"],
      ["snap", "config-snapshot"],
      ["restore", "config-snapshot"],
      ["export", "config-snapshot"],
    ];
    for (const [q, id] of cases) assert.ok(real(q).includes(id), `"${q}" does not find ${id}`);
  });

  test("a misspelt name still finds the setting", () => {
    assert.ok(real("snapshto").includes("config-snapshot"));
    assert.ok(real("intervl").includes("reconnect-idle"));
  });

  test("a card's heading finds every setting under it, misspelt or not", () => {
    // Reconnects is only a card heading: no setting is named for it, so without
    // the card in the index "reconnect" found nothing at all.
    const reconnects = ADVANCED_SETTINGS.filter((x) => x.card === "Reconnects").map((x) => x.id);
    assert.deepEqual(real("reconnect"), reconnects);
    assert.deepEqual(real("reconect"), reconnects);
    // Not a keyword typo: "atendance" is one edit from the Attendance sampling card.
    assert.deepEqual(real("atendance"), ADVANCED_SETTINGS.filter((x) => x.card === "Attendance sampling").map((x) => x.id));
  });

  test("a name word outranks a description mention", () => {
    const hits = searchSettings(ADVANCED_SETTINGS, "snapshot", TAB_ORDER).filter((h) => h.setting.tab === "data");
    assert.equal(hits[0].setting.id, "config-snapshot");
  });
});
