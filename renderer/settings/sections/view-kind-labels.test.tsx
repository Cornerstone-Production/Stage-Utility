// The View kind whose id is "script" is shown to people as ServiceCue.
//
// The id is a persisted value saved inside every views.json, so it stays; only
// the label moved. Both tables an operator can read the name from are checked by
// RUNNING them: the picker's label, and the name a new View is given when the
// operator types none. A source scan would be satisfied by a comment.

import { strict as assert } from "node:assert";
import { after, describe, test } from "node:test";

import { installDom } from "../../test-dom.js";

const teardown = installDom();

const { KIND_LABELS, KIND_ORDER } = await import("./new-view-dialog.js");
const { defaultViewName } = await import("../../../main/services/layout-clone.js");

after(() => teardown());

describe("the view kind picker", () => {
  test("the script kind is labelled ServiceCue, and is still offered", () => {
    assert.equal(KIND_LABELS.script, "ServiceCue");
    assert.ok(KIND_ORDER.includes("script"), "the script kind id is unchanged and still creatable");
  });

  test("a new ServiceCue view with no typed name is called ServiceCue", () => {
    assert.equal(defaultViewName("script"), "ServiceCue");
  });
});
