// servicecue-publish.test.ts — the contract the Worker, the public page and the
// publisher all read.
//
// The lists are pinned as sorted lists, one entry per line, so adding an entry is a
// deliberate edit here and two branches adding different ones merge cleanly. What
// the type system can hold — that every public state field is a real StageState
// field of the same type — it holds, and is checked at the bottom by tsc rather
// than at run time.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { StageState } from "./state.js";
import * as contract from "./servicecue-publish.js";
import {
  ASSET_CONTENT_TYPES,
  DOCS_CHANNEL,
  FIXED_DOCS,
  FIXED_DOC_KEYS,
  FRAME_CHANNELS,
  FRAME_DOCS,
  LIVE_CHANNELS,
  PUBLISH_MAX_BODY_BYTES,
  PUBLISH_MAX_VERSION_LENGTH,
  PUBLISH_MAX_VIEWERS,
  PUBLISH_MIN_TOKEN_LENGTH,
  PUBLISH_UPCOMING_DAYS,
  PUBLIC_STATE_FIELDS,
  PUBLIC_STATIC_FILES,
  VIEWER_BUILD_META,
  assetContentType,
  docKeyForRequest,
  docPublicPath,
  filterPublicState,
  isAssetName,
  isDocKey,
  isFrameChannel,
  isPublishId,
  isRecord,
  isViewerBuildId,
  rundownKey,
  viewerBuildFromHtml,
  viewerBuildTag,
  type FixedDocKey,
  type FrameChannel,
  type LastHeartbeat,
  type PublicState,
  type PublishStatus,
} from "./servicecue-publish.js";

const sorted = <T extends string>(list: readonly T[]): T[] => [...list].sort();

describe("the lists", () => {
  test("every list is sorted", () => {
    for (const [name, list] of Object.entries({
      FIXED_DOC_KEYS,
      PUBLIC_STATE_FIELDS,
      FRAME_CHANNELS,
      LIVE_CHANNELS,
      ASSET_CONTENT_TYPES,
      PUBLIC_STATIC_FILES,
    })) {
      assert.deepEqual(list, sorted(list), `${name} is not sorted`);
    }
  });

  test("the docs with a fixed key, and the path each answers", () => {
    assert.deepEqual(
      FIXED_DOCS.map(([key, path]) => `${key} ${path}`),
      [
        "pco-live /api/pco/live",
        "plans-upcoming /api/plans/upcoming?days=60",
        "service-types /api/service-types",
        "servicecue-config /api/servicecue/config",
        "servicecue-layouts /api/servicecue/layouts",
        "servicecue-roles /api/servicecue/roles",
        "spl-current /api/spl/history/current",
        "state /api/state",
      ],
    );
  });

  test("the state fields the public page may receive", () => {
    assert.deepEqual(
      [...PUBLIC_STATE_FIELDS],
      ["accentColor", "appLogo", "appLogoMonochrome", "hourCycle", "pcoConfigured", "timezone"],
    );
  });

  test("the channels a church may send on, and the ones a viewer hears", () => {
    assert.deepEqual([...FRAME_CHANNELS], ["pco:live", "spl:history", "stage:state-changed"]);
    assert.deepEqual([...LIVE_CHANNELS], ["pco:live", "publish:docs", "publish:heartbeat", "spl:history", "stage:state-changed"]);
  });

  test("a viewer hears every channel a church may send on, and the Worker's own two besides", () => {
    assert.deepEqual(
      sorted([...FRAME_CHANNELS, "publish:heartbeat", DOCS_CHANNEL]),
      [...LIVE_CHANNELS],
      "a channel the church can send on that a viewer is never given",
    );
  });

  test("each frame is stored as a doc that exists, and the map is in the order a joining viewer is replayed them", () => {
    assert.deepEqual([...FRAME_DOCS.keys()], [...FRAME_CHANNELS], "a frame channel with no doc, a doc for no channel, or an order that is not the channels'");
    for (const docKey of FRAME_DOCS.values()) assert.ok(FIXED_DOC_KEYS.includes(docKey), `${docKey} is not a fixed doc`);
  });

  test("the numbers a publisher must agree with the Worker on", () => {
    assert.deepEqual(
      {
        PUBLISH_MAX_BODY_BYTES,
        PUBLISH_MAX_VERSION_LENGTH,
        PUBLISH_MAX_VIEWERS,
        PUBLISH_MIN_TOKEN_LENGTH,
        PUBLISH_UPCOMING_DAYS,
      },
      {
        PUBLISH_MAX_BODY_BYTES: 2_000_000,
        PUBLISH_MAX_VERSION_LENGTH: 64,
        PUBLISH_MAX_VIEWERS: 500,
        PUBLISH_MIN_TOKEN_LENGTH: 32,
        PUBLISH_UPCOMING_DAYS: 60,
      },
    );
    assert.equal(docPublicPath("plans-upcoming"), `/api/plans/upcoming?days=${PUBLISH_UPCOMING_DAYS}`, "the plans doc's path is built from the number the page asks for");
  });

  test("what the publisher imports is exported, one name to a line", () => {
    // Runtime exports only; the types it imports are named below, where tsc holds them.
    const publisherImports = [
      "ASSET_PATH_PREFIX",
      "FIXED_DOCS",
      "FIXED_DOC_KEYS",
      "FRAME_CHANNELS",
      "FRAME_DOCS",
      "PUBLIC_STATE_FIELDS",
      "PUBLISH_BASE_PATH",
      "PUBLISH_MAX_BODY_BYTES",
      "PUBLISH_MAX_VERSION_LENGTH",
      "PUBLISH_MIN_TOKEN_LENGTH",
      "PUBLISH_PROTOCOL_VERSION",
      "PUBLISH_UPCOMING_DAYS",
      "assetContentType",
      "docKeyForRequest",
      "docPublicPath",
      "isAssetName",
      "isDocKey",
      "isFrameChannel",
      "isPublishId",
      "rundownKey",
    ];
    assert.deepEqual(
      publisherImports.filter((name) => !(name in contract)),
      [],
      "a name the publisher imports is no longer exported",
    );
    assert.deepEqual(publisherImports, sorted(publisherImports));
  });

  test("the image types an asset may be, and the files served beside the page", () => {
    assert.deepEqual([...ASSET_CONTENT_TYPES], ["image/gif", "image/jpeg", "image/png", "image/svg+xml", "image/webp"]);
    assert.deepEqual(
      [...PUBLIC_STATIC_FILES],
      ["/apple-touch-icon.png", "/favicon.svg", "/icon-192.png", "/icon-512.png", "/icon-maskable-512.png", "/manifest.webmanifest"],
    );
  });
});

