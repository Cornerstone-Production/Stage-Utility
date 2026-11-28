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
import { ShureUlxd } from "./shure-ulxd.js";

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

  it("a refused password is reported as that, and nothing else, while it waits to retry", async () => {
    // The stream watchdog was armed before the request and never stopped on a
    // refusal, so with a retry delay longer than the idle window it fired too,
    // adding "did not open the telemetry stream" — pointing at the network.
    const port = Number(new URL(page.origin).port);
    const p = new SennheiserSpectera();
    (p as unknown as { idleMs: number }).idleMs = 60;
    const lines = await captured(async () => {
      const failed = new Promise<void>((resolve) =>
        p.onConnectionStateChange((s: ConnectionState) => {
          if (s === "error") resolve();
        }),
      );
      await p.connect({ host: "localhost", port, password: "wrong" });
      await failed;
      await new Promise((r) => setTimeout(r, 400)); // well past the idle window, short of the 3 s retry
      await p.disconnect();
    });
    const said = lines.filter((l) => l.startsWith("[spectera]"));
    assert.equal(said.length, 1, `expected only the refused-password line. Saw: ${JSON.stringify(said)}`);
  });

  it("a new configuration is news: the same refusal is said again after a reconnect", async () => {
    const port = Number(new URL(page.origin).port);
    const p = new SennheiserSpectera();
    const refusedOnce = async () => {
      const failed = new Promise<void>((resolve) =>
        p.onConnectionStateChange((s: ConnectionState) => {
          if (s === "error") resolve();
        }),
      );
      await p.connect({ host: "localhost", port, password: "wrong" });
      await failed;
      await p.disconnect();
    };
    const lines = await captured(async () => {
      await refusedOnce();
      await refusedOnce();
    });
    assert.equal(
      lines.filter((l) => /refused the API password/.test(l)).length,
      2,
      `an operator who re-entered the password and was refused again got no line. Saw: ${JSON.stringify(lines)}`,
    );
  });

  it("a Shure receiver that refuses the connection says so", async () => {
    const p = new ShureUlxd();
    const lines = await captured(async () => {
      const down = new Promise<void>((resolve) =>
        p.onConnectionStateChange((s: ConnectionState) => {
          if (s === "error") resolve();
        }),
      );
      await p.connect({ host: "127.0.0.1", port: 9, channels: 2 });
      await down;
      await p.disconnect();
    });
    assert.ok(
      lines.some((l) => l.startsWith("[shure:shure-ulxd] socket error:")),
      `a refused connection left no line. Saw: ${JSON.stringify(lines)}`,
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

  it("an SSC socket error stops that link's timers, so it is not also reported as silent", async () => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const p = new SennheiserEwDx();
    try {
      const lines = await captured(async () => {
        await p.connect({ host: "127.0.0.1", port: 9, model: "EM2" });
        const sock = (p as unknown as { socket: dgram.Socket | null }).socket;
        assert.ok(sock, "connect() built no socket, so this case proves nothing");
        await once(sock, "listening");
        sock.emit("error", Object.assign(new Error("simulated send failure"), { code: "ESIM" }));
        mock.timers.tick(8_000);
      });
      assert.ok(lines.some((l) => l.includes("socket error: simulated send failure")), JSON.stringify(lines));
      assert.ok(
        !lines.some((l) => l.includes("has not answered")),
        `the closed socket's watchdog still fired. Saw: ${JSON.stringify(lines)}`,
      );
    } finally {
      await p.disconnect();
      mock.timers.reset();
    }
  });

  it("a silent SSC receiver is reminded about, not mentioned once and forgotten", async () => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    const p = new SennheiserEwDx();
    let offline = 0;
    try {
      const lines = await captured(async () => {
        await p.connect({ host: "127.0.0.1", port: 9, model: "EM2" });
        const sock = (p as unknown as { socket: dgram.Socket | null }).socket;
        assert.ok(sock, "connect() built no socket, so this case proves nothing");
        await once(sock, "listening");
        p.onStatus((s) => {
          if (!s.online) offline++;
        });
        // In watchdog-sized steps, so the outage log sees the clock move between reports.
        for (let t = 0; t < 16 * 60 * 1000; t += 8_000) mock.timers.tick(8_000);
      });
      const silent = lines.filter((l) => l.includes("has not answered"));
      assert.equal(silent.length, 2, `expected the first line and one 15-minute reminder. Saw: ${JSON.stringify(silent)}`);
      assert.match(silent[1], /still failing/);
      // Two channels (EM2), offline once — not re-sent on every 8 s trip.
      assert.equal(offline, 2, `the channels were re-emitted offline ${offline} times across one silence`);
    } finally {
      await p.disconnect();
      mock.timers.reset();
    }
  });

  it("a refused Spectera subscription is closed by the telemetry that follows", async () => {
    // The subscription goes out once per stream, so its own success can land
    // inside the outage log's settle window and leave the run open; the next
    // refusal, days later, would then be silenced or read "still failing".
    // Telemetry recurs, so it is what closes the run.
    mock.timers.enable({ apis: ["Date"] });
    const p = new SennheiserSpectera();
    try {
      const inner = p as unknown as {
        sessionUuid: string | null;
        reportFailure(kind: string, message: string, key: string): void;
        handleEvent(e: { event: string | null; data: string }): void;
      };
      const lines = await captured(async () => {
        inner.reportFailure("subscribe 403", "refused the telemetry subscription", "subscribe");
        inner.sessionUuid = "session";
        mock.timers.tick(3 * 60 * 1000);
        inner.handleEvent({
          event: null,
          data: JSON.stringify({ address: "/api/mts/paired/all/sek1", value: { state: "Connected" } }),
        });
      });
      assert.ok(
        lines.some((l) => l.startsWith("[spectera] working again")),
        `telemetry arrived and the subscription's outage never closed. Saw: ${JSON.stringify(lines)}`,
      );
    } finally {
      mock.timers.reset();
    }
  });
});
