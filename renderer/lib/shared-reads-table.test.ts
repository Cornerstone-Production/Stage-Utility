// The shared-reads table in api.ts, checked against the code it describes.
//
// SHARED_READ_PATHS says, per path, which live channel carries the same
// snapshot and whether the answer carries a server `rev`. The `rev` flag is the
// correctness-critical part: a joined read of a snapshot with no rev is only
// trusted when nothing newer has arrived, and one WITH a rev is trusted
// outright because its consumer orders by rev. Mark a rev-less path `rev: true`
// and the stale-overwrite bug the flag exists to prevent comes back, with every
// other test green.
//
// So the flag is not taken on trust: each `rev: true` path is asked of the
// server's own route code, and must answer with a numeric rev. The list itself
// is pinned exactly — sorted, one entry per line — so a change to it is a
// deliberate edit here, and two branches adding different entries merge
// cleanly.

import { strict as assert } from "node:assert";
import { after, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();
after(() => teardown());

const { SHARED_READ_PATHS } = await import("./api.js");
const { HYDRATED_CHANNELS } = await import("./sse-channels.js");
const { statusRoutes } = await import("../../main/services/routes/status-routes.js");
const { messagesRoutes } = await import("../../main/services/routes/messages-routes.js");
const { callRoute } = await import("../../main/services/routes/route-harness.js");
const { presenceSnapshot } = await import("../../main/services/display-presence.js");

describe("SHARED_READ_PATHS", () => {
  test("is exactly this list", () => {
    assert.deepEqual(
      [...SHARED_READ_PATHS].map(([path, s]) => `${path} ${s.channel} ${s.rev ? "rev" : "no-rev"}`),
      [
        "/api/attendance/history/current attendance:history no-rev",
        "/api/baptism baptism:state no-rev",
        "/api/displays/presence displays:presence rev",
        "/api/integrations integrations:state-changed no-rev",
        "/api/integrations/wireless/channels wireless:channels no-rev",
        "/api/messages messages:state rev",
        "/api/obs/status obs:status rev",
        "/api/pco/live pco:live no-rev",
        "/api/people/count people:count rev",
        "/api/propresenter/instances propresenter:instances no-rev",
        "/api/propresenter/status propresenter:status rev",
        "/api/pvp/status pvp:status rev",
        "/api/reaper/status reaper:status rev",
        "/api/resi/status resi:status rev",
        "/api/scores/status scores:status rev",
        "/api/service-timeline/current service-timeline:history no-rev",
        "/api/spl/metrics spl:metrics rev",
        "/api/state stage:state-changed no-rev",
        "/api/update/status update:status no-rev",
        "/api/youtube/status youtube:status rev",
      ],
    );
  });

  test("pairs every path with a live snapshot channel", () => {
    // A replay and the staleness check both key on the channel. The one channel
    // that is not replayed is integrations:state-changed, which is live-only;
    // the check then sees only live frames, the conservative case.
    const hydrated = new Set<string>(HYDRATED_CHANNELS);
    const unpaired = [...SHARED_READ_PATHS]
      .filter(([, s]) => !hydrated.has(s.channel) && s.channel !== "integrations:state-changed")
      .map(([path, s]) => `${path} ${s.channel}`);
    assert.deepEqual(unpaired, []);
  });

  test("every path marked rev really answers with one, from the server's own code", async () => {
    const missing: string[] = [];
    for (const [path, s] of SHARED_READ_PATHS) {
      if (!s.rev) continue;
      const body =
        path === "/api/displays/presence"
          ? (presenceSnapshot() as unknown) // answered in remote-server.ts, from this
          : (await callRoute(path === "/api/messages" ? messagesRoutes : statusRoutes, path)).json;
      if (typeof (body as { rev?: unknown } | null)?.rev !== "number") missing.push(`${path} -> ${JSON.stringify(body)?.slice(0, 80)}`);
    }
    assert.deepEqual(missing, [], "a path marked rev whose answer carries none");
  });
});
