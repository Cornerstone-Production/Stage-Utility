// The two readings YouTube gives away, and the requests they must not cost.
//
// `liveStreamingDetails.concurrentViewers` and `scheduledStartTime` were already
// inside the `videos.list` response the API-key path parses on every poll, and
// were thrown on the floor. Surfacing them is free — which is the whole claim,
// and the one worth guarding: the obvious way to get a viewer count onto the
// OAuth path is a second `videos.list` per poll, and at the 20-second in-demand
// cadence that is 180 extra quota units an hour against a 10,000-a-day budget,
// on a wall display that is on all day.
//
// So these tests COUNT THE REQUESTS as well as reading the fields. A stub that
// answered every URL would stay green with an extra call added, which is the
// vacuous guard this repo keeps warning about.
//
// The service is driven through `configure()` rather than `test()`: the fields
// are on the published DTO, and `test()` only returns a sentence. Every case
// stops the service afterwards, so no poll timer outlives it.

import { strict as assert } from "node:assert";
import { after, afterEach, describe, test } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { YouTubeConfig, YouTubeVideo } from "./youtube-service.js";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-utility-youtube-"));
process.env.STAGE_UTILITY_DATA = path.join(TMP, "data");
process.env.HOME = path.join(TMP, "home");

const { concurrentViewers, nextScheduledStart, youtubeService } = await import("./youtube-service.js");

const realFetch = globalThis.fetch;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  youtubeService.stop();
  globalThis.fetch = realFetch;
});

after(async () => {
  await fs.rm(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

const KEY: YouTubeConfig = {
  mode: "key",
  apiKey: "an-api-key",
  channel: "@example",
  clientId: "",
  clientSecret: "",
  refreshToken: "",
};
const OAUTH: YouTubeConfig = {
  mode: "oauth",
  apiKey: "",
  channel: "",
  clientId: "client-id",
  clientSecret: "client-secret",
  refreshToken: "refresh-token",
};

/**
 * A Google that answers the endpoints a path uses, and records EVERY path asked
 * for — including one it has no stub for.
 *
 * The unstubbed answer is an empty 200 rather than a 404 on purpose. A 404 makes
 * the poll fail, so a test that gained a request would go red saying "the
 * service never completed a poll", which names the stub rather than the bug.
 * Answering it lets the exact path list below be what fails, and say how many
 * requests one poll actually made.
 */
function fakeGoogle(handlers: Record<string, (url: URL) => Response>): string[] {
  const paths: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === "oauth2.googleapis.com") {
      return Response.json({ access_token: "access", expires_in: 3600 });
    }
    paths.push(url.pathname);
    return (handlers[url.pathname] ?? (() => Response.json({ items: [] })))(url);
  }) as typeof fetch;
  return paths;
}

/**
 * Configure and wait for the first poll to publish.
 *
 * A DISTINCT CHANNEL per call, so the request counts below are the same every
 * time. `configure()` keeps the resolved uploads playlist when nothing in the
 * config changed — correct, and it means a second test on the same channel
 * makes two requests where the first made three. Varying the channel keeps
 * every case a cold start, which is the one an exact count can describe.
 */
let channelSeq = 0;
async function pollOnce(cfg: YouTubeConfig): Promise<void> {
  youtubeService.configure(cfg.mode === "key" ? { ...cfg, channel: `@example${++channelSeq}` } : cfg);
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (youtubeService.getLatest().connected) return;
    await sleep(10);
  }
  assert.fail("the service never completed a poll against the stub Google");
}

const CHANNELS = "/youtube/v3/channels";
const PLAYLIST_ITEMS = "/youtube/v3/playlistItems";
const VIDEOS = "/youtube/v3/videos";
const BROADCASTS = "/youtube/v3/liveBroadcasts";

const keyPathStubs = (videoItems: unknown[]): Record<string, (url: URL) => Response> => ({
  [CHANNELS]: () => Response.json({ items: [{ contentDetails: { relatedPlaylists: { uploads: "UUexample" } } }] }),
  [PLAYLIST_ITEMS]: () => Response.json({ items: [{ contentDetails: { videoId: "v1" } }] }),
  [VIDEOS]: () => Response.json({ items: videoItems }),
});

describe("the API-key path", () => {
  test("publishes the viewer count that was already in the response", async () => {
    const paths = fakeGoogle(
      keyPathStubs([
        {
          id: "v1",
          snippet: { title: "Sunday 9am", liveBroadcastContent: "live" },
          liveStreamingDetails: { actualStartTime: "2026-09-06T14:00:00Z", concurrentViewers: "137" },
        },
      ]),
    );
    await pollOnce(KEY);

    const snap = youtubeService.getLatest();
    assert.equal(snap.live, true);
    assert.equal(snap.viewers, 137, "the viewer count was in the response and did not reach the snapshot");
    // EXACT AND ORDERED. The count is the claim: a viewer count that cost a
    // second videos.list would not be free, and this is what says so.
    assert.deepEqual(
      paths,
      [CHANNELS, PLAYLIST_ITEMS, VIDEOS],
      `one poll made ${paths.length} requests: ${paths.join(", ")}`,
    );
  });

  test("publishes the scheduled start of a broadcast that has not begun", async () => {
    // THE ALARM. Nothing is live and something was due — the state the app could
    // not describe at all, and the one worth raising before anyone notices.
    const paths = fakeGoogle(
      keyPathStubs([
        {
          id: "v1",
          snippet: { title: "Sunday 9am", liveBroadcastContent: "upcoming" },
          liveStreamingDetails: { scheduledStartTime: "2026-09-06T14:00:00Z" },
        },
      ]),
    );
    await pollOnce(KEY);

    const snap = youtubeService.getLatest();
    assert.equal(snap.live, false, "an upcoming broadcast is not a live one");
    assert.equal(snap.scheduledStartAt, "2026-09-06T14:00:00.000Z");
    assert.deepEqual(
      paths,
      [CHANNELS, PLAYLIST_ITEMS, VIDEOS],
      `one poll made ${paths.length} requests: ${paths.join(", ")}`,
    );
  });

  test("a hidden viewer count is null, not zero", async () => {
    // YouTube omits `concurrentViewers` when the owner has hidden it. Reporting
    // 0 watching over a stream with an audience is worse than reporting nothing.
    fakeGoogle(
      keyPathStubs([
        {
          id: "v1",
          snippet: { liveBroadcastContent: "live" },
          liveStreamingDetails: { actualStartTime: "2026-09-06T14:00:00Z" },
        },
      ]),
    );
    await pollOnce(KEY);
    assert.equal(youtubeService.getLatest().viewers, null);
  });
});

