// A read overtaken by a host change must not act.
//
// configure() calls restart(), which is stop() then start() in the same tick,
// so `running` goes false and straight back to true. A poll parked on its
// request against the OLD host resumes, sees `running === true`, and carries on
// as if it spoke for the new one. REAPER, Resi, YouTube and Smaart guarded with
// `running` alone, so:
//
//   - a failure against the old box wrote "Can't reach <old>" onto the NEW
//     host's row, blanked every display (goOffline) and replaced the new host's
//     healthy poll timer with a back-off;
//   - a success against the old box was published as the new box's state.
//
// The guard is the base's run counter (integration-base.ts `current(run)`):
// bumped by every stop(), captured before the await, checked after it.

import assert from "node:assert/strict";
import { afterEach, test, type TestContext } from "node:test";

import { reaperDeps, reaperService } from "./reaper-service.js";

const transport = (playstate: number) => `TRANSPORT\t${playstate}\t1.0\t0\t0:01.000\t1.1.00`;
const answer = (body: string) => ({ ok: true, status: 200, text: async () => body }) as unknown as Response;

const realFetch = reaperDeps.fetch;
afterEach(() => {
  reaperDeps.fetch = realFetch;
  reaperService.setConnectionListener(() => {});
  reaperService.configure("", 0);
  reaperService.stop();
});

/** Spin the event loop (setImmediate is not mocked) a fixed number of turns. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

/**
 * Point REAPER at old.example with its read held open, then at new.example,
 * which answers at once with `newPlaystate`. Returns the held read's handles.
 */
async function overtaken(t: TestContext, newPlaystate: number) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let settleOld!: { resolve: (r: Response) => void; reject: (e: Error) => void };
  reaperDeps.fetch = ((input: unknown) => {
    const url = String(input);
    if (url.includes("old.example")) {
      return new Promise<Response>((resolve, reject) => {
        settleOld = { resolve, reject };
      });
    }
    return Promise.resolve(answer(transport(newPlaystate)));
  }) as typeof fetch;

  const reports: { state: string; message: string | null }[] = [];
  reaperService.setConnectionListener((state, message) => reports.push({ state, message }));
  reaperService.configure("old.example", 8080);
  await settle();
  reaperService.configure("new.example", 8080);
  await settle();
  assert.equal(reaperService.getLatest().connected, true, "the new host answered");
  return { settleOld, reports };
}

test("REAPER: a failure from the host the operator moved away from is not the new host's", async (t) => {
  const { settleOld, reports } = await overtaken(t, 0);

  settleOld.reject(new Error("connect ECONNREFUSED"));
  await settle();

  assert.deepEqual(
    reports.filter((r) => r.state === "error"),
    [],
    "the old host's failure was reported on the new host's row",
  );
  assert.equal(reaperService.getLatest().connected, true, "the old host's failure blanked the new host's displays");
});

test("REAPER: an answer from the host the operator moved away from is not published", async (t) => {
  // The new box is stopped (0); the old one was recording (5).
  const { settleOld } = await overtaken(t, 0);

  settleOld.resolve(answer(transport(5)));
  await settle();

  assert.equal(reaperService.getLatest().recording, false, "the old box's transport was published as the new one's");
});

// ── Resi: what a stale run CACHES, not just what it publishes ────────────────
//
// Dropping the stale publish is not enough when the read writes a cache on its
// way. configure() with new credentials clears the cached token; the old
// account's sign-in, still in flight, then wrote its token back, and every
// later poll read the OLD account's encoders until that token expired.

test("Resi: a sign-in for the replaced account does not leave its token behind", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { resiService } = await import("./resi-service.js");
  const realGlobalFetch = globalThis.fetch;
  let releaseOld!: () => void;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
    if (url.endsWith("/auth/token")) {
      const { username } = JSON.parse(String(init?.body)) as { username: string };
      if (username === "old") {
        await new Promise<void>((r) => {
          releaseOld = r;
        });
        return json({ access_token: "old-token", expires_in: 3600 });
      }
      return json({ access_token: "new-token", expires_in: 3600 });
    }
    if (url.endsWith("/users/me")) return json({ customerId: "c1" });
    return json([]);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = realGlobalFetch;
    resiService.stop();
  });

  resiService.configure("old", "pw");
  await settle();
  resiService.configure("new", "pw");
  await settle();
  releaseOld();
  await settle();

  assert.equal(
    (resiService as unknown as { token: string | null }).token,
    "new-token",
    "the replaced account's token was cached for the new one",
  );
});

