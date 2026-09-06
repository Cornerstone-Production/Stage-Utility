// Guard for the retired-object conversion in the inspector.
//
// Every retired layout-object type carries a `convert` function that builds
// its replacement config. Before this test existed, the inspector hardcoded
// ONE conversion (service-order -> view-embed) for all five retired types, so
// selecting a retired YouTube status tile showed the Service-order caveat and
// a button that turned it into an Embedded view. This walks every spec with
// `retired` and proves its own `convert` produces the type it claims to.

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import type { LayoutObjectType } from "../../main/types/stage.js";
import { LAYOUT_OBJECTS } from "./layout-objects.js";

// Exact count, not a floor: a sixth retirement without a conversion must fail
// this test rather than slip through on a >= check.
const EXPECTED_RETIRED_COUNT = 5;

describe("retired layout objects convert to their own replacement", () => {
  const retiredTypes = (Object.keys(LAYOUT_OBJECTS) as LayoutObjectType[]).filter(
    (t) => LAYOUT_OBJECTS[t].retired,
  );

  test("exactly the five known retirements carry a `retired` block", () => {
    assert.equal(retiredTypes.length, EXPECTED_RETIRED_COUNT);
    assert.deepEqual(
      retiredTypes.sort(),
      [
        "home-recording-obs",
        "home-recording-reaper",
        "home-streaming-resi",
        "home-streaming-youtube",
        "service-order",
      ].sort(),
    );
  });

  for (const t of [
    "service-order",
    "home-recording-obs",
    "home-recording-reaper",
    "home-streaming-resi",
    "home-streaming-youtube",
  ] as LayoutObjectType[]) {
    test(`${t} converts to its replacedBy type`, () => {
      const spec = LAYOUT_OBJECTS[t];
      const retired = spec.retired;
      assert.ok(retired, `${t} must declare retired`);
      const converted = retired!.convert(spec.config(), { scriptViewId: "v1" });
      assert.equal(converted.type, retired!.replacedBy, `${t} must convert to ${retired!.replacedBy}`);
    });
  }

  test("service-order picks the given script view id", () => {
    const retired = LAYOUT_OBJECTS["service-order"].retired!;
    const converted = retired.convert(LAYOUT_OBJECTS["service-order"].config(), { scriptViewId: "v1" });
    assert.equal(converted.type, "view-embed");
    assert.equal((converted as { viewId: string | null }).viewId, "v1");
  });

  test("service-order leaves viewId null when ambiguous", () => {
    const retired = LAYOUT_OBJECTS["service-order"].retired!;
    const converted = retired.convert(LAYOUT_OBJECTS["service-order"].config(), { scriptViewId: null });
    assert.equal((converted as { viewId: string | null }).viewId, null);
  });

  test("home-recording-obs converts with recorder 'obs'", () => {
    const retired = LAYOUT_OBJECTS["home-recording-obs"].retired!;
    const converted = retired.convert(LAYOUT_OBJECTS["home-recording-obs"].config(), { scriptViewId: null });
    assert.equal((converted as { recorder?: string }).recorder, "obs");
  });

  test("home-recording-reaper converts with recorder 'reaper'", () => {
    const retired = LAYOUT_OBJECTS["home-recording-reaper"].retired!;
    const converted = retired.convert(LAYOUT_OBJECTS["home-recording-reaper"].config(), { scriptViewId: null });
    assert.equal((converted as { recorder?: string }).recorder, "reaper");
  });

  test("home-streaming-resi converts with platform 'resi'", () => {
    const retired = LAYOUT_OBJECTS["home-streaming-resi"].retired!;
    const converted = retired.convert(LAYOUT_OBJECTS["home-streaming-resi"].config(), { scriptViewId: null });
    assert.equal((converted as { platform?: string }).platform, "resi");
  });

  test("home-streaming-youtube converts with platform 'youtube'", () => {
    const retired = LAYOUT_OBJECTS["home-streaming-youtube"].retired!;
    const converted = retired.convert(LAYOUT_OBJECTS["home-streaming-youtube"].config(), { scriptViewId: null });
    assert.equal((converted as { platform?: string }).platform, "youtube");
  });
});
