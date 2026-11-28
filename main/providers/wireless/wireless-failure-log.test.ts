// A wireless link that fails says so in /log, with no debug variable set.
//
// Spectera and the Sennheiser SSC drivers wrote their failures only under
// SPECTERA_DEBUG / SENNHEISER_DEBUG. A wrong Spectera API password, or a wrong
// address for an EW-DX, left the panel reading "error", the driver retrying for
// ever, and nothing in /log saying why. The same fault on a Shure wrote
// `[shure:<id>] socket error: ...`.
//
// Real paths only. The Spectera case dials a loopback HTTPS server whose
// certificate nothing trusts and which answers 403 — the auth branch. The SSC
// case binds a real UDP socket aimed at a loopback port nothing listens on; no
// datagram leaves the machine.

import assert from "node:assert/strict";
import { once } from "node:events";
import { after, before, describe, it, mock } from "node:test";
import type * as dgram from "node:dgram";

import type { ConnectionState } from "../../types/integrations.js";
import { startSelfSignedPage, type SelfSignedPage } from "../../services/fixtures/self-signed-page.js";
import { SennheiserEwDx } from "./sennheiser-ewdx.js";
import { SennheiserSpectera } from "./sennheiser-spectera.js";

/** Everything written to the console while `fn` runs, one string per call. */
async function captured(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const spies = (["log", "warn", "error"] as const).map((level) =>
    mock.method(console, level, (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    }),
  );
  try {
    await fn();
  } finally {
    for (const s of spies) s.mock.restore();
  }
  return lines;
}

describe("a wireless failure reaches /log without a debug variable", () => {
  let page: SelfSignedPage;
  before(async () => {
    page = await startSelfSignedPage();
  });
  after(async () => {
    await page.close();
  });

  it("debug logging is off for this run", () => {
    // Read at import: set in a dev shell, it would make the cases below pass on
    // the bug.
    assert.equal(process.env.SPECTERA_DEBUG, undefined);
    assert.equal(process.env.SENNHEISER_DEBUG, undefined);
  });

  it("Spectera logs a refused API password", async () => {
    const port = Number(new URL(page.origin).port);
    const p = new SennheiserSpectera();
    const lines = await captured(async () => {
      const failed = new Promise<void>((resolve) =>
        p.onConnectionStateChange((s: ConnectionState) => {
          if (s === "error") resolve();
        }),
      );
      await p.connect({ host: "localhost", port, password: "wrong" });
      await failed;
      await p.disconnect();
    });
    const said = lines.filter((l) => l.startsWith("[spectera]"));
    assert.ok(
      said.some((l) => /403/.test(l) && /password/i.test(l)),
      `the base station refused the password and /log has no line saying so. Saw: ${JSON.stringify(lines)}`,
    );
    assert.ok(
      said.some((l) => l.includes("localhost")),
      "the line does not name the base station, so two of them cannot be told apart",
    );
  });

  it("an SSC receiver that stops answering says so when it is marked offline", async () => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const p = new SennheiserEwDx();
    try {
      const lines = await captured(async () => {
        await p.connect({ host: "127.0.0.1", port: 9, model: "EM2" });
        const sock = (p as unknown as { socket: dgram.Socket | null }).socket;
        assert.ok(sock, "connect() built no socket, so this case proves nothing");
        await once(sock, "listening");
        mock.timers.tick(8_000);
        assert.equal(p.getConnectionState(), "error", "the watchdog never tripped — this case proves nothing");
      });
      assert.ok(
        lines.some((l) => l.startsWith("[sennheiser:sennheiser-ewdx]") && l.includes("127.0.0.1")),
        `the receiver went offline and /log has no line saying so. Saw: ${JSON.stringify(lines)}`,
      );
    } finally {
      await p.disconnect();
      mock.timers.reset();
    }
  });
});