// ── YouTube: the same two halves, on the cloud path ──────────────────────────

test("YouTube: the replaced channel's failure is not reported, and its answer is not cached", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { youtubeService } = await import("./youtube-service.js");
  const realGlobalFetch = globalThis.fetch;
  const held: { resolve: (r: Response) => void; reject: (e: Error) => void }[] = [];
  const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const key = (init?.headers as Record<string, string> | undefined)?.["X-Goog-Api-Key"];
    if (key === "old-key") return new Promise<Response>((resolve, reject) => held.push({ resolve, reject }));
    const url = String(input);
    if (url.includes("/channels?")) return Promise.resolve(json({ items: [{ contentDetails: { relatedPlaylists: { uploads: "UUnew" } } }] }));
    return Promise.resolve(json({ items: [] }));
  }) as typeof fetch;
  const reports: { state: string; message: string | null }[] = [];
  youtubeService.setConnectionListener((state, message) => reports.push({ state, message }));
  t.after(() => {
    globalThis.fetch = realGlobalFetch;
    youtubeService.setConnectionListener(() => {});
    youtubeService.stop();
  });
  const cfg = { mode: "key" as const, clientId: "", clientSecret: "", refreshToken: "" };

  youtubeService.configure({ ...cfg, apiKey: "old-key", channel: "@old" });
  await settle();
  youtubeService.configure({ ...cfg, apiKey: "new-key", channel: "@new" });
  await settle();
  assert.equal(youtubeService.getLatest().connected, true, "the new channel answered");

  // The old channel's lookup answers late: its playlist must not be cached.
  held[0].resolve(json({ items: [{ contentDetails: { relatedPlaylists: { uploads: "UUold" } } }] }));
  await settle();
  assert.equal(
    (youtubeService as unknown as { uploadsPlaylist: string | null }).uploadsPlaylist,
    "UUnew",
    "the replaced channel's uploads playlist was cached for the new one",
  );

  // A later read of the old channel fails: not the new channel's failure.
  for (const h of held.slice(1)) h.reject(new Error("YouTube returned HTTP 500"));
  await settle();
  assert.deepEqual(reports.filter((r) => r.state === "error"), [], "the old channel's failure was reported on the new one");
  assert.equal(youtubeService.getLatest().connected, true, "the old channel's failure blanked the new one");
});

// ── The rest of the run guards, one case each ────────────────────────────────

test("REAPER: transport()'s read of the replaced host is not published", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const held: ((r: Response) => void)[] = [];
  reaperDeps.fetch = ((input: unknown) => {
    if (String(input).includes("old.example")) return new Promise<Response>((resolve) => held.push(resolve));
    return Promise.resolve(answer(transport(0)));
  }) as typeof fetch;
  const quietLog = console.log;
  console.log = () => {};
  t.after(() => {
    console.log = quietLog;
  });

  reaperService.configure("old.example", 8080); // its poll is held
  await settle();
  const pressed = reaperService.transport("record"); // and so is this read
  await settle();
  reaperService.configure("new.example", 8080);
  await settle();
  for (const release of held) release(answer(transport(5))); // the old box was recording
  await pressed;
  await settle();

  assert.equal(reaperService.getLatest().recording, false, "transport()'s read of the old box was published as the new one's");
});