describe("ids, keys and names", () => {
  test("an id is 1 to 20 digits and nothing else", () => {
    for (const ok of ["0", "7", "1234567", "9".repeat(20)]) assert.equal(isPublishId(ok), true, ok);
    for (const bad of ["", "9".repeat(21), "12a", "a12", " 12", "12 ", "-1", "1.5", "１２", "12\n", "1e3"]) {
      assert.equal(isPublishId(bad), false, JSON.stringify(bad));
    }
    assert.equal(isPublishId(12), false, "a number is not an id");
    assert.equal(isPublishId(null), false);
  });

  test("a rundown key is built from digits or not at all", () => {
    assert.equal(rundownKey("12"), "rundown-12");
    assert.equal(rundownKey("12", "34"), "rundown-12-34");
    assert.equal(rundownKey("12", null), "rundown-12");
    assert.equal(rundownKey("x"), null);
    assert.equal(rundownKey("12", "x"), null);
    assert.equal(rundownKey("12", ""), null, "an empty plan id is not 'no plan'");
  });

  test("a doc key is a fixed one, or a rundown's", () => {
    for (const key of [...FIXED_DOC_KEYS, "rundown-1", "rundown-1-2", `rundown-${"9".repeat(20)}-${"9".repeat(20)}`]) {
      assert.equal(isDocKey(key), true, key);
    }
    for (const bad of ["", "rundown", "rundown-", "rundown-a", "rundown-1-", "rundown-1-2-3", "rundown--1", "State", "state ", "../state", "state/x", "rundown-1-a", `rundown-${"9".repeat(21)}`]) {
      assert.equal(isDocKey(bad), false, JSON.stringify(bad));
    }
    assert.equal(isDocKey(undefined), false);
  });

  test("an asset name is letters, digits, dot, underscore and dash, up to 100, and not only dots", () => {
    for (const ok of ["a", "logo-1234abcd.png", "A_b-c.d.e", "x".repeat(100), ".hidden", "a.."]) assert.equal(isAssetName(ok), true, ok);
    for (const bad of ["", ".", "..", "...", "x".repeat(101), "a b", "a/b", "a\\b", "a%2e", "é.png", "a\n", "a:b"]) {
      assert.equal(isAssetName(bad), false, JSON.stringify(bad));
    }
  });

  test("an asset's type is read from the header, parameters and case ignored, and is one of five", () => {
    assert.equal(assetContentType("image/png"), "image/png");
    assert.equal(assetContentType("IMAGE/SVG+XML; charset=utf-8"), "image/svg+xml");
    assert.equal(assetContentType(" image/webp "), "image/webp");
    for (const bad of [null, "", "text/html", "image/avif", "image/png/x", "application/octet-stream", "image/svg"]) {
      assert.equal(assetContentType(bad), null, String(bad));
    }
  });

  test("a frame channel is one of the three", () => {
    for (const c of FRAME_CHANNELS) assert.equal(isFrameChannel(c), true, c);
    for (const bad of ["publish:heartbeat", "publish:docs", "views:changed", "", "PCO:LIVE", null, 3]) assert.equal(isFrameChannel(bad), false, String(bad));
  });

  test("a record is an object that is not null and not a list", () => {
    for (const ok of [{}, { a: 1 }, Object.create(null)]) assert.equal(isRecord(ok), true);
    for (const bad of [null, undefined, [], [1], "x", 1, true, () => {}]) assert.equal(isRecord(bad), false, String(bad));
  });
});

