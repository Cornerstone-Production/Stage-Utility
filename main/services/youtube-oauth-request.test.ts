import { strict as assert } from "node:assert";
import { afterEach, describe, test } from "node:test";

import { googleReason, youtubeService, type YouTubeConfig } from "./youtube-service.js";

// liveBroadcasts.list accepts EXACTLY ONE filter parameter — broadcastStatus,
// id or mine — and answers two of them with HTTP 400 incompatibleParameters.
// The OAuth path sent broadcastStatus=active&mine=true from the day it shipped
// (1.11.0), so "My broadcasts" never worked for anyone, and the error it
// surfaced told the operator to check an API key that mode does not have.
//
// The fake Google below enforces the one-filter rule the way the real one
// does. A stub that answered 200 regardless would stay green with mine=true
// put back, which is the vacuous guard this repo keeps warning about.

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const OAUTH: YouTubeConfig = {
  mode: "oauth",
  apiKey: "",
  channel: "",
  clientId: "client-id",
  clientSecret: "client-secret",
  refreshToken: "refresh-token",
};

const INCOMPATIBLE = {
  error: {
    code: 400,
    message: "Incompatible parameters specified in the request: broadcastStatus, mine",
    errors: [{ message: "Incompatible parameters specified in the request: broadcastStatus, mine", domain: "youtube.parameter", reason: "incompatibleParameters" }],
  },
};

function fakeGoogle(onBroadcasts: (url: URL) => Response): string[] {
  const urls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    urls.push(url.href);
    if (url.hostname === "oauth2.googleapis.com") {
      return Response.json({ access_token: "access", expires_in: 3600 });
    }
    assert.equal(url.pathname, "/youtube/v3/liveBroadcasts", `unexpected call ${url.href}`);
    const filters = ["broadcastStatus", "id", "mine"].filter((f) => url.searchParams.has(f));
    if (filters.length !== 1) return Response.json(INCOMPATIBLE, { status: 400 });
    return onBroadcasts(url);
  }) as typeof fetch;
  return urls;
}

describe("YouTube OAuth request", () => {
  test("asks liveBroadcasts.list with one filter and reads the live broadcast back", async () => {
    fakeGoogle(() =>
      Response.json({
        items: [{ id: "b1", snippet: { title: "Sunday 9am", actualStartTime: "2026-09-06T14:00:00Z" }, status: { lifeCycleStatus: "live" } }],
      }),
    );
    const result = await youtubeService.test(OAUTH);
    assert.deepEqual(result, { ok: true, message: "Connected — live now: Sunday 9am" });
  });

  test("a rejected OAuth request names Google's reason, not an API key this mode does not have", async () => {
    fakeGoogle(() =>
      Response.json(
        { error: { code: 403, message: "The user is not enabled for live streaming.", errors: [{ reason: "liveStreamingNotEnabled" }] } },
        { status: 403 },
      ),
    );
    const result = await youtubeService.test(OAUTH);
    assert.equal(result.ok, false);
    assert.match(result.message ?? "", /HTTP 403: liveStreamingNotEnabled — The user is not enabled for live streaming/);
    assert.match(result.message ?? "", /OAuth client/);
    assert.doesNotMatch(result.message ?? "", /API key/);
  });

  test("googleReason is empty for a body that is not a Google error envelope", () => {
    assert.equal(googleReason(""), "");
    assert.equal(googleReason("<html>bad gateway</html>"), "");
    assert.equal(googleReason(JSON.stringify({ error: { message: "Bad Request" } })), ": Bad Request");
  });
});
