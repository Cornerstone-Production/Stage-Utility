// env.ts — what wrangler.jsonc gives the Worker.

import type { LimitVars } from "./capacity.js";
import type { PublishHub } from "./hub.js";

export interface Env extends LimitVars {
  /** The built viewer and its files: wrangler.jsonc's `assets`. */
  ASSETS: Fetcher;
  /** The one Durable Object that holds everything: wrangler.jsonc's `durable_objects`. */
  HUB: DurableObjectNamespace<PublishHub>;
  /** The publishing token, set with `wrangler secret put PUBLISH_TOKEN`. Absent until it is. */
  PUBLISH_TOKEN?: string;
}
