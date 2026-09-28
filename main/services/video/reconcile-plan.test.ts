import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { pathConf, planReconcile, publishUsers } from "./reconcile-plan.ts";
import { READER_USER } from "./mediamtx-config.ts";
import type { RelayFeed } from "./relay.ts";

const PULL: RelayFeed = { id: "cam1", kind: "pull", source: "rtsp://h/s" };
const PULL_2: RelayFeed = { id: "cam2", kind: "pull", source: "rtsp://h2/s2" };
const PUSH: RelayFeed = { id: "obs1", kind: "push", password: "hunter2" };

/** A relay path's config as `GET /v3/config/paths/list` reports it: every
 *  key `pathConf` sets, plus a pile of others this app never touches. */
function currentPathFor(feed: RelayFeed, overrides: Record<string, unknown> = {}) {
  return {
    name: feed.id,
    conf: {
      ...pathConf(feed),
      // Dozens of other keys the relay reports and this app never sets.
      recordPath: "",
      recordFormat: "fmp4",
      recordPartDuration: "1s",
      recordSegmentDuration: "1h",
      recordDeleteAfter: "24h",
      runOnDemand: "",
      runOnDemandRestart: false,
      maxReaders: 0,
      srtReadPassphrase: "",
      rtspTransport: "automatic",
      ...overrides,
    },
  };
}

describe("planReconcile", () => {
  it("adds both feeds to an empty relay", () => {
    const plan = planReconcile([PULL, PUSH], []);
    assert.deepEqual(
      plan.add.map(([name]) => name).sort(),
      ["cam1", "obs1"],
    );
    assert.equal(plan.replace.length, 0);
    assert.equal(plan.remove.length, 0);
  });

  it("removes a relay path that is not in the desired list", () => {
    const current = [currentPathFor(PULL), currentPathFor({ id: "orphan", kind: "pull", source: "rtsp://gone/x" })];
    const plan = planReconcile([PULL], current);
    assert.deepEqual(plan.remove, ["orphan"]);
    assert.equal(plan.add.length, 0);
    assert.equal(plan.replace.length, 0);
  });

  it("replaces a pull feed whose URL changed", () => {
    const current = [currentPathFor(PULL)];
    const changed: RelayFeed = { id: "cam1", kind: "pull", source: "rtsp://new-host/s" };
    const plan = planReconcile([changed], current);
    assert.equal(plan.add.length, 0);
    assert.equal(plan.remove.length, 0);
    assert.deepEqual(plan.replace, [["cam1", pathConf(changed)]]);
  });

  it("leaves a path alone when its conf matches on every key pathConf sets, despite dozens of extra keys", () => {
    const current = [currentPathFor(PULL)];
    const plan = planReconcile([PULL], current);
    assert.equal(plan.add.length, 0);
    assert.equal(plan.replace.length, 0);
    assert.equal(plan.remove.length, 0);
  });

  it("never removes all_others even when it is not in the desired list", () => {
    const current = [currentPathFor(PULL), { name: "all_others", conf: { source: "" } }];
    const plan = planReconcile([PULL], current);
    assert.equal(plan.remove.length, 0);
  });

  it("mixes an add, a replace and a remove in one plan", () => {
    const current = [
      currentPathFor(PULL, { sourceOnDemandCloseAfter: "60s" }), // will replace
      currentPathFor({ id: "gone", kind: "pull", source: "rtsp://x/y" }), // will remove
    ];
    const plan = planReconcile([PULL, PULL_2], current);
    assert.deepEqual(plan.add, [["cam2", pathConf(PULL_2)]]);
    assert.deepEqual(plan.replace, [["cam1", pathConf(PULL)]]);
    assert.deepEqual(plan.remove, ["gone"]);
  });
});

describe("pathConf", () => {
  it("a pull feed gets an on-demand source with 10s timeouts", () => {
    assert.deepEqual(pathConf(PULL), {
      source: "rtsp://h/s",
      sourceOnDemand: true,
      sourceOnDemandStartTimeout: "10s",
      sourceOnDemandCloseAfter: "10s",
    });
  });

  it("a push feed gets the publisher source with overridePublisher off", () => {
    assert.deepEqual(pathConf(PUSH), { source: "publisher", overridePublisher: false });
  });
});

describe("publishUsers", () => {
  it("is the reader user, then one video user per push feed, sorted by path", () => {
    const feeds: RelayFeed[] = [
      { id: "z-cam", kind: "push", password: "pw-z" },
      PULL,
      { id: "a-cam", kind: "push", password: "pw-a" },
    ];
    assert.deepEqual(publishUsers(feeds), [
      READER_USER,
      { user: "video", pass: "pw-a", ips: [], permissions: [{ action: "publish", path: "a-cam" }] },
      { user: "video", pass: "pw-z", ips: [], permissions: [{ action: "publish", path: "z-cam" }] },
    ]);
  });

  it("is just the reader user when there are no push feeds", () => {
    assert.deepEqual(publishUsers([PULL, PULL_2]), [READER_USER]);
  });
});
