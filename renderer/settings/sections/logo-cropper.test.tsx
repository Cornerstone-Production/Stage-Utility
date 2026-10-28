// The crop editor's soft-image note: shown when the area being saved is smaller than
// the size the image will be drawn at, and never a refusal.
//
// The canvas export and the drag/zoom are driven in Chrome; what is here is the
// note, which needs only an image that reports a size.

import assert from "node:assert/strict";
import { after, afterEach, describe, test } from "node:test";

import { installRenderDom } from "../../test-dom.js";

const teardown = installRenderDom();
const { render, screen, cleanup, act } = await import("@testing-library/react");
const React = (await import("react")).default;
const { LogoCropper } = await import("./logo-cropper.js");

const settle = () => new Promise((r) => setTimeout(r, 0));
after(() => {
  cleanup();
  teardown();
});
afterEach(async () => {
  cleanup();
  await settle();
});

/** An `Image` that loads at once and reports `side` x `side`. Returns the undo. */
function imagesOf(side: number): () => void {
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = g.Image;
  g.Image = class {
    naturalWidth = side;
    naturalHeight = side;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(_: string) {
      queueMicrotask(() => this.onload?.());
    }
  };
  return () => {
    g.Image = saved;
  };
}

async function open(side: number, sharpFrom?: number) {
  const undo = imagesOf(side);
  try {
    await act(async () => {
      render(
        React.createElement(LogoCropper, {
          src: "data:image/png;base64,AAAA",
          noun: "icon",
          sharpFrom,
          onCancel: () => {},
          onSave: () => {},
        }),
      );
      await settle();
      await settle();
    });
  } finally {
    undo();
  }
}

describe("the soft-image note", () => {
  test("a small source says so, with the size of the area, and still lets it save", async () => {
    await open(300, 512);
    assert.ok(screen.getByText(/The area being saved is 300 × 300\./));
    assert.ok(screen.getByText(/512 × 512 or larger looks sharpest/));
    assert.equal((screen.getByRole("button", { name: "Save icon" }) as HTMLButtonElement).disabled, false, "a soft image was refused");
  });

  test("a large source says nothing", async () => {
    await open(1024, 512);
    assert.ok(screen.queryByText(/looks sharpest/) === null, "a sharp image was warned about");
  });

  test("with no threshold given (the logo, the empty slot, the avatar) there is never a note", async () => {
    await open(300);
    assert.ok(screen.queryByText(/looks sharpest/) === null, "a note appeared where none was asked for");
  });
});
