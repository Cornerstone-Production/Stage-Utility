// pdf-raster.ts: the size arithmetic, and renderPage's choice of PNG or JPEG
// through a stand-in pdf.js and canvas. Real rendering is not unit-tested: jsdom
// has no canvas, and pdf.js loads its worker through Vite's ?url import, which
// only a browser build resolves. The page picker is driven in a real browser.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { JPEG_RASTER_QUALITY, PNG_RASTER_MAX_BYTES, loadPdf, pageIn, sendAsJpeg, sizeForLongEdge } from "./pdf-raster";

describe("sizeForLongEdge", () => {
  test("a landscape Letter page comes out 2400 on its long edge", () => {
    assert.deepEqual(sizeForLongEdge({ width: 792, height: 612 }, 2400), { scale: 2400 / 792, width: 2400, height: 1855 });
  });

  test("a portrait A4 page comes out 2400 tall", () => {
    const s = sizeForLongEdge({ width: 595.28, height: 841.89 }, 2400);
    assert.equal(s.height, 2400);
    assert.equal(s.width, 1697);
  });

  test("a thumbnail size works the same way and never rounds to zero", () => {
    assert.deepEqual(sizeForLongEdge({ width: 1000, height: 1 }, 120), { scale: 0.12, width: 120, height: 1 });
  });
});

describe("pageIn", () => {
  test("clamps into the document, 1-based", () => {
    assert.equal(pageIn(0, 3), 1);
    assert.equal(pageIn(2, 3), 2);
    assert.equal(pageIn(9, 3), 3);
    assert.equal(pageIn(Number.NaN, 3), 1);
  });
});

describe("sendAsJpeg", () => {
  test("a page PNG over 10 MB goes up as a JPEG; one at or under stays a PNG", () => {
    assert.equal(PNG_RASTER_MAX_BYTES, 10 * 1024 * 1024);
    assert.equal(sendAsJpeg(PNG_RASTER_MAX_BYTES), false);
    assert.equal(sendAsJpeg(PNG_RASTER_MAX_BYTES + 1), true);
    assert.equal(sendAsJpeg(500_000), false);
  });
});

describe("renderPage", () => {
  // The real wiring around a stand-in pdf.js and canvas: what renderPage hands
  // back for a page whose PNG is small, and for one whose PNG is not.
  async function render(pngBytes: number): Promise<{ blob: Blob; asked: string[] }> {
    const asked: string[] = [];
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({}),
      toBlob(cb: (b: Blob | null) => void, type: string, quality?: number) {
        asked.push(quality === undefined ? type : `${type}@${quality}`);
        cb(new Blob([new Uint8Array(type === "image/png" ? pngBytes : 1000)], { type }));
      },
    };
    const page = {
      getViewport: ({ scale }: { scale: number }) => ({ width: 792 * scale, height: 612 * scale }),
      render: () => ({ promise: Promise.resolve() }),
    };
    const fakePdfjs = {
      getDocument: () => ({ promise: Promise.resolve({ numPages: 1, getPage: async () => page }), destroy: async () => {} }),
    } as unknown as Pick<typeof import("pdfjs-dist"), "getDocument">;
    const g = globalThis as unknown as { document?: unknown };
    const real = g.document;
    g.document = { createElement: () => canvas };
    try {
      const pdf = await loadPdf(new ArrayBuffer(8), async () => fakePdfjs);
      return { blob: await pdf.renderPage(1, 2400), asked };
    } finally {
      g.document = real;
    }
  }

  test("a page whose PNG is small goes up as that PNG", async () => {
    const { blob, asked } = await render(2 * 1024 * 1024);
    assert.equal(blob.type, "image/png");
    assert.deepEqual(asked, ["image/png"]);
  });

  test("a page whose PNG passes 10 MB goes up as a JPEG at 0.92", async () => {
    const { blob, asked } = await render(PNG_RASTER_MAX_BYTES + 1);
    assert.equal(blob.type, "image/jpeg");
    assert.deepEqual(asked, ["image/png", `image/jpeg@${JPEG_RASTER_QUALITY}`]);
  });
});
