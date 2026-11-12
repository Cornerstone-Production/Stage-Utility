// pdf-raster.ts — render a PDF page in the browser, with the pdf.js the app
// already ships.
//
// pdf.js is lazy-loaded (code-split), so only a page that renders a PDF pulls
// it in; Vite resolves the worker via ?url. Two callers: the layout renderer's
// plan-attachment object (rasterizePdf, ~1600 px wide) and the stage-plot
// background upload (loadPdf, a page at a chosen long edge as a PNG).

import { clamp } from "@main/services/clamp";

let pdfjsPromise: Promise<typeof import("pdfjs-dist")> | null = null;

export async function loadPdfjs(): Promise<typeof import("pdfjs-dist")> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const pdfjs = await import("pdfjs-dist");
      const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
      pdfjs.GlobalWorkerOptions.workerSrc = (worker as { default: string }).default;
      return pdfjs;
    })();
  }
  return pdfjsPromise;
}

type PdfDoc = Awaited<ReturnType<typeof import("pdfjs-dist")["getDocument"]>["promise"]>;

/** A page number clamped into the document, 1-based. */
export function pageIn(pageNum: number, numPages: number): number {
  return clamp(Math.round(pageNum) || 1, 1, numPages);
}

/**
 * The scale and pixel size that bring a page of `base` size (PDF points) to
 * `longEdgePx` on its long edge. The long edge comes out exactly that long.
 */
export function sizeForLongEdge(base: { width: number; height: number }, longEdgePx: number): { scale: number; width: number; height: number } {
  const scale = longEdgePx / Math.max(base.width, base.height);
  return { scale, width: Math.max(1, Math.round(base.width * scale)), height: Math.max(1, Math.round(base.height * scale)) };
}

/** Draw one page of an open document at `scaleFor(page size)` onto a fresh canvas. */
async function renderToCanvas(
  doc: PdfDoc,
  pageNum: number,
  sizeFor: (base: { width: number; height: number }) => { scale: number; width: number; height: number },
): Promise<HTMLCanvasElement> {
  const page = await doc.getPage(pageIn(pageNum, doc.numPages));
  const base = page.getViewport({ scale: 1 });
  const size = sizeFor(base);
  const viewport = page.getViewport({ scale: size.scale });
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const c2d = canvas.getContext("2d");
  if (!c2d) throw new Error("no 2d context");
  // pdf.js v6: render() takes the `canvas` itself, not just its 2D context.
  await page.render({ canvas, canvasContext: c2d, viewport }).promise;
  return canvas;
}

/** Rasterize a PDF page (~1600px wide, at most 3x) to a fresh canvas. */
export async function rasterizePdf(data: ArrayBuffer, pageNum: number): Promise<HTMLCanvasElement> {
  const pdfjs = await loadPdfjs();
  // pdf.js v6: cleanup is via the loading task (PDFDocumentProxy.destroy() was removed).
  const loadingTask = pdfjs.getDocument({ data });
  const doc = await loadingTask.promise;
  try {
    return await renderToCanvas(doc, pageNum, (base) => {
      const scale = Math.min(3, 1600 / base.width);
      return { scale, width: Math.ceil(base.width * scale), height: Math.ceil(base.height * scale) };
    });
  } finally {
    void loadingTask.destroy();
  }
}

/** A page PNG over this is sent as a JPEG instead: a 2400 px RGBA scan can come
 *  close to the 12 MB upload cap as a PNG, and the server takes either. */
export const PNG_RASTER_MAX_BYTES = 10 * 1024 * 1024;
/** The JPEG quality such a page is re-encoded at. */
export const JPEG_RASTER_QUALITY = 0.92;

/** Whether a page whose PNG is `pngBytes` long goes up as a JPEG instead. */
export function sendAsJpeg(pngBytes: number): boolean {
  return pngBytes > PNG_RASTER_MAX_BYTES;
}

function toBlob(canvas: HTMLCanvasElement, type: "image/png" | "image/jpeg", quality?: number): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error(`the page could not be encoded as ${type}`))), type, quality),
  );
}

export interface OpenPdf {
  pages: number;
  /** Page `page` (1-based) as a PNG whose long edge is `longEdgePx`, or a JPEG
   *  when the PNG would be over PNG_RASTER_MAX_BYTES. */
  renderPage: (page: number, longEdgePx: number) => Promise<Blob>;
  /** Release the document and its worker. */
  destroy: () => void;
}

/**
 * Open a PDF to render pages from it, until destroy(). pdf.js transfers the
 * buffer it is handed to its worker, which empties it here, so it is given a
 * copy: `bytes` stays readable for the caller.
 */
export async function loadPdf(bytes: ArrayBuffer, load: () => Promise<Pick<typeof import("pdfjs-dist"), "getDocument">> = loadPdfjs): Promise<OpenPdf> {
  const pdfjs = await load();
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(bytes.slice(0)) });
  let doc: PdfDoc;
  try {
    doc = await loadingTask.promise;
  } catch (err) {
    void loadingTask.destroy();
    throw err;
  }
  return {
    pages: doc.numPages,
    async renderPage(page, longEdgePx) {
      const canvas = await renderToCanvas(doc, page, (base) => sizeForLongEdge(base, longEdgePx));
      const png = await toBlob(canvas, "image/png");
      return sendAsJpeg(png.size) ? toBlob(canvas, "image/jpeg", JPEG_RASTER_QUALITY) : png;
    },
    destroy() {
      void loadingTask.destroy();
    },
  };
}