describe("the OAuth path", () => {
  test("reads the scheduled start off the snippet it already asks for, and adds no request for viewers", async () => {
    // A liveBroadcast carries no audience figure, and the count lives on the
    // VIDEO of the same id — so a viewer count here is a second call per poll,
    // 180 quota units an hour at the in-demand cadence. The exact path list is
    // what says the second call is not being made.
    const paths = fakeGoogle({
      [BROADCASTS]: () =>
        Response.json({
          items: [
            {
              id: "b1",
              snippet: {
                title: "Sunday 9am",
                actualStartTime: "2026-09-06T14:01:30Z",
                scheduledStartTime: "2026-09-06T14:00:00Z",
              },
              status: { lifeCycleStatus: "live" },
            },
          ],
        }),
    });
    await pollOnce(OAUTH);

    const snap = youtubeService.getLatest();
    assert.equal(snap.live, true);
    assert.equal(snap.scheduledStartAt, "2026-09-06T14:00:00.000Z", "the scheduled start is in the snippet already asked for");
    assert.equal(snap.viewers, null, "the OAuth path has no viewer count to report and must not invent one");
    assert.deepEqual(paths, [BROADCASTS], `one poll made ${paths.length} requests: ${paths.join(", ")}`);
  });
});

describe("concurrentViewers", () => {
  const v = (concurrent: string | null | undefined): YouTubeVideo => ({
    liveStreamingDetails: { actualStartTime: "2026-09-06T14:00:00Z", concurrentViewers: concurrent },
  });

  test("parses YouTube's string", () => {
    assert.equal(concurrentViewers([v("42")]), 42);
  });

  test("sums across everything live", () => {
    assert.equal(concurrentViewers([v("42"), v("8")]), 50);
  });

  test("nothing reported at all is null, not zero", () => {
    assert.equal(concurrentViewers([v(null), v(undefined)]), null);
    assert.equal(concurrentViewers([]), null);
  });

  test("a reported zero IS zero", () => {
    assert.equal(concurrentViewers([v("0")]), 0);
  });

  test("an empty string is not zero viewers", () => {
    // Number("") is 0, which would report an empty field as an empty room.
    assert.equal(concurrentViewers([v("")]), null);
  });

  test("junk is skipped rather than turned into NaN", () => {
    assert.equal(concurrentViewers([v("lots"), v("7")]), 7);
    assert.equal(concurrentViewers([v("-3")]), null);
  });
});

describe("nextScheduledStart", () => {
  const NOW = Date.parse("2026-09-06T14:00:00Z");
  const at = (offsetMin: number) => new Date(NOW + offsetMin * 60_000).toISOString();

  const upcoming = (scheduledStartTime: string): YouTubeVideo => ({ liveStreamingDetails: { scheduledStartTime } });

  test("reads a broadcast that has not begun", () => {
    assert.equal(nextScheduledStart([upcoming(at(10))], NOW), at(10));
  });

  test("a broadcast already under way is not a scheduled start", () => {
    // It HAS begun; `live` and `startedAt` describe it. Reading its scheduled
    // time back as an upcoming one would raise an alarm about a stream that is
    // going out fine.
    const started: YouTubeVideo = {
      liveStreamingDetails: { scheduledStartTime: at(-5), actualStartTime: at(-4) },
    };
    assert.equal(nextScheduledStart([started], NOW), null);
  });

  test("a finished broadcast is not a scheduled start", () => {
    // THE ONE THAT WOULD NEVER STOP. A completed stream keeps its
    // scheduledStartTime for ever, so reading it back would report every past
    // service as a start that never happened.
    const done: YouTubeVideo = {
      liveStreamingDetails: { scheduledStartTime: at(-90), actualStartTime: at(-89), actualEndTime: at(-20) },
    };
    assert.equal(nextScheduledStart([done], NOW), null);
  });

  test("an ordinary upload has no scheduled start", () => {
    assert.equal(nextScheduledStart([{ id: "v1", snippet: { title: "Last week's sermon" } }], NOW), null);
  });

  test("of several, the one nearest now — in either direction", () => {
    // A morning and an evening service on the same channel. The one being asked
    // about is the one closest to the present, whether it is due or overdue.
    assert.equal(nextScheduledStart([upcoming(at(240)), upcoming(at(-3))], NOW), at(-3));
    assert.equal(nextScheduledStart([upcoming(at(240)), upcoming(at(30))], NOW), at(30));
  });

  test("an unparseable time is skipped rather than becoming an alarm at the epoch", () => {
    assert.equal(nextScheduledStart([upcoming("soon")], NOW), null);
    assert.equal(nextScheduledStart([upcoming("soon"), upcoming(at(5))], NOW), at(5));
  });
});
