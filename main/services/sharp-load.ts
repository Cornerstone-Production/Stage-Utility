// sharp-load.ts — the image library, loaded the first time something needs it.
//
// Not when the server starts: a platform whose native build is missing or will
// not load then fails the features that convert images (stage-plot backgrounds),
// each with the reason, and nothing else. A failed load is tried
// again on the next use.

import type { Sharp, SharpOptions } from "sharp";

export type SharpFn = (input?: Buffer, options?: SharpOptions) => Sharp;
let sharpLoad: Promise<SharpFn> | null = null;

export function loadSharp(): Promise<SharpFn> {
  sharpLoad ??= import("sharp").then(
    (m) => {
      // A Raspberry Pi has little memory to spare, and each image is converted once.
      m.default.cache({ memory: 20, files: 0 });
      return m.default as unknown as SharpFn;
    },
    (err: unknown) => {
      sharpLoad = null;
      // The reason stays on `cause` for the log: it names paths on this machine.
      throw new Error("image processing is not available on this server: sharp did not load", { cause: err });
    },
  );
  return sharpLoad;
}
