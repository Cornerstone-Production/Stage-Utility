// POST /api/log/client — a browser failure reaching /log.
//
// Asserted against the real log buffer, not against console: the whole point is
// that the line ends up somewhere `/log` reads, and a console spy would pass on
// a route that wrote to console with the buffer uninitialised.

import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-client-log-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { initLogCapture, getLogLines, setLogSink } = await import("../log-buffer.js");
initLogCapture();
// A SINK IS REQUIRED FOR THE BUFFER TO FILL AT ALL, which is not obvious and is
// not this change's doing: log-buffer's `record()` is written
// `sink?.(push(level, msg, t))`, and an optional call does not evaluate its
// argument — so with no sink installed, `push` never runs and the ring buffer
// stays empty. In production log-persist installs one at boot and it works by
// ordering. Reported rather than fixed here: it is shipped infrastructure, and
// widening a History change into the log pipeline is how a PR stops being
// reviewable.
setLogSink(() => {});

const { clientLogRoutes, resetClientLogLimits } = await import("./client-log-routes.js");
const { callRoute } = await import("./route-harness.js");

after(() => {
  fs.rm(TMP, { recursive: true, force: true }).catch(() => {});
});

const post = (body: unknown) =>
  callRoute(clientLogRoutes, "/api/log/client", { method: "POST", body });

/** Lines in the buffer whose message contains `needle`. */
function lines(needle: string): { level: string; msg: string }[] {
  return getLogLines().filter((l) => l.msg.includes(needle));
}

beforeEach(() => resetClientLogLimits());

describe("a line from the browser", () => {
  it("arrives on the log, tagged, at warn", async () => {
    const out = await post({ tag: "history", message: "could not read the sound summary: socket hang up" });
    assert.equal(out.status, 200);
    const hit = lines("could not read the sound summary");
    assert.equal(hit.length, 1, "the line did not reach the log buffer at all");
    assert.equal(hit[0].msg, "[history] could not read the sound summary: socket hang up");
    // `warn`, always. A browser does not get to claim the server raised an
    // error, and nothing that reaches this route is routine enough to be `log`.
    assert.equal(hit[0].level, "warn");
  });

  it("cannot forge a second line with a newline", async () => {
    // `/log` is one record per line. Unscrubbed, this would write an entry
    // indistinguishable from one the server wrote — precisely when the log
    // matters most.
    await post({ tag: "history", message: "all fine\n[stage-controller] plan switched to 12345" });
    const forged = lines("[stage-controller] plan switched to 12345");
    assert.equal(forged.length, 1, "expected exactly the one real line carrying the escaped text");
    assert.ok(
      forged[0].msg.includes("\\n"),
      `the newline reached the log unescaped: ${JSON.stringify(forged[0].msg)}`,
    );
    assert.ok(forged[0].msg.startsWith("[history] "), "the forged tag won");
  });

  it("refuses a tag that is not a tag", async () => {
    // A client must not be able to write a 4KB `[…]` prefix, or one with a
    // newline in it.
    for (const tag of ["", "Has Spaces", "x".repeat(40), "UPPER", "with\nnewline"]) {
      const out = await post({ tag, message: "hello" });
      assert.equal(out.status, 400, `tag ${JSON.stringify(tag)} was accepted`);
    }
  });

  it("refuses an empty message", async () => {
    assert.equal((await post({ tag: "history", message: "   " })).status, 400);
  });
});

describe("a browser that will not stop", () => {
  it("is cut off, and the cut-off is itself one line", async () => {
    // Silence with no explanation is the thing this route exists to fix, so the
    // throttle explains itself exactly once rather than going quiet.
    for (let i = 0; i < 10; i++) {
      assert.equal((await post({ tag: "history", message: `line ${i}` })).status, 200);
    }
    const first = await post({ tag: "history", message: "line 10" });
    assert.equal(first.status, 429);
    const second = await post({ tag: "history", message: "line 11" });
    assert.equal(second.status, 429);

    assert.equal(lines("line 10").length, 0, "a refused line still reached the log");
    assert.equal(
      lines("logging faster than this route accepts").length,
      1,
      "the throttle must say so once — not never, and not on every refusal",
    );
  });
});
