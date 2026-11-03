import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { LayoutObject } from "@main/types/views";
import { ALSO_SHOWN_NOTE, editorNote } from "./editor-note.js";

const card = (type: string) => ({ id: type, config: { type } }) as unknown as LayoutObject;

describe("editorNote", () => {
  it("Readiness says it is also shown by Needs attention when both are placed", () => {
    const readiness = card("home-readiness");
    assert.equal(editorNote(readiness, [readiness, card("home-attention")]), ALSO_SHOWN_NOTE);
  });

  it("says nothing without Needs attention, and nothing on any other card", () => {
    const readiness = card("home-readiness");
    assert.equal(editorNote(readiness, [readiness]), null);
    assert.equal(editorNote(card("home-attention"), [readiness, card("home-attention")]), null);
    assert.equal(editorNote(card("home-spl"), [card("home-attention")]), null);
  });
});
