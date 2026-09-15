// The two HTTP reads of the ProdCom transcript, driven through the real handler.
//
// They are three lines apart and must behave in opposite ways, which is exactly
// the kind of thing that reads correct in a diff:
//
//   /api/prodcom/transcript      REDACTED, and OPEN. Every display calls it for
//                                its backfill on load. Gating it would blank a
//                                kiosk; serving it raw would paint a hidden word
//                                once on load and hide it from the next line on,
//                                which is the bug the broadcast fix alone leaves
//                                behind.
//
//   /api/prodcom/transcript/raw  UNREDACTED, and GATED by the /api/log gate. An
//                                operator reviewing after a service has to be
//                                able to read what a keyword hid; a count on the
//                                line says something was hidden, not what.
//
// Driven end to end: a local ProdCom stub with keywords on it, the real
// prodcomService singleton connected to it over a real socket, and route-harness
// giving the real handler a fake socket — so these are the bytes a client gets.
//
// EVERY KEYWORD HERE IS INVENTED. See prodcom-redaction.test.ts.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import * as os from "node:os";
import * as path from "node:path";
import * as fsp from "node:fs/promises";

// proxy-routes pulls in the stage controller and the integration manager, which
// resolve the data directory at import. Point it somewhere disposable BEFORE
// that happens — never at the operator's real ~/.stage-utility.
process.env.STAGE_UTILITY_DATA = await fsp.mkdtemp(path.join(os.tmpdir(), "prodcom-raw-route-"));

const { proxyRoutes } = await import("./proxy-routes.js");
const { callRoute } = await import("./route-harness.js");
const { prodcomService } = await import("../prodcom-service.js");
const { startProdComStub } = await import("../fixtures/prodcom-stub.js");

const TOKEN = "gate-token-for-the-test";
/** Invented, and marked sensitive on the stub. */
const SENSITIVE_WORD = "zarquon";
const SAID = `bring ${SENSITIVE_WORD} to the booth`;
const HIDDEN = `bring ${"*".repeat(SENSITIVE_WORD.length)} to the booth`;

const CHANNELS = [{ id: "CH-A", name: "Lead TB", color: "#00F900" }];

let stub: Awaited<ReturnType<typeof startProdComStub>>;

before(async () => {
  stub = await startProdComStub({
    channels: CHANNELS,
    keywords: [{ id: "kw-1", text: SENSITIVE_WORD, isSensitive: true }],
    entries: [
      {
        id: "line-1",
        channelId: "CH-A",
        channelName: "Lead TB",
        text: SAID,
        source: "audio",
        inProgress: false,
        // The singleton runs on the real clock, so this has to be genuinely
        // recent or the four-hour horizon drops it before the route sees it.
        date: new Date().toISOString(),
      },
    ],
  });
  prodcomService.configure("127.0.0.1", stub.port, null);
  await stub.waitForUpgrades(1);
  await stub.waitForRequest((r) => r.url.startsWith("/api/v1/transcript?"));
  // The line has to be in the buffer before any of this means anything.
  const deadline = Date.now() + 4000;
  while (prodcomService.getRawBuffer().length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(prodcomService.getRawBuffer().length, 1, "the stub's line never reached the buffer");
});

after(async () => {
  delete process.env.STAGE_UTILITY_LOG_TOKEN;
  prodcomService.stop();
  prodcomService.clearTranscript();
  await stub.close();
});

describe("the display read is redacted and open", () => {
  it("serves the asterisked line", async () => {
    const r = await callRoute(proxyRoutes, "/api/prodcom/transcript");
    assert.equal(r.status, 200);
    const lines = r.json as { text: string; redactions?: number }[];
    assert.deepEqual(
      lines.map((l) => l.text),
      [HIDDEN],
    );
    assert.equal(lines[0]!.redactions, 1);
    assert.ok(
      !r.body.toLowerCase().includes(SENSITIVE_WORD),
      `a sensitive keyword reached the display route body: ${r.body}`,
    );
  });

  it("stays open when a log token is set — a display carries no token", async () => {
    process.env.STAGE_UTILITY_LOG_TOKEN = TOKEN;
    try {
      const r = await callRoute(proxyRoutes, "/api/prodcom/transcript");
      assert.equal(r.status, 200, "gating the display read would blank every kiosk");
    } finally {
      delete process.env.STAGE_UTILITY_LOG_TOKEN;
    }
  });
});

describe("the raw read is unredacted and gated exactly like /api/log", () => {
  it("is LAN-open with no token configured, as every other route here is", async () => {
    const r = await callRoute(proxyRoutes, "/api/prodcom/transcript/raw");
    assert.equal(r.status, 200);
    assert.deepEqual(
      (r.json as { text: string }[]).map((l) => l.text),
      [SAID],
      "the gated read must show what was actually said",
    );
  });

  it("answers 401 with no token, and with the wrong one, once a token is set", async () => {
    process.env.STAGE_UTILITY_LOG_TOKEN = TOKEN;
    try {
      for (const p of ["/api/prodcom/transcript/raw", "/api/prodcom/transcript/raw?token=wrong"]) {
        const r = await callRoute(proxyRoutes, p);
        assert.equal(r.status, 401, `${p} was not refused`);
        assert.ok(
          !r.body.toLowerCase().includes(SENSITIVE_WORD),
          `the 401 body leaked the transcript: ${r.body}`,
        );
      }
    } finally {
      delete process.env.STAGE_UTILITY_LOG_TOKEN;
    }
  });

  it("opens with the right token", async () => {
    process.env.STAGE_UTILITY_LOG_TOKEN = TOKEN;
    try {
      const r = await callRoute(proxyRoutes, `/api/prodcom/transcript/raw?token=${TOKEN}`);
      assert.equal(r.status, 200);
      assert.deepEqual(
        (r.json as { text: string }[]).map((l) => l.text),
        [SAID],
      );
    } finally {
      delete process.env.STAGE_UTILITY_LOG_TOKEN;
    }
  });
});
