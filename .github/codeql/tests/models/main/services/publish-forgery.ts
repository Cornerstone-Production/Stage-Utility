// A request reaches the fetch through the stock http model, so this file tests the
// barrier alone. One request built from the raw address, which must alert (it proves the
// fixture can alert at all), and one from the parsed origin, which must not.
import * as http from "http";

import { parsePublishUrl } from "./servicecue-publish-rules.js";

http.createServer(async (req) => {
  const raw = req.url ?? "";
  await fetch(`https://${raw}/_publish/v1/status`);
  const parsed = parsePublishUrl(raw);
  if (parsed.ok) await fetch(`${parsed.origin}/_publish/v1/status`);
});
