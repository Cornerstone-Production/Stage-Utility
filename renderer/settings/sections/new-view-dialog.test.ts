import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// KIND_LABELS is Record<ViewKind, string>, so the type checker already refuses a
// missing label. KIND_ORDER used to be a plain array and got no such help - and
// it is the list the dialog actually renders. Retyping this list from memory
// while extracting the dialog silently dropped "stage" and "spl-rundown": both
// kinds became uncreatable and nothing failed.
//
// KIND_ORDER now goes through everyViewKind(), so the compiler names a kind left
// out of it. This file stays as a SECOND, independent net: it checks the two
// lists against each other rather than each against ViewKind, so it still catches
// a label with no slot in the order, and it survives everyViewKind itself being
// weakened. Read as source text rather than imported, because importing the .tsx
// pulls in the whole UI tree for a check about two literal lists.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(HERE, "new-view-dialog.tsx"), "utf8");

function labelledKinds(src: string): string[] {
  const block = /const KIND_LABELS: Record<ViewKind, string> = \{([\s\S]*?)\n\};/.exec(src);
  assert.ok(block, "could not find KIND_LABELS — this scan is broken, not passing");
  return [...block[1].matchAll(/^\s*"?([\w-]+)"?\s*:/gm)].map((m) => m[1]);
}

function orderedKinds(src: string): string[] {
  const line = /const KIND_ORDER = everyViewKind\(\[([^\]]*)\]\);/.exec(src);
  assert.ok(line, "could not find KIND_ORDER — this scan is broken, not passing");
  return [...line[1].matchAll(/"([\w-]+)"/g)].map((m) => m[1]);
}

describe("the new-view dialog offers every view kind", () => {
  test("the scan finds both lists, so it cannot pass vacuously", () => {
    assert.ok(labelledKinds(SRC).length >= 5, "KIND_LABELS scan found too few entries");
    assert.ok(orderedKinds(SRC).length >= 5, "KIND_ORDER scan found too few entries");
  });

  test("every labelled kind is offered, and nothing extra is", () => {
    assert.deepEqual(
      [...orderedKinds(SRC)].sort(),
      [...labelledKinds(SRC)].sort(),
      "KIND_ORDER and KIND_LABELS disagree — a kind is either uncreatable or unlabelled",
    );
  });

  test("the two kinds that were dropped are present", () => {
    // Named explicitly: these are the ones that actually went missing, and a
    // set-equality check alone would stay green if BOTH lists lost them.
    const order = orderedKinds(SRC);
    for (const kind of ["stage", "spl-rundown", "slots", "dashboard", "transcription", "script", "calendar", "custom"]) {
      assert.ok(order.includes(kind), `"${kind}" is not offered by the new-view dialog`);
    }
  });
});