test("Scores: a poll for the teams the operator stopped following does not overwrite the new list's", async (t) => {
  // The old poll read only the OLD teams' league. Parsed against the new
  // favourites it finds nothing, and published that "nothing" over the game the
  // new poll had just put up.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { scoresService } = await import("./scores-service.js");
  const realGlobalFetch = globalThis.fetch;
  let releaseOld!: () => void;
  const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
  const game = (id: string, away: string, home: string) => ({
    id,
    status: { type: { state: "pre" } },
    competitions: [
      {
        competitors: [
          { id: away, homeAway: "away", team: { id: away, abbreviation: away } },
          { id: home, homeAway: "home", team: { id: home, abbreviation: home } },
        ],
      },
    ],
  });
  globalThis.fetch = (async (input: unknown) => {
    if (String(input).includes("baseball/mlb")) {
      await new Promise<void>((r) => {
        releaseOld = r;
      });
      return json({ events: [game("e1", "1", "2")] });
    }
    return json({ events: [game("e9", "9", "8")] });
  }) as typeof fetch;
  const quietLog = console.log;
  console.log = () => {};
  t.after(() => {
    console.log = quietLog;
    globalThis.fetch = realGlobalFetch;
    scoresService.stop();
  });
  const team = (league: "mlb" | "nhl", teamId: string) =>
    ({ league, teamId, displayName: teamId, abbreviation: teamId, logo: null, color: null });

  scoresService.configure([team("mlb", "1")]);
  await settle();
  scoresService.configure([team("nhl", "9")]);
  await settle();
  assert.deepEqual(scoresService.getLatest().games.map((g) => g.eventId), ["e9"], "the new team's game is up");
  releaseOld();
  await settle();

  assert.deepEqual(
    scoresService.getLatest().games.map((g) => g.eventId),
    ["e9"],
    "the old poll's empty answer replaced the new team's game",
  );
});

/**
 * Resi with two accounts, "old" and "new". The old account's request at `holdAt`
 * (a URL suffix) waits for `release`; everything else answers at once. Rows
 * from /events carry the account they came from.
 */
async function twoResiAccounts(t: TestContext, holdAt: string, fail = false, beforeRelease?: () => void) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { resiService } = await import("./resi-service.js");
  const realGlobalFetch = globalThis.fetch;
  const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
  let release!: () => void;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const auth = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? "");
    const old = auth.includes("old-token") || String(init?.body ?? "").includes('"old"');
    if (old && url.includes(holdAt)) {
      await new Promise<void>((r) => (release = r));
      if (fail) throw new Error("Resi returned HTTP 500");
    }
    if (url.endsWith("/auth/token")) return json({ access_token: old ? "old-token" : "new-token", expires_in: 3600 });
    if (url.endsWith("/users/me")) return json({ customerId: old ? "c-old" : "c-new" });
    if (url.endsWith("/events")) return json([{ account: old ? "old" : "new" }]);
    // The old account has an encoder live; the new one has none.
    if (url.includes("/encoders/status") && old) return json([{ uuid: "enc-old", name: "Old campus encoder", status: "started" }]);
    return json([]);
  }) as typeof fetch;
  const reports: string[] = [];
  resiService.setConnectionListener((state) => reports.push(state));
  const quiet = { warn: console.warn, log: console.log };
  console.warn = () => {};
  console.log = () => {};
  t.after(() => {
    console.warn = quiet.warn;
    console.log = quiet.log;
    globalThis.fetch = realGlobalFetch;
    resiService.setConnectionListener(() => {});
    resiService.stop();
  });

  resiService.configure("old", "pw");
  await settle();
  resiService.configure("new", "pw");
  await settle();
  assert.equal(resiService.getLatest().connected, true, "the new account answered");
  reports.length = 0;
  beforeRelease?.();
  release();
  await settle();
  return {
    reports,
    latest: () => resiService.getLatest(),
    peek: resiService as unknown as { customerId: string | null; events: unknown[]; token: string | null },
  };
}

// The success side of the two run checks in Resi's poll: the old account's encoders,
// read before the reconfigure, must not reach the new account's readout. Held at the
// encoder status read, the check after it is the one that drops them; held at the
// broadcast list read, which comes after the status read, the check after that one.
test("Resi: a status read of the replaced account goes no further, so it cannot cache that account's broadcast list", async (t) => {
  // The broadcast list is due again when the old account's status read lands. The
  // list read keys its cache on the credentials as they are when it starts, which by
  // then are the new account's: the check after the status read is what keeps the old
  // account's list (read with the old token) out of the new account's cache.
  const { resiService } = await import("./resi-service.js");
  const { peek } = await twoResiAccounts(t, "/encoders/status", false, () => {
    (resiService as unknown as { eventsFetchedAt: number }).eventsFetchedAt = 0;
  });
  assert.deepEqual(peek.events, [{ account: "new" }], "the replaced account's broadcast list was cached for the new one");
});

