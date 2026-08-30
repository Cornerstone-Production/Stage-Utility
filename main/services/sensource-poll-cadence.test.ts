// Dropping the poll interval must not quietly break the things that were sized
// around the old one.
//
// Measured against the live Vea API during a Sunday arrival ramp: their numbers
// advance about every 78s, so a 45s poll added a mean 23s / worst 46s of
// staleness of its own — the reason the Vea dashboard read ahead of Stage. The
// interval came down to 15s. Two things in this file were sized against 45s and
// would have broken silently:
//
//   1. The trend buffer appended one point per poll. 240 points covered three
//      hours at 45s and would cover one at 15s — the people-graph loses two
//      thirds of its history, and nothing reports a fault.
//   2. The poll's requests were serial, so each asked for an auth header after
//      the last had cached one. Issued together, the first poll after a token
//      expiry sends simultaneous client-credentials exchanges that race over
//      `this.token`.
//
// And the default interval itself lived as three separate `45` literals (the
// service, the settings descriptor, the config reader). A drift between them
// hands an operator who never opened the panel a different rate from the one the
// form shows, which is invisible from either end.

import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-sensource-cadence-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { sensourceService, DEFAULT_POLL_SECONDS, MIN_POLL_SECONDS } = await import(
  "./sensource-service.js"
);
const { integrationManager } = await import("./integration-manager.js");
import type { PeopleCountDTO } from "../types/stage.js";

type Buffer_ = {
  history: { t: string; attendance: number; occupancy: number }[];
  lastHistoryAt: number;
  appendHistory: (dto: PeopleCountDTO) => void;
};
const buf = sensourceService as unknown as Buffer_;

function sample(n: number, at: number): PeopleCountDTO {
  return {
    connected: true,
    updatedAt: new Date(at).toISOString(),
    total: { attendance: n, occupancy: n },
    zones: [],
  };
}

/** Drive the REAL append path at a given poll interval for a given wall span. */
function pollFor(intervalSec: number, spanMs: number): void {
  buf.history = [];
  buf.lastHistoryAt = 0;
  const start = Date.UTC(2026, 7, 30, 13, 0, 0);
  let n = 0;
  for (let t = start; t <= start + spanMs; t += intervalSec * 1000) {
    buf.appendHistory(sample(n++, t));
  }
}

/** Wall-clock span the buffer actually covers, in minutes. */
function spanMinutes(): number {
  const h = buf.history;
  if (h.length < 2) return 0;
  return (Date.parse(h[h.length - 1].t) - Date.parse(h[0].t)) / 60_000;
}

describe("the trend buffer keeps its span when the poll speeds up", () => {
  beforeEach(() => {
    buf.history = [];
    buf.lastHistoryAt = 0;
  });

  it("covers the same hours at 15s as it did at 45s", () => {
    // Six hours of polling — comfortably more than the buffer holds either way,
    // so both runs are at capacity and the comparison is about resolution alone.
    pollFor(45, 6 * 3600_000);
    const at45 = spanMinutes();
    pollFor(15, 6 * 3600_000);
    const at15 = spanMinutes();

    assert.ok(at45 > 150, `the 45s baseline should still cover ~3h, got ${at45.toFixed(0)}min`);
    // THE bug: one point per poll made this ratio 1/3.
    assert.ok(
      at15 >= at45 * 0.9,
      `tripling the poll rate shortened the trend graph from ${at45.toFixed(0)}min to ${at15.toFixed(0)}min`,
    );
  });

  it("still records a point per poll when the operator polls slowly", () => {
    // The gate is a floor, not a ceiling: a 5-minute interval must not be
    // down-sampled to nothing.
    pollFor(300, 2 * 3600_000);
    assert.equal(buf.history.length, 25, "a slow poll lost samples to the gate");
  });

  it("never exceeds the buffer cap", () => {
    pollFor(15, 12 * 3600_000);
    assert.ok(buf.history.length <= 240, `buffer grew to ${buf.history.length}`);
  });
});

describe("parallel poll requests share one token exchange", () => {
  it("exchanges once when two requests race an expired token", async () => {
    type Auth = {
      cfg: unknown;
      token: string | null;
      tokenExpiresAt: number;
      authInFlight: Promise<string> | null;
      authHeader: () => Promise<string>;
    };
    const svc = sensourceService as unknown as Auth;

    const prevCfg = svc.cfg;
    const prevFetch = globalThis.fetch;
    let exchanges = 0;
    // Slow enough that a second caller genuinely overlaps the first.
    globalThis.fetch = (async () => {
      exchanges++;
      await new Promise((r) => setTimeout(r, 20));
      return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
    }) as typeof fetch;

    try {
      svc.cfg = {
        clientId: "test-client",
        clientSecret: "test-secret",
        apiToken: null,
        pollSeconds: DEFAULT_POLL_SECONDS,
        locationId: null,
        zoneIds: [],
      };
      svc.token = null;
      svc.tokenExpiresAt = 0;
      svc.authInFlight = null;

      // Exactly the shape the poll now has: both requests ask at once.
      const [a, b] = await Promise.all([svc.authHeader(), svc.authHeader()]);

      // THE bug: without the in-flight guard this is 2, and the two tokens race.
      assert.equal(exchanges, 1, "the parallel poll sent two client-credentials exchanges");
      assert.equal(a, b, "the two requests were given different tokens");
    } finally {
      globalThis.fetch = prevFetch;
      svc.cfg = prevCfg;
      svc.token = null;
      svc.tokenExpiresAt = 0;
      svc.authInFlight = null;
    }
  });
});

describe("the poll interval has one definition", () => {
  const field = integrationManager
    .getDescriptors()
    .find((d) => d.id === "sensource")
    ?.configSchema.find((f) => f.key === "pollSeconds");

  it("is offered by the settings form", () => {
    assert.ok(field, "the SenSource descriptor lost its poll-interval field");
    assert.equal(field.type, "number");
  });

  it("shows the form the same default the poller uses", () => {
    // Two literals, no link, was the arrangement: an operator who never opened
    // the panel ran DEFAULT_POLL_SECONDS while the form advertised the other one.
    assert.equal(field!.default, DEFAULT_POLL_SECONDS);
    assert.equal(field!.placeholder, String(DEFAULT_POLL_SECONDS));
  });

  it("never lets the form offer a rate below the floor the poller enforces", () => {
    // Unbounded, the input took 0 or a negative and the poller silently ran at
    // MIN_POLL_SECONDS — the form said one thing and the poll did another. The
    // assertion is >=, not ==: a stricter form bound is fine, a looser one lies.
    assert.ok(
      typeof field!.min === "number" && field!.min >= MIN_POLL_SECONDS,
      `form floor ${field!.min} is below the ${MIN_POLL_SECONDS}s the poller enforces`,
    );
  });
});
