import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { KIND_LABELS, KIND_ORDER } from "./view-kinds.js";

// KIND_LABELS is Record<ViewKind, string>, so the type checker already refuses a
// missing label, and KIND_ORDER goes through everyViewKind(), so it refuses a
// kind left out of the order. This file is the SECOND, independent net, and it
// runs the real module: it compares the two lists to each other, so it still
// catches a label with no slot in the order, and it survives everyViewKind itself
// being weakened. Retyping KIND_ORDER from memory once dropped "stage" and
// "spl-rundown" and both kinds became uncreatable with nothing failing.
//
// It imports the values rather than reading the file as text: a commented-out
// entry (`// "stage",`) satisfied the old regex scan.

describe("the shared view-kinds list offers every view kind", () => {
  test("every labelled kind is offered, and nothing extra is", () => {
    assert.deepEqual(
      [...KIND_ORDER].sort(),
      Object.keys(KIND_LABELS).sort(),
      "KIND_ORDER and KIND_LABELS disagree: a kind is either uncreatable or unlabelled",
    );
  });

  test("KIND_ORDER lists no kind twice", () => {
    assert.equal(new Set(KIND_ORDER).size, KIND_ORDER.length);
  });

  test("the offered kinds are exactly this list", () => {
    // One per line, sorted: two branches that each add a kind merge without
    // conflict, and an add plus a remove cannot pass as no change.
    assert.deepEqual([...KIND_ORDER].sort(), [
      "calendar",
      "custom",
      "dashboard",
      "script",
      "slots",
      "spl-rundown",
      "stage",
      "transcription",
    ]);
  });
});