for (const [holdAt, check] of [["/encoders/status", "after the status read"], ["/events", "after the broadcast list read"]] as const) {
  test(`Resi: the replaced account's encoders are not published as the new one's (the check ${check})`, async (t) => {
    const { latest } = await twoResiAccounts(t, holdAt);
    assert.equal(latest().live, false, "the replaced account's live encoder was published as the new one's");
    assert.ok(!String(latest().detail ?? "").includes("Old campus encoder"), `the replaced account's encoder is named: ${latest().detail}`);
  });
}

test("Resi: the replaced account's customer id is not cached", async (t) => {
  const { peek } = await twoResiAccounts(t, "/users/me");
  assert.equal(peek.customerId, "c-new", "the replaced account's customer id was cached for the new one");
});

test("Resi: the replaced account's broadcast list is not cached", async (t) => {
  const { peek } = await twoResiAccounts(t, "/events");
  assert.deepEqual(peek.events, [{ account: "new" }], "the replaced account's broadcast list was cached for the new one");
});

test("Resi: a failure of the replaced account's poll is not the new account's", async (t) => {
  const { reports, peek } = await twoResiAccounts(t, "/encoders/status", true);
  assert.deepEqual(reports.filter((s) => s === "error"), [], "the replaced account's failure was reported on the new one");
  assert.equal(peek.token, "new-token", "the replaced account's failure dropped the new account's token");
});

test("YouTube: the replaced channel's live video is not published as the new one's", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { youtubeService } = await import("./youtube-service.js");
  const realGlobalFetch = globalThis.fetch;
  const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
  let releaseOld!: () => void;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const old = (init?.headers as Record<string, string> | undefined)?.["X-Goog-Api-Key"] === "old-key";
    if (url.includes("/channels?")) return json({ items: [{ contentDetails: { relatedPlaylists: { uploads: old ? "UUold" : "UUnew" } } }] });
    if (url.includes("/playlistItems?")) return json({ items: [{ contentDetails: { videoId: old ? "v-old" : "v-new" } }] });
    if (url.includes("/videos?") && old) {
      // The old channel is live, and its answer arrives after the reconfigure.
      await new Promise<void>((r) => (releaseOld = r));
      return json({ items: [{ id: "v-old", snippet: { title: "Old channel service", liveBroadcastContent: "live" } }] });
    }
    return json({ items: [{ id: "v-new", snippet: { title: "New channel upload", liveBroadcastContent: "none" } }] });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = realGlobalFetch;
    youtubeService.stop();
  });
  const cfg = { mode: "key" as const, clientId: "", clientSecret: "", refreshToken: "" };

  youtubeService.configure({ ...cfg, apiKey: "old-key", channel: "@old" });
  await settle();
  youtubeService.configure({ ...cfg, apiKey: "new-key", channel: "@new" });
  await settle();
  assert.equal(youtubeService.getLatest().connected, true, "the new channel answered");
  releaseOld();
  await settle();

  assert.equal(youtubeService.getLatest().live, false, "the replaced channel's live video was published as the new one's");
  assert.ok(
    !String(youtubeService.getLatest().detail ?? "").includes("Old channel service"),
    `the replaced channel's video is named: ${youtubeService.getLatest().detail}`,
  );
});

test("YouTube: an access token minted for the replaced credentials is not cached", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { youtubeService } = await import("./youtube-service.js");
  const realGlobalFetch = globalThis.fetch;
  const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
  let releaseOld!: () => void;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    if (String(input).startsWith("https://oauth2.googleapis.com/token")) {
      const old = String(init?.body).includes("old-refresh");
      if (old) await new Promise<void>((r) => (releaseOld = r));
      return json({ access_token: old ? "old-access" : "new-access" });
    }
    return json({ items: [] });
  }) as typeof fetch;
  const quietLog = console.log;
  console.log = () => {};
  t.after(() => {
    console.log = quietLog;
    globalThis.fetch = realGlobalFetch;
    youtubeService.stop();
  });
  const oauth = (refreshToken: string) => ({
    mode: "oauth" as const,
    apiKey: "",
    channel: "",
    clientId: "client",
    clientSecret: "secret",
    refreshToken,
  });

  youtubeService.configure(oauth("old-refresh"));
  await settle();
  youtubeService.configure(oauth("new-refresh"));
  await settle();
  releaseOld();
  await settle();

  assert.equal(
    (youtubeService as unknown as { accessToken: string | null }).accessToken,
    "new-access",
    "the replaced credentials' access token was cached for the new ones",
  );
});
