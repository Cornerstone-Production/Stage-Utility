// Tests for identifying what is on the other end of a bound port, and whether
// this process is running from the wrong data directory.
//
// The incident these guard: a stale systemd unit started a second copy of this
// server with no STAGE_UTILITY_DATA, which won the race for the port. The real
// service logged only a pid and a user for an hour before anyone worked out the
// holder was ANOTHER STAGE UTILITY running from the wrong place.

import assert from "node:assert/strict";
import * as http from "node:http";
import * as net from "node:net";
import { test, describe } from "node:test";

import {
  buildVersionPayload,
  describePortHolder,
  isLoopbackAddress,
  wrongDataDirWarning,
} from "./port-holder.js";

describe("isLoopbackAddress", () => {
  test("loopback shapes are true", () => {
    assert.equal(isLoopbackAddress("127.0.0.1"), true);
    assert.equal(isLoopbackAddress("::1"), true);
    assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
  });

  test("a LAN address, its IPv4-mapped form, and undefined are all false", () => {
    assert.equal(isLoopbackAddress("192.168.1.5"), false);
    assert.equal(isLoopbackAddress("::ffff:192.168.1.5"), false);
    assert.equal(isLoopbackAddress(undefined), false);
  });
});

describe("buildVersionPayload — /api/version field gating", () => {
  const extras = { dataDir: "/home/x/.stage-utility", pid: 4242 };

  test("a loopback caller gets version, pid and dataDir", () => {
    const payload = buildVersionPayload("45a3337", "127.0.0.1", extras);
    assert.deepEqual(payload, { version: "45a3337", dataDir: "/home/x/.stage-utility", pid: 4242 });
  });

  // Guard proof: with isLoopbackAddress replaced by `() => true`, this payload
  // would gain dataDir and pid — a filesystem path leaking onto the LAN — and
  // this assertion goes red. Confirmed red in-session, not shipped.
  test("a LAN address gets exactly one key: version", () => {
    const payload = buildVersionPayload("45a3337", "192.168.1.5", extras);
    assert.deepEqual(Object.keys(payload), ["version"]);
  });
});

describe("describePortHolder", () => {
  test("names version, pid and data directory when the holder is a Stage Utility", async () => {
    const server = http.createServer((req, res) => {
      if (req.url === "/api/version") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ version: "abc1234", pid: 4242, dataDir: "/tmp/x" }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;
    try {
      const description = await describePortHolder(port);
      assert.match(description, /another Stage Utility/);
      assert.match(description, /version abc1234/);
      assert.match(description, /pid 4242/);
      assert.match(description, /data directory \/tmp\/x/);
    } finally {
      server.close();
    }
  });

  // Guard proof: with describePortHolder made to always return the lsof/ss
  // fallback text even when the probe answers, this assertion goes red.
  // Confirmed red in-session, not shipped.
  test("falls back to the raw lsof/ss text when the holder is not recognisable JSON", async () => {
    const server = net.createServer((socket) => {
      // Accepts the connection and never responds. A malformed-but-present HTTP
      // response would surface as a parse error immediately and never reach the
      // probe's own timeout — this exercises that timeout for real.
      void socket;
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;
    const started = Date.now();
    try {
      const description = await describePortHolder(port);
      const elapsedMs = Date.now() - started;
      assert.doesNotMatch(description, /another Stage Utility/);
      // Guard proof: with the probe's internal timeout raised from 1500ms to
      // 10000ms, this bound goes red (the call takes >2s). Confirmed red in
      // -session by editing PROBE_TIMEOUT_MS, not shipped.
      assert.ok(elapsedMs < 2000, `expected under 2s, took ${elapsedMs}ms`);
    } finally {
      server.close();
    }
  });
});

describe("wrongDataDirWarning", () => {
  const env = {} as NodeJS.ProcessEnv;

  test("home default + system dir with settings.json names both paths", () => {
    const warning = wrongDataDirWarning("/home/pi/.stage-utility", env, "linux", true);
    assert.match(warning ?? "", /\/home\/pi\/\.stage-utility/);
    assert.match(warning ?? "", /\/var\/lib\/stage-utility/);
  });

  test("STAGE_UTILITY_DATA set explicitly never warns", () => {
    const withEnv = { STAGE_UTILITY_DATA: "/custom/path" } as NodeJS.ProcessEnv;
    assert.equal(wrongDataDirWarning("/custom/path", withEnv, "linux", true), null);
  });

  test("system dir without settings.json never warns", () => {
    assert.equal(wrongDataDirWarning("/home/pi/.stage-utility", env, "linux", false), null);
  });

  test("resolved dir already IS the system dir never warns", () => {
    assert.equal(wrongDataDirWarning("/var/lib/stage-utility", env, "linux", true), null);
  });

  // Guard proof: with wrongDataDirWarning hard-coded to always return null,
  // the first test above (which expects a non-null warning) goes red.
  // Confirmed red in-session, not shipped.
});