describe("which doc a public GET asks for", () => {
  test("each fixed path answers its own doc, with the one query it takes", () => {
    for (const [key, path] of FIXED_DOCS) {
      const url = new URL(path, "https://x.example");
      assert.equal(docKeyForRequest(url.pathname, url.search), key, path);
      assert.equal(docPublicPath(key), path, key);
    }
  });

  test("a fixed path with any other query is no doc", () => {
    for (const [pathname, search] of [
      ["/api/state", "?x=1"],
      ["/api/state", "?plan=1"],
      ["/api/plans/upcoming", ""],
      ["/api/plans/upcoming", "?days=30"],
      ["/api/plans/upcoming", "?days=060"],
      ["/api/plans/upcoming", "?days=60&x=1"],
      ["/api/plans/upcoming", "?days=%36%30"],
      ["/api/service-types", "?x"],
    ] as const) {
      assert.equal(docKeyForRequest(pathname, search), null, `${pathname}${search}`);
    }
  });

  test("a rundown is asked for by digits, once each, and nothing else", () => {
    const ask = (search: string) => docKeyForRequest("/api/servicecue/rundown", search);
    assert.equal(ask("?serviceTypeId=12"), "rundown-12");
    assert.equal(ask("?serviceTypeId=12&planId=34"), "rundown-12-34");
    assert.equal(ask("?planId=34&serviceTypeId=12"), "rundown-12-34", "the order of the two is not part of the question");
    for (const bad of [
      "",
      "?planId=34",
      "?serviceTypeId=",
      "?serviceTypeId=abc",
      "?serviceTypeId=12&planId=abc",
      "?serviceTypeId=12&planId=",
      "?serviceTypeId=12&x=1",
      "?serviceTypeId=12&serviceTypeId=13",
      "?serviceTypeId=12&planId=1&planId=2",
      `?serviceTypeId=${"9".repeat(21)}`,
      "?serviceTypeId=-1",
      "?serviceTypeId=1.5",
      "?serviceTypeId=%20",
    ]) {
      assert.equal(ask(bad), null, bad);
    }
  });

  test("a path that is not a doc's is no doc", () => {
    for (const path of ["/", "/api", "/api/state/", "/api//state", "/API/state", "/api/servicecue/rundown/", "/api/servicecue", "/api/pco/plan-items", "/api/log", "/api/events"]) {
      assert.equal(docKeyForRequest(path, ""), null, path);
    }
  });

  test("a key names the question it answers", () => {
    assert.equal(docPublicPath("rundown-12"), "/api/servicecue/rundown?serviceTypeId=12");
    assert.equal(docPublicPath("rundown-12-34"), "/api/servicecue/rundown?serviceTypeId=12&planId=34");
    assert.equal(docPublicPath("nope"), null);
    // And that question is answered by that key, whatever builds the key.
    for (const key of ["rundown-12", "rundown-12-34"]) {
      const url = new URL(docPublicPath(key)!, "https://x.example");
      assert.equal(docKeyForRequest(url.pathname, url.search), key);
    }
  });
});

