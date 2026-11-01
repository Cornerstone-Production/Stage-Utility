// A request reaches every barrier through the stock http model, so this file tests
// the barriers alone. One call per modelled function, each logging the request's
// URL; the only expected alert is the call that is not neutralised, which proves
// the fixture can alert at all.
import * as http from "http";

import { layerSlug } from "./builtin-cues.js";
import { slugForCue } from "./cue-slug.js";
import { filenameSlug } from "./export-filename.js";
import { scrub, scrubError } from "./scrub.js";

http.createServer((req) => {
  const raw = req.url ?? "";
  console.log(`unsanitised ${raw}`);
  console.log(`scrub ${scrub(raw)}`);
  console.log(`scrubError ${scrubError(raw)}`);
  console.log(`filenameSlug ${filenameSlug(raw)}`);
  console.log(`slugForCue ${slugForCue(raw)}`);
  console.log(`layerSlug ${layerSlug(raw)}`);
});
