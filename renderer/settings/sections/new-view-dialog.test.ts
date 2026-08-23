import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// KIND_LABELS is Record<ViewKind, string>, so the type checker already refuses a
// missing label. KIND_ORDER is a plain array and gets no such help - and it is
// the list the dialog actually renders. Retyping this list from memory while
// extracting the dialog silently dropped "stage" and "spl-rundown": both kinds
// became uncreatable and nothing failed.
//
// So: assert the rendered order covers exactly the labelled set. Read as source
// text rather than imported, because importing the .tsx pulls in the whole UI
// tree for a check about two literal lists.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(HERE, "new-view-dialog.tsx"), "utf8");

function labelledKinds(src: string): string[] {
  const block = /const KIND_LABELS: Record<ViewKind, string> = \{([\s\S]*?)\n\};/.exec(src);
  assert.ok(block, "could not find KIND_LABELS — this scan is broken, not passing");
  return [...block[1].matchAll(/^\s*"?([\w-]+)"?\s*:/gm)].map((m) => m[1]);
}

function orderedKinds(src: string): string[] {
  const line = /const KIND_ORDER: ViewKind\[\] = \[([^\]]*)\];/.exec(src);
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
    for (const kind of ["stage", "spl-rundown", "slots", "dashboard", "transcription", "script", "custom", "signage"]) {
      assert.ok(order.includes(kind), `"${kind}" is not offered by the new-view dialog`);
    }
  });
});
