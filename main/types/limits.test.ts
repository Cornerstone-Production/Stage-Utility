// Pins what limits.ts is for: one number behind every check of one policy, and
// the same number in every message that names it. Before it, the image cap was a
// literal in image-files.ts, in photo-cache.ts and in the stage-plot types, and
// the messages said "12 MB" in their own words.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { MAX_IMAGE_BYTES as IMAGE_FILES_CAP, storedImageProblem } from "../services/image-files.js";
import { MAX_STAGEPLOT_PDF_BYTES, storedOriginalProblem } from "../services/stageplots-files.js";
import { LOGO_LIMIT_LABEL, MAX_IMAGE_BYTES, MAX_LOGO_BYTES, MAX_LOGO_DATA_URL_CHARS, MAX_PDF_BYTES, megabytes } from "./limits.js";
import { STAGEPLOT_LIMITS } from "./stageplots.js";

test("every module that checks the image cap checks this one", () => {
  assert.equal(IMAGE_FILES_CAP, MAX_IMAGE_BYTES);
  assert.equal(STAGEPLOT_LIMITS.imageBytes, MAX_IMAGE_BYTES);
});

test("the PDF cap is the one the stage-plot files enforce", () => {
  assert.equal(STAGEPLOT_LIMITS.pdfBytes, MAX_PDF_BYTES);
  assert.equal(MAX_STAGEPLOT_PDF_BYTES, MAX_PDF_BYTES);
});

test("a size reads as whole megabytes", () => {
  assert.equal(megabytes(MAX_IMAGE_BYTES), "12 MB");
  assert.equal(megabytes(MAX_PDF_BYTES), "25 MB");
});

test("the refusals name the cap they enforce", () => {
  const png = "0000000000000000.png";
  assert.equal(storedImageProblem(png, Buffer.alloc(MAX_IMAGE_BYTES + 1), { checkContent: false }), "is too large (max 12 MB)");
  const pdf = "0000000000000000.pdf";
  assert.equal(storedOriginalProblem(pdf, Buffer.alloc(MAX_PDF_BYTES + 1)), "is too large (max 25 MB)");
});

test("the logo's data-URL cap is the base64 of its byte cap, and the label says the same number", () => {
  assert.equal(MAX_LOGO_DATA_URL_CHARS, 2_000_000);
  assert.equal(Buffer.alloc(MAX_LOGO_BYTES).toString("base64").length, MAX_LOGO_DATA_URL_CHARS);
  assert.equal(LOGO_LIMIT_LABEL, `${MAX_LOGO_BYTES / 1_000_000} MB`);
});
