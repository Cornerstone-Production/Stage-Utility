// worker.ts — the entry point: wires the request handler to the runtime.
//
// Nothing is decided here. handle.ts routes, authorises, validates and answers;
// hub.ts stores and sends. This file only hands the first the second's stub, the
// static assets and the secret.

import { forObject } from "./build.js";
import type { Env } from "./env.js";
import { handle } from "./handle.js";

export { PublishHub } from "./hub.js";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // The one Durable Object that holds everything.
    const hub = env.HUB.get(env.HUB.idFromName("main"));
    return handle(request, {
      hub,
      // A WebSocket handshake cannot go over RPC: it is a fetch to the object, so the
      // build id travels on it as a header, set here and nowhere else.
      upgrade: (upgrade, build) => hub.fetch(forObject(upgrade, build)),
      assets: (assetRequest) => env.ASSETS.fetch(assetRequest),
      token: env.PUBLISH_TOKEN,
      now: () => Date.now(),
    });
  },
} satisfies ExportedHandler<Env>;