describe("the state the public page receives", () => {
  // A state as the server holds it, with fields that must never leave the building
  // and one that is dangerous as a key.
  const SERVER_STATE: Record<string, unknown> = {
    accentColor: "#2e6691",
    appLogo: "/branding-images/abc.png",
    appLogoMonochrome: false,
    hourCycle: "12h",
    pcoConfigured: true,
    timezone: "America/Chicago",
    lanUrl: "http://192.168.1.10:8788",
    remoteUrl: "http://192.168.1.10:8788",
    publicUrl: "https://example.test",
    hostTimezone: "UTC",
    views: [{ id: "v1" }],
    outputs: [{ id: "o1" }],
    chargerBays: [],
    autoUpdate: { mode: "manual" },
    serviceTypeId: "1",
    appName: "Example",
    appIcon192: "/branding-images/icon.png",
  };

  test("keeps the public fields and drops every other", () => {
    assert.deepEqual(filterPublicState(SERVER_STATE), {
      accentColor: "#2e6691",
      appLogo: "/branding-images/abc.png",
      appLogoMonochrome: false,
      hourCycle: "12h",
      pcoConfigured: true,
      timezone: "America/Chicago",
    });
  });

  test("a public field that is not there stays not there", () => {
    assert.deepEqual(filterPublicState({ pcoConfigured: false, lanUrl: "x" }), { pcoConfigured: false });
    assert.deepEqual(filterPublicState({}), {});
  });

  test("a key that is not ours is never visited, whatever its name", () => {
    const hostile = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"x":1},"pcoConfigured":true}') as unknown;
    const out = filterPublicState(hostile) as Record<string, unknown>;
    assert.deepEqual(Object.keys(out), ["pcoConfigured"]);
    assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
  });

  test("anything but an object is refused", () => {
    for (const bad of [null, undefined, "state", 1, [], [{ pcoConfigured: true }], true]) {
      assert.equal(filterPublicState(bad), null, JSON.stringify(bad));
    }
  });

  test("none of the fields the public page must never have is public", () => {
    const keptPrivate: (keyof StageState)[] = ["lanUrl", "remoteUrl", "publicUrl", "hostTimezone", "views", "outputs", "chargerBays", "autoUpdate", "serviceTypeId", "appName", "appIcon192"];
    // `keptPrivate` is typed against StageState, so a rename that left this test
    // naming a field that no longer exists is a compile error and not a vacuous pass.
    for (const field of keptPrivate) assert.ok(!(PUBLIC_STATE_FIELDS as readonly string[]).includes(field), `${field} must stay in the building`);
    for (const field of keptPrivate) assert.equal(Object.hasOwn(filterPublicState(SERVER_STATE)!, field), false, field);
  });
});

describe("the page's build id", () => {
  test("is twelve lower-case hex digits and nothing else", () => {
    for (const ok of ["0123456789ab", "ffffffffffff", "000000000000"]) assert.equal(isViewerBuildId(ok), true, ok);
    for (const bad of ["", "0123456789a", "0123456789abc", "0123456789AB", "0123456789ag", " 0123456789a", "0123456789ab\n", "x".repeat(12), 123456789012, null, undefined]) {
      assert.equal(isViewerBuildId(bad), false, JSON.stringify(bad));
    }
  });

  test("is written as one tag and read back from the document by the same functions", () => {
    const tag = viewerBuildTag("0123456789ab");
    assert.equal(tag, '<meta name="servicecue-build" content="0123456789ab" />');
    assert.equal(VIEWER_BUILD_META, "servicecue-build");
    assert.equal(viewerBuildFromHtml(`<!doctype html><html><head><title>x</title>${tag}</head><body></body></html>`), "0123456789ab");
    assert.equal(viewerBuildFromHtml(`<head>\n    ${tag.replace(" />", ">")}\n  </head>`), "0123456789ab", "a tag without the self-closing slash");
  });

  test("a tag is not written for something that is not an id", () => {
    for (const bad of ["", "short", "0123456789AB", '0123456789ab"><script>', "0123456789abc"]) {
      assert.throws(() => viewerBuildTag(bad), /not a build id/, bad);
    }
  });

  test("a document without the tag, or with one that holds no id, has none", () => {
    for (const html of [
      "<html><head></head></html>",
      "",
      '<meta name="servicecue-build" content="" />',
      '<meta name="servicecue-build" content="NOTANID" />',
      '<meta name="servicecue-build" content="0123456789ab0" />',
      '<meta name="other-build" content="0123456789ab" />',
      '<meta content="0123456789ab" name="servicecue-build" />',
    ]) {
      assert.equal(viewerBuildFromHtml(html), null, html);
    }
  });

  test("a tag named in a comment is not the document's", () => {
    const html = `<!doctype html>\n<!-- ${viewerBuildTag("aaaaaaaaaaaa")} -->\n<html><head>${viewerBuildTag("bbbbbbbbbbbb")}</head></html>`;
    assert.equal(viewerBuildFromHtml(html), "bbbbbbbbbbbb");
    assert.equal(viewerBuildFromHtml(`<!-- ${viewerBuildTag("aaaaaaaaaaaa")} --><html><head></head></html>`), null);
  });
});

// The check tsc runs. The server's StageState is assignable to PublicState exactly
// when every public field exists on it with a type the public page can use, so a
// field renamed or retyped on the server stops this file compiling instead of
// quietly sending the page nothing.
const _serverStateServesThePublicPage: PublicState = null as unknown as StageState;

// And the types the publisher imports: this file does not compile if one goes.
const _typesThePublisherImports: [FixedDocKey, FrameChannel, PublicState["hourCycle"], PublishStatus["lastHeartbeat"], LastHeartbeat] | null = null;
void _typesThePublisherImports;
void _serverStateServesThePublicPage;
