import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { pathConf, planReconcile, publishUsers, pullSource } from "./reconcile-plan.js";
import { READER_USER } from "./mediamtx-config.js";
import type { RelayFeed } from "./relay.js";

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

describe("pullSource", () => {
  it("folds a username and password into rtsp userinfo, percent-encoded", () => {
    assert.equal(pullSource("rtsp://h/s", "admin", "p@ss"), "rtsp://admin:p%40ss@h/s");
  });

  it("does the same for rtsps, http and https", () => {
    assert.equal(pullSource("rtsps://h/s", "admin", "p@ss"), "rtsps://admin:p%40ss@h/s");
    assert.equal(pullSource("http://h/s", "admin", "p@ss"), "http://admin:p%40ss@h/s");
    assert.equal(pullSource("https://h/s", "admin", "p@ss"), "https://admin:p%40ss@h/s");
  });

  it("percent-encodes a password carrying @, : and /", () => {
    assert.equal(pullSource("rtsp://h/s", "user", "a@b:c/d"), "rtsp://user:a%40b%3Ac%2Fd@h/s");
  });

  it("leaves the URL unchanged with an empty username and no password", () => {
    assert.equal(pullSource("rtsp://h/s", "", undefined), "rtsp://h/s");
    assert.equal(pullSource("rtsp://h/s", "", ""), "rtsp://h/s");
  });

  it("uses the password alone when there is no username, for a scheme that allows it", () => {
    assert.equal(pullSource("rtsp://h/s", "", "p@ss"), "rtsp://:p%40ss@h/s");
  });

  it("puts an SRT pull's password in the query as passphrase, URL-encoded", () => {
    assert.equal(pullSource("srt://h:9000", "ignored", "p@ss"), "srt://h:9000?passphrase=p%40ss");
  });

  it("percent-encodes an SRT passphrase carrying @, : and /", () => {
    assert.equal(pullSource("srt://h:9000", "x", "a@b:c/d"), "srt://h:9000?passphrase=a%40b%3Ac%2Fd");
  });

  it("ignores the username for SRT and keeps an existing query", () => {
    assert.equal(
      pullSource("srt://h:9000?streamid=x&mode=caller", "someone", "p@ss"),
      "srt://h:9000?streamid=x&mode=caller&passphrase=p%40ss",
    );
  });

  it("leaves an SRT URL unchanged with no password", () => {
    assert.equal(pullSource("srt://h:9000?streamid=x", "ignored", undefined), "srt://h:9000?streamid=x");
  });
});
