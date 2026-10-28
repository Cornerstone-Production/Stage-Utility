// The Windows kiosk's launcher updater, run for real under pwsh.
//
// kiosk-update-windows.ps1 is what a SYSTEM scheduled task runs every five minutes
// on a PC at FOH. What matters in it is what a text scan cannot prove: that a
// download whose digest is not the one the server named never reaches kiosk.ps1,
// that what it did is told to the server on the next check, and that it speaks in
// its log when something changes and not every five minutes. So these run the real
// script against a fake server, with STAGE_KIOSK_TEST_ROOT moving the two folders it
// uses (ProgramData\StageUtility and Program Files\StageUtility) under a scratch
// directory.
//
// NOT covered here, and not by anything in CI: the scheduled tasks, SYSTEM, Windows
// PowerShell 5.1 (these run under pwsh, which accepts everything the scripts use),
// file ownership and ACLs (a standard user pre-creating a file in ProgramData is
// modelled as a file this test plants, which says where the script reads and
// writes, not who owns what), and install-windows.ps1 itself, which needs the
// ScheduledTasks module and an elevated token. Those need a Windows PC. Of the
// installer only Save-KioskScript and Install-Launcher are run, lifted out of the
// file by its parser.

import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { testSigningKey } from "../main/services/fixtures/test-signing-key.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KIOSK = path.join(HERE, "kiosk");
const UPDATER = path.join(KIOSK, "kiosk-update-windows.ps1");
const hasPwsh = spawnSync("sh", ["-c", "command -v pwsh"]).status === 0;
const sha = (b: Buffer | string) => crypto.createHash("sha256").update(b).digest("hex");
/** The release signing key these tests sign with, made for this run; and another. */
const KEY = testSigningKey();
const OTHER_KEY = testSigningKey(3072, "other");

/** The launcher a PC has, and the one the server has. Both parse. */
const OLD = Buffer.from("Write-Output 'old launcher'\r\n");
const NEW = Buffer.from("Write-Output 'new launcher'\r\n# a comment\r\n");

interface Fake {
  server: http.Server;
  base: string;
  /** The query of every check, in order. */
  checks: Record<string, string>[];
  /** How many times the launcher was downloaded. */
  downloads: number;
  /** What the check answers; set by each test. */
  answer: Record<string, unknown>;
  /** The bytes served as the launcher. */
  launcher: Buffer;
  /** True to drop the connection instead of serving the launcher. */
  failDownload: boolean;
  /** Called as the launcher is requested, before it is answered. */
  onDownload?: () => void;
  /** The launcher's signature: the release key's over `launcher` unless set; null for none (404). */
  sig?: Buffer | null;
  /** The key served at /kiosk/release-signing.pub.xml. */
  keyXml: string;
  /** Every path asked for, in order. */
  paths: string[];
}

async function fakeServer(): Promise<Fake> {
  const fake = { checks: [], downloads: 0, answer: {}, launcher: NEW, failDownload: false, keyXml: KEY.publicXml, paths: [] } as unknown as Fake;
  fake.server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    fake.paths.push(url.pathname);
    if (url.pathname === "/kiosk/kiosk-windows.ps1.sig" && fake.sig !== null) {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(fake.sig ?? KEY.sign(fake.launcher));
    } else if (url.pathname === "/kiosk/release-signing.pub.xml") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(fake.keyXml);
    } else if (url.pathname === "/api/machine-updates/check") {
      fake.checks.push(Object.fromEntries(url.searchParams));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(fake.answer));
    } else if (url.pathname === "/kiosk/kiosk-windows.ps1") {
      fake.downloads++;
      fake.onDownload?.();
      if (fake.failDownload) {
        req.socket.destroy();
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(fake.launcher);
    } else {
      res.writeHead(404);
      res.end("{}");
    }
  });
  await new Promise<void>((resolve) => fake.server.listen(0, "127.0.0.1", resolve));
  fake.base = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
  return fake;
}

/** The answer a server gives to say there is nothing to do. */
const upToDate = (reason = "This PC is on the server's launcher."): Record<string, unknown> => ({
  version: sha(OLD), update: false, reason,
});
/** The answer that says to update to NEW. */
const updateToNew = (want = sha(NEW)): Record<string, unknown> => ({
  version: want, update: true, reason: "An update is due.",
});

function pwsh(args: string[], env: Record<string, string>): Promise<{ status: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("pwsh", ["-NoProfile", ...args], { env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env } });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, out, err }));
  });
}

describe("the Windows kiosk scripts", { skip: !hasPwsh && "pwsh is not installed" }, () => {
  const fakes: Fake[] = [];
  let root: string;
  let state: string;
  let app: string;

  const serve = async (): Promise<Fake> => {
    const f = await fakeServer();
    fakes.push(f);
    return f;
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "su-kiosk-win-"));
    state = path.join(root, "ProgramData", "StageUtility");
    app = path.join(root, "ProgramFiles", "StageUtility");
    fs.mkdirSync(state, { recursive: true });
    fs.mkdirSync(app, { recursive: true });
    fs.writeFileSync(path.join(state, "device-id"), "11111111-2222-3333-4444-555555555555");
    fs.writeFileSync(path.join(state, "kiosk.ps1"), OLD);
    // The key the installer left beside the updater.
    fs.writeFileSync(path.join(app, "release-signing.pub.xml"), KEY.publicXml);
  });
  afterEach(async () => {
    fs.rmSync(root, { recursive: true, force: true });
    for (const f of fakes.splice(0)) await new Promise((r) => f.server.close(r));
  });

  const pointAt = (origin: string, file = path.join(app, "update-from")) => fs.writeFileSync(file, origin);
  const runUpdater = () => pwsh(["-File", UPDATER], { STAGE_KIOSK_TEST_ROOT: root });
  const launcher = () => fs.readFileSync(path.join(state, "kiosk.ps1"));
  const log = (): string[] => {
    const file = path.join(app, "kiosk-update.log");
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
  };
  const leftovers = () => fs.readdirSync(app).filter((n) => n.endsWith(".tmp"));
  const statusFile = () => path.join(app, "status.json");
  const readStatus = () => JSON.parse(fs.readFileSync(statusFile(), "utf8")) as Record<string, string | number>;
  const writeStatus = (s: Record<string, string | number>) =>
    fs.writeFileSync(statusFile(), JSON.stringify({ state: "idle", target: "", detail: "", answer: "", at: 0, retryAfter: 0, failures: 0, ...s }));
  const nowSec = () => Math.floor(Date.now() / 1000);

  describe("the scripts", () => {
    const SCRIPTS = ["install-windows.ps1", "kiosk-windows.ps1", "kiosk-update-windows.ps1"];

    it("all parse", async () => {
      for (const name of SCRIPTS) {
        const r = await pwsh(
          ["-Command", `$e = $null; $t = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${path.join(KIOSK, name)}', [ref]$t, [ref]$e); $e | ForEach-Object { $_.Message }; exit $e.Count`],
          {},
        );
        assert.equal(r.status, 0, `${name} does not parse: ${r.out}${r.err}`);
      }
    });

    it("are plain ASCII with no byte-order mark: they are served byte for byte and Windows PowerShell 5.1 reads a file without one as ANSI", () => {
      for (const name of SCRIPTS) {
        const bytes = fs.readFileSync(path.join(KIOSK, name));
        assert.ok(!bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), `${name} starts with a BOM`);
        const bad = [...bytes].findIndex((b) => b > 0x7f);
        assert.equal(bad, -1, `${name} has a byte over 0x7f at ${bad}`);
      }
    });
  });

  describe("the launcher's discovery port", () => {
    // The part of the launcher before it reads the device id, which sets $Port from the `port` file.
    const portOf = async (written: string | null): Promise<string> => {
      const lines = fs.readFileSync(path.join(KIOSK, "kiosk-windows.ps1"), "utf8").split("\n");
      const upTo = lines.findIndex((l) => l.startsWith("$id "));
      assert.ok(upTo > 0, "the launcher no longer reads $id: this test cuts there");
      const script = path.join(state, "port-probe.ps1");
      fs.writeFileSync(script, `${lines.slice(0, upTo).join("\n")}\n"PORT=$Port"\n`);
      if (written !== null) fs.writeFileSync(path.join(state, "port"), written);
      const r = await pwsh(["-File", script], {});
      assert.equal(r.status, 0, r.err);
      return /^PORT=(.*)$/m.exec(r.out)?.[1] ?? "";
    };

    it("is the one in the port file", async () => {
      assert.equal(await portOf("9123\n"), "9123");
    });
    it("is 8789 when there is no port file, or it is not a port", async () => {
      assert.equal(await portOf(null), "8789");
      for (const junk of ["", "eighty", "0", "70000", "-5"]) {
        fs.rmSync(path.join(state, "port"), { force: true });
        assert.equal(await portOf(junk), "8789", `port file ${JSON.stringify(junk)}`);
      }
    });
  });

  describe("kiosk-update-windows.ps1", () => {
    it("asks with the machine, the platform and the digest of what is installed", async () => {
      const f = await serve();
      f.answer = upToDate();
      pointAt(f.base);
      const r = await runUpdater();
      assert.equal(r.status, 0, r.out + r.err);
      assert.equal(f.checks.length, 1);
      assert.deepEqual(
        { ...f.checks[0], host: undefined },
        { machine: "11111111-2222-3333-4444-555555555555", platform: "windows", have: sha(OLD), host: undefined, state: "idle", target: "", detail: "", at: "0" },
      );
    });

    it("up to date: downloads nothing, says so once, and does not say it again", async () => {
      const f = await serve();
      f.answer = upToDate();
      pointAt(f.base);
      for (let i = 0; i < 3; i++) {
        const r = await runUpdater();
        assert.equal(r.status, 0, r.out + r.err);
      }
      assert.equal(f.checks.length, 3, "it asked every time");
      assert.equal(f.downloads, 0);
      assert.deepEqual(launcher(), OLD);
      const lines = log();
      assert.equal(lines.length, 1, lines.join("\n"));
      assert.match(lines[0], /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ \[helper-update\] http:\/\/127\.0\.0\.1:\d+: This PC is on the server's launcher\.$/);
    });

    it("says a new reason when the server's reason changes, and only then", async () => {
      const f = await serve();
      pointAt(f.base);
      f.answer = upToDate("Waiting: a service is live.");
      await runUpdater();
      await runUpdater();
      f.answer = upToDate("Waiting: automatic updates are off.");
      await runUpdater();
      await runUpdater();
      const lines = log();
      assert.equal(lines.length, 2, lines.join("\n"));
      assert.match(lines[0], /a service is live/);
      assert.match(lines[1], /automatic updates are off/);
    });

    it("a server that does not answer is logged once, then not again until it answers", async () => {
      const f = await serve();
      pointAt(f.base);
      f.answer = upToDate();
      // Nobody listens on the port a server had a moment ago.
      const dead = await serve();
      const gone = dead.base;
      await new Promise((r) => dead.server.close(r));
      pointAt(gone);
      for (let i = 0; i < 3; i++) assert.equal((await runUpdater()).status, 0);
      assert.equal(log().length, 1, log().join("\n"));
      assert.match(log()[0], /did not answer the update check/);
      pointAt(f.base);
      await runUpdater();
      assert.equal(log().length, 2, log().join("\n"));
      assert.match(log()[1], /This PC is on the server's launcher/);
      pointAt(gone);
      await runUpdater();
      assert.equal(log().length, 3, "silent again after it answered, so a second outage is said too");
    });

    it("update: downloads, verifies and replaces the launcher byte for byte, and the next check says it updated", async () => {
      const f = await serve();
      f.answer = updateToNew();
      pointAt(f.base);
      const r = await runUpdater();
      assert.equal(r.status, 0, r.out + r.err);
      assert.equal(f.downloads, 1);
      assert.deepEqual(launcher(), NEW, "kiosk.ps1 is exactly what was served, CRLF and all");
      assert.deepEqual(leftovers(), []);
      assert.match(log().join("\n"), /updated kiosk\.ps1; the new launcher runs at the next sign-in/);
      assert.match(log().join("\n"), /\[helper-update\] signature valid: kiosk-windows\.ps1\.sig, against the release signing key installed on this PC/);
      assert.ok(f.paths.includes("/kiosk/kiosk-windows.ps1.sig"));

      f.answer = { version: sha(NEW), update: false, reason: "This PC is on the server's launcher." };
      await runUpdater();
      assert.equal(f.downloads, 1, "an updated PC downloads nothing more");
      assert.deepEqual(
        { ...f.checks[1], host: undefined, at: undefined },
        { machine: "11111111-2222-3333-4444-555555555555", platform: "windows", have: sha(NEW), host: undefined, state: "updated", target: sha(NEW), detail: "", at: undefined },
      );
      assert.ok(Number(f.checks[1].at) > 0, "with when it updated");
    });

    it("a download whose digest is not the one named is refused: kiosk.ps1 is untouched, and the next check says it failed and why", async () => {
      const f = await serve();
      const named = sha(NEW);
      f.answer = updateToNew(named);
      // Same length, different bytes: what a proxy or a truncated body looks like.
      f.launcher = Buffer.from("Write-Output 'NEW launcher'\r\n# a comment\r\n");
      pointAt(f.base);
      const r = await runUpdater();
      assert.equal(r.status, 0, r.out + r.err);
      assert.equal(f.downloads, 1);
      assert.deepEqual(launcher(), OLD, "the old launcher must survive a bad download");
      assert.deepEqual(leftovers(), [], "the rejected download is not left behind");
      assert.match(log().join("\n"), /the update to [0-9a-f]{64} failed: the download has SHA-256 [0-9a-f]{64}, expected [0-9a-f]{64}\. kiosk\.ps1 is unchanged/);

      f.answer = { ...upToDate("This version failed here before."), version: named };
      await runUpdater();
      assert.equal(f.checks[1].state, "failed");
      assert.equal(f.checks[1].target, named);
      assert.match(f.checks[1].detail, /^the download has SHA-256 [0-9a-f]{64}, expected [0-9a-f]{64}$/, "the whole reason survives the 200 characters the server keeps");
      assert.equal(f.checks[1].have, sha(OLD), "what is installed has not changed");
      assert.equal(readStatus().retryAfter, 0, "a digest mismatch would happen again, so it is not retried on a timer");
      // When it failed, so the server can tell this failure from the next: one Try
      // again is then one retry, not a retry every five minutes.
      const at = Number(f.checks[1].at);
      assert.ok(at > Date.now() / 1000 - 600 && at <= Date.now() / 1000 + 5, `at: ${f.checks[1].at}`);
    });

    describe("the release's signature", () => {
      const keyFile = () => path.join(app, "release-signing.pub.xml");

      for (const [label, sig] of [
        ["made by another key", () => OTHER_KEY.sign(NEW)],
        ["of other bytes", () => KEY.sign("Write-Output 'another launcher'\r\n")],
        ["that is not a signature at all", () => Buffer.from("<html>502 Bad Gateway</html>")],
        // .NET throws on an empty signature rather than answering false: the path
        // where the check itself fails must still refuse.
        ["that is empty", () => Buffer.alloc(0)],
      ] as const) {
        it(`one ${label} is refused, though the digest matches: kiosk.ps1 is untouched, and the next check says why`, async () => {
          const f = await serve();
          f.answer = updateToNew();
          f.sig = sig();
          pointAt(f.base);
          const r = await runUpdater();
          assert.equal(r.status, 0, r.out + r.err);
          assert.deepEqual(launcher(), OLD);
          assert.deepEqual(leftovers(), []);
          assert.match(log().join("\n"), /the update to [0-9a-f]{64} failed: signature invalid: kiosk-windows\.ps1\.sig does not verify against the release signing key installed on this PC\. kiosk\.ps1 is unchanged/);
          assert.equal(readStatus().state, "failed", "a signature that does not verify would not verify again");
          f.answer = { ...upToDate("This version failed here before."), version: sha(NEW) };
          await runUpdater();
          assert.equal(f.checks[1].state, "failed");
          assert.equal(f.checks[1].detail, "signature invalid: kiosk-windows.ps1.sig does not verify against the release signing key installed on this PC");
        });
      }

      it("is checked against the key installed on this PC, never one the server offers", async () => {
        const f = await serve();
        f.answer = updateToNew();
        f.keyXml = OTHER_KEY.publicXml;
        f.sig = OTHER_KEY.sign(NEW);
        pointAt(f.base);
        await runUpdater();
        assert.deepEqual(launcher(), OLD);
        assert.ok(!f.paths.includes("/kiosk/release-signing.pub.xml"), "the updater never asks for a key");
        assert.match(String(readStatus().detail), /^signature invalid/);
      });

      it("missing is retrying, with the reason, and the launcher is untouched", async () => {
        const f = await serve();
        f.answer = updateToNew();
        f.sig = null;
        pointAt(f.base);
        await runUpdater();
        assert.deepEqual(launcher(), OLD);
        assert.deepEqual(leftovers(), []);
        const saved = readStatus();
        assert.equal(saved.state, "retrying", "a server may have the signature later");
        assert.match(String(saved.detail), /^signature missing: /);
        assert.match(log().join("\n"), /could not download the launcher or its signature \(signature missing: .+\); trying again after \d\d:\d\d UTC/);
      });

      for (const [label, plant] of [
        ["there is no key installed", () => fs.rmSync(keyFile())],
        ["the installed key is not a key", () => fs.writeFileSync(keyFile(), "not a key")],
        ["the installed key is not 3072-bit", () => fs.writeFileSync(keyFile(), testSigningKey(2048).publicXml)],
      ] as const) {
        it(`holds the update, downloading nothing, when ${label}`, async () => {
          const f = await serve();
          f.answer = updateToNew();
          pointAt(f.base);
          plant();
          await runUpdater();
          assert.equal(f.downloads, 0, "nothing is downloaded with nothing to verify it by");
          assert.deepEqual(launcher(), OLD);
          const saved = readStatus();
          assert.equal(saved.state, "failed");
          assert.match(String(saved.detail), /^signature not checked: no readable release signing key is installed/);
        });
      }
    });

    describe("a download that fails on the network", () => {
      it("is retrying, with the reason and a retryAfter 30 minutes on, tells the server, and downloads nothing before then", async () => {
        const f = await serve();
        f.answer = updateToNew();
        f.failDownload = true;
        pointAt(f.base);
        const r = await runUpdater();
        assert.equal(r.status, 0, r.out + r.err);
        // The HTTP client may retry a reset connection itself, so count attempts as a change, not as 1.
        assert.ok(f.downloads >= 1, "it tried the download");
        const attempted = f.downloads;
        assert.deepEqual(launcher(), OLD);
        assert.deepEqual(leftovers(), []);
        const saved = readStatus();
        assert.equal(saved.state, "retrying", "not failed: the server would never offer this launcher again");
        assert.equal(saved.target, sha(NEW));
        assert.ok(String(saved.detail).length > 0, "the reason is kept");
        assert.equal(saved.failures, 1);
        assert.ok(Math.abs(Number(saved.retryAfter) - (nowSec() + 1800)) < 120, `retryAfter ${saved.retryAfter} is not about 30 minutes on`);
        assert.equal(log().filter((l) => /could not download the launcher or its signature \(.+\); trying again after \d\d:\d\d UTC$/.test(l)).length, 1, log().join("\n"));

        // Before retryAfter: it checks in, so the PC stays listed, and does not download.
        for (let i = 0; i < 2; i++) assert.equal((await runUpdater()).status, 0);
        assert.equal(f.checks.length, 3, "it still asked every time");
        assert.equal(f.downloads, attempted, "and did not download again before retryAfter");
        assert.equal(f.checks[1].state, "retrying");
        assert.equal(f.checks[1].target, sha(NEW));
        assert.ok(f.checks[1].detail.length > 0, "the server is told why");
      });

      it("is tried again once retryAfter has passed, and the wait doubles each time in a row", async () => {
        const f = await serve();
        f.answer = updateToNew();
        f.failDownload = true;
        pointAt(f.base);
        await runUpdater();
        assert.equal(readStatus().failures, 1);
        const attempted = f.downloads;
        writeStatus({ ...readStatus(), retryAfter: nowSec() - 1 });
        await runUpdater();
        assert.ok(f.downloads > attempted, "past retryAfter it downloads again");
        const second = readStatus();
        assert.equal(second.failures, 2);
        assert.ok(Math.abs(Number(second.retryAfter) - (nowSec() + 3600)) < 120, `retryAfter ${second.retryAfter} is not about an hour on`);
      });

      it("never waits more than 6 hours", async () => {
        const f = await serve();
        f.answer = updateToNew();
        f.failDownload = true;
        pointAt(f.base);
        writeStatus({ target: sha(NEW), failures: 9, retryAfter: nowSec() - 1 });
        await runUpdater();
        const saved = readStatus();
        assert.equal(saved.failures, 10);
        assert.ok(Math.abs(Number(saved.retryAfter) - (nowSec() + 6 * 3600)) < 120, `retryAfter ${saved.retryAfter} is not about 6 hours on`);
      });

      it("starts over for a new target, whatever the old one was waiting on", async () => {
        const f = await serve();
        f.answer = updateToNew();
        f.failDownload = true;
        pointAt(f.base);
        writeStatus({ target: "f".repeat(64), failures: 4, retryAfter: nowSec() + 5 * 3600 });
        await runUpdater();
        assert.ok(f.downloads >= 1, "a new target is not held by the old one's timer");
        const saved = readStatus();
        assert.equal(saved.failures, 1);
        assert.equal(saved.target, sha(NEW));
        assert.ok(Math.abs(Number(saved.retryAfter) - (nowSec() + 1800)) < 120);
      });

      it("stops reporting retrying once the launcher is the server's", async () => {
        const f = await serve();
        f.answer = upToDate();
        pointAt(f.base);
        writeStatus({ state: "retrying", target: sha(NEW), failures: 2, retryAfter: nowSec() + 3600, detail: "earlier" });
        await runUpdater();
        assert.equal(f.checks[0].state, "retrying", "first report is still what it last did");
        const saved = readStatus();
        assert.equal(saved.state, "idle");
        assert.equal(saved.retryAfter, 0);
        assert.equal(saved.failures, 0);
      });

      it("success clears the backoff", async () => {
        const f = await serve();
        f.answer = updateToNew();
        pointAt(f.base);
        writeStatus({ target: sha(NEW), failures: 3, retryAfter: nowSec() - 1, detail: "earlier" });
        await runUpdater();
        assert.deepEqual(launcher(), NEW);
        const saved = readStatus();
        assert.equal(saved.state, "updated");
        assert.equal(saved.failures, 0);
        assert.equal(saved.retryAfter, 0);
        assert.equal(saved.detail, "");
        assert.ok(Math.abs(Number(saved.at) - nowSec()) < 120, "when it updated is recorded");
      });
    });

    describe("updated", () => {
      const checkAfter = async (at: number): Promise<Record<string, string>> => {
        const f = await serve();
        fs.writeFileSync(path.join(state, "kiosk.ps1"), NEW);
        f.answer = { version: sha(NEW), update: false, reason: "This PC is on the server's launcher." };
        pointAt(f.base);
        writeStatus({ state: "updated", target: sha(NEW), at });
        await runUpdater();
        return f.checks[0];
      };

      it("is still reported within a day of the update", async () => {
        assert.equal((await checkAfter(nowSec() - 23 * 3600)).state, "updated");
      });
      it("is reported as idle once a day has passed, since it no longer takes effect 'at the next sign-in' news", async () => {
        assert.equal((await checkAfter(nowSec() - 25 * 3600)).state, "idle");
      });
    });

    it("a download with the right digest that does not parse is refused too", async () => {
      const f = await serve();
      f.launcher = Buffer.from("function {{{ \r\n");
      f.answer = updateToNew(sha(f.launcher));
      pointAt(f.base);
      await runUpdater();
      assert.deepEqual(launcher(), OLD);
      assert.deepEqual(leftovers(), []);
      assert.match(log().join("\n"), /does not parse/);
      assert.equal(JSON.parse(fs.readFileSync(path.join(app, "status.json"), "utf8")).state, "failed");
    });

    it("an update with no digest to check against is refused", async () => {
      const f = await serve();
      f.answer = { version: "x", update: true, reason: "An update is due." };
      pointAt(f.base);
      await runUpdater();
      assert.equal(f.downloads, 0, "nothing is downloaded with nothing to verify it by");
      assert.deepEqual(launcher(), OLD);
      assert.match(log().join("\n"), /did not name a SHA-256/);
    });

    it("does not replace a launcher that is a link", { skip: process.platform === "win32" && "needs a symlink" }, async () => {
      const f = await serve();
      f.answer = updateToNew();
      pointAt(f.base);
      const real = path.join(root, "elsewhere.ps1");
      fs.writeFileSync(real, OLD);
      fs.rmSync(path.join(state, "kiosk.ps1"));
      fs.symlinkSync(real, path.join(state, "kiosk.ps1"));
      await runUpdater();
      assert.equal(f.downloads, 0);
      assert.deepEqual(fs.readFileSync(real), OLD);
      assert.ok(fs.lstatSync(path.join(state, "kiosk.ps1")).isSymbolicLink(), "the link is still a link");
      assert.match(log().join("\n"), /is a link, not a file/);
    });

    it("asks the server in update-from, and never one named by a server file in the state folder, which any user can write", async () => {
      const installedFrom = await serve();
      const planted = await serve();
      installedFrom.answer = upToDate();
      planted.answer = upToDate();
      pointAt(installedFrom.base);
      pointAt(`${planted.base}/`, path.join(state, "server"));
      await runUpdater();
      assert.equal(installedFrom.checks.length, 1);
      assert.equal(planted.checks.length, 0, "a server file in ProgramData must not decide which server SYSTEM asks");
    });

    it("with only a planted server file and no update-from, asks nobody", async () => {
      const planted = await serve();
      planted.answer = updateToNew();
      pointAt(planted.base, path.join(state, "server"));
      await runUpdater();
      assert.equal(planted.checks.length, 0);
      assert.equal(planted.downloads, 0);
      assert.deepEqual(launcher(), OLD);
      assert.match(log().join("\n"), /there is no server to ask/);
    });

    it("downloads the launcher from the server that told it to update", async () => {
      const installedFrom = await serve();
      const planted = await serve();
      installedFrom.answer = updateToNew();
      planted.launcher = Buffer.from("Write-Output 'wrong server'\r\n");
      pointAt(installedFrom.base);
      pointAt(planted.base, path.join(state, "server"));
      await runUpdater();
      assert.equal(planted.downloads, 0);
      assert.deepEqual(launcher(), NEW);
    });

    it("with no server to ask, says so once", async () => {
      for (let i = 0; i < 2; i++) assert.equal((await runUpdater()).status, 0);
      assert.equal(log().length, 1, log().join("\n"));
      assert.match(log()[0], /there is no server to ask/);
    });

    it("with no launcher on the PC, says so once and leaves it to the installer", async () => {
      const f = await serve();
      f.answer = updateToNew();
      pointAt(f.base);
      fs.rmSync(path.join(state, "kiosk.ps1"));
      for (let i = 0; i < 2; i++) assert.equal((await runUpdater()).status, 0);
      assert.equal(f.checks.length, 0);
      assert.ok(!fs.existsSync(path.join(state, "kiosk.ps1")));
      assert.equal(log().length, 1, log().join("\n"));
    });
  });

  describe("install-windows.ps1's Save-KioskScript", () => {
    // The function is lifted out of the installer by its parser and run for real: the
    // installer as a whole needs an elevated Windows session.
    const save = (base: string): Promise<{ status: number | null; out: string; err: string }> =>
      pwsh(
        [
          "-Command",
          `$t = $null; $e = $null; $ast = [System.Management.Automation.Language.Parser]::ParseFile($env:INSTALLER, [ref]$t, [ref]$e);` +
            `$fn = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Save-KioskScript' }, $true);` +
            `if (-not $fn) { throw 'Save-KioskScript is gone' };` +
            `$AppDir = $env:APP_DIR; Invoke-Expression $fn.Extent.Text;` +
            `Save-KioskScript -From $env:FROM -Name 'kiosk-windows.ps1' -To $env:TO`,
        ],
        { INSTALLER: path.join(KIOSK, "install-windows.ps1"), APP_DIR: app, FROM: base, TO: path.join(state, "kiosk.ps1") },
      );

    it("stages the download in Program Files, never in the state folder, and puts it in place byte for byte", async () => {
      const f = await serve();
      fs.rmSync(app, { recursive: true });
      let appExisted: boolean | null = null;
      f.onDownload = () => {
        appExisted = fs.existsSync(app);
      };
      // What a standard user could plant beforehand to keep ownership of the result.
      const planted = path.join(state, "kiosk.ps1.download");
      fs.writeFileSync(planted, "planted");
      const r = await save(f.base);
      assert.equal(r.status, 0, r.out + r.err);
      assert.equal(f.downloads, 1);
      assert.deepEqual(launcher(), NEW);
      assert.equal(appExisted, true, "Program Files\\StageUtility is made before the download starts, since that is where it is staged");
      assert.equal(fs.readFileSync(planted, "utf8"), "planted", "the planted file was neither written through nor moved");
      assert.notEqual(fs.statSync(planted).ino, fs.statSync(path.join(state, "kiosk.ps1")).ino, "kiosk.ps1 is not the file that was planted");
      assert.deepEqual(fs.readdirSync(state).filter((n) => /\.(download|tmp)$/.test(n) && n !== "kiosk.ps1.download"), [], "nothing else was staged in the state folder");
      assert.deepEqual(fs.readdirSync(app), [], "the staging file is gone afterwards");
    });
  });

  describe("install-windows.ps1's Save-SigningKey", () => {
    const keyFile = () => path.join(app, "release-signing.pub.xml");
    // Its pipeline output is printed after OUTPUT:, since Install-Updater reads its
    // own output as its answer and anything there reads as a failure.
    const saveKey = (base: string, env: Record<string, string> = {}) =>
      pwsh(
        [
          "-Command",
          `$t = $null; $e = $null; $ast = [System.Management.Automation.Language.Parser]::ParseFile($env:INSTALLER, [ref]$t, [ref]$e);` +
            `$fn = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Save-SigningKey' }, $true);` +
            `if (-not $fn) { throw 'Save-SigningKey is gone' };` +
            `$ErrorActionPreference = 'Stop'; $AppDir = $env:APP_DIR; Invoke-Expression $fn.Extent.Text;` +
            `$o = @(Save-SigningKey -From $env:FROM); Write-Output "OUTPUT:$($o.Count)"`,
        ],
        { INSTALLER: path.join(KIOSK, "install-windows.ps1"), APP_DIR: app, FROM: base, ...env },
      );
    const REPLACE = { STAGE_REPLACE_SIGNING_KEY: "1" };

    it("keeps a key already installed, asks the server for none, and returns nothing", async () => {
      const f = await serve();
      f.keyXml = OTHER_KEY.publicXml;
      const r = await saveKey(f.base);
      assert.equal(r.status, 0, r.out + r.err);
      assert.equal(fs.readFileSync(keyFile(), "utf8"), KEY.publicXml);
      assert.ok(!f.paths.includes("/kiosk/release-signing.pub.xml"));
      assert.match(r.out, /keeping the release signing key already installed/);
      assert.match(r.out, /OUTPUT:0/, "nothing on the pipeline, or Install-Updater would read it as a failure");
    });

    it("takes the server's key over the installed one with STAGE_REPLACE_SIGNING_KEY=1", async () => {
      const f = await serve();
      f.keyXml = OTHER_KEY.publicXml;
      const r = await saveKey(f.base, REPLACE);
      assert.equal(r.status, 0, r.out + r.err);
      assert.equal(fs.readFileSync(keyFile(), "utf8"), OTHER_KEY.publicXml);
      assert.match(r.out, /OUTPUT:0/);
    });

    it("writes the server's key beside the updater, as served", async () => {
      const f = await serve();
      fs.rmSync(keyFile());
      const r = await saveKey(f.base);
      assert.equal(r.status, 0, r.out + r.err);
      assert.equal(fs.readFileSync(keyFile(), "utf8"), KEY.publicXml);
      assert.deepEqual(leftovers(), []);
    });

    for (const [label, xml, why] of [
      ["is not a key", "PLACEHOLDER", /is not an RSA key/],
      ["is a 2048-bit key", testSigningKey(2048).publicXml, /is a 2048-bit key, not 3072-bit/],
    ] as const) {
      it(`refuses a key that ${label}, and keeps the one already installed`, async () => {
        const f = await serve();
        f.keyXml = xml;
        const r = await saveKey(f.base, REPLACE);
        assert.notEqual(r.status, 0, r.out);
        assert.match(r.out + r.err, why);
        assert.equal(fs.readFileSync(keyFile(), "utf8"), KEY.publicXml, "the installed key is untouched");
        assert.deepEqual(leftovers(), []);
      });
    }

    it("is part of installing the updater, before the task is registered", async () => {
      const r = await pwsh(
        [
          "-Command",
          `$t = $null; $e = $null; $ast = [System.Management.Automation.Language.Parser]::ParseFile($env:INSTALLER, [ref]$t, [ref]$e);` +
            `$fn = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Install-Updater' }, $true);` +
            `$fn.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] }, $true) | ForEach-Object { $_.GetCommandName() }`,
        ],
        { INSTALLER: path.join(KIOSK, "install-windows.ps1") },
      );
      assert.equal(r.status, 0, r.err);
      const names = r.out.split("\n").map((l) => l.trim()).filter(Boolean);
      assert.ok(names.includes("Save-SigningKey"), r.out);
      assert.ok(names.indexOf("Save-SigningKey") < names.indexOf("Register-ScheduledTask"), r.out);
    });
  });

  describe("install-windows.ps1's Install-Launcher", () => {
    // The installer's first download of the launcher: the digest the server names in
    // the update check is what it must be, as for an update. Lifted out by the parser
    // like Save-KioskScript, with the folders it uses set and the installer's own
    // $ErrorActionPreference, which is what makes a failed download stop it.
    const FNS = ["Save-KioskScript", "Install-Launcher"];
    const install = (base: string, extra = ""): Promise<{ status: number | null; out: string; err: string }> =>
      pwsh(
        [
          "-Command",
          `$t = $null; $e = $null; $ast = [System.Management.Automation.Language.Parser]::ParseFile($env:INSTALLER, [ref]$t, [ref]$e);` +
            `foreach ($name in '${FNS.join("','")}') {` +
            `$fn = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name }, $true);` +
            `if (-not $fn) { throw "$name is gone" }; Invoke-Expression $fn.Extent.Text };` +
            `$ErrorActionPreference = 'Stop'; $AppDir = $env:APP_DIR; ${extra}` +
            `Install-Launcher -From $env:FROM -Machine 'machine-1' -To $env:TO`,
        ],
        { INSTALLER: path.join(KIOSK, "install-windows.ps1"), APP_DIR: app, FROM: base, TO: path.join(state, "kiosk.ps1") },
      );
    const noLauncher = () => fs.rmSync(path.join(state, "kiosk.ps1"));

    it("installs a launcher whose bytes are the digest the server named, even with updates held", async () => {
      const f = await serve();
      f.answer = { version: sha(NEW), update: false, reason: "Updates are off." };
      noLauncher();
      const r = await install(f.base);
      assert.equal(r.status, 0, r.out + r.err);
      assert.deepEqual(launcher(), NEW);
      assert.equal(f.checks.length, 1);
      assert.equal(f.checks[0].machine, "machine-1");
      assert.equal(f.checks[0].platform, "windows");
      assert.equal(f.checks[0].have, sha(NEW), "the check says what was downloaded, not a placeholder");
    });

    it("refuses a launcher whose bytes are not the digest the server named, and leaves nothing behind", async () => {
      const f = await serve();
      f.answer = { version: sha(NEW), update: false, reason: "x" };
      f.launcher = Buffer.from("Write-Output 'somebody else'\r\n"); // parses, but is not what the server named
      noLauncher();
      const r = await install(f.base);
      assert.notEqual(r.status, 0, r.out);
      assert.match(r.out + r.err, /expected /);
      assert.equal(f.downloads, 1);
      assert.equal(f.checks[0].have, sha(f.launcher), "the server was told what this PC was given");
      assert.ok(!fs.existsSync(path.join(state, "kiosk.ps1")), "the refused launcher was not installed");
      assert.deepEqual(leftovers(), [], "the refused download was not left in Program Files");
    });

    it("leaves a launcher already there alone when the download is refused", async () => {
      const f = await serve();
      f.answer = { version: sha(NEW), update: false, reason: "x" };
      f.launcher = Buffer.from("Write-Output 'somebody else'\r\n");
      const r = await install(f.base);
      assert.notEqual(r.status, 0, r.out);
      assert.deepEqual(launcher(), OLD);
    });

    it("installs nothing when the server names no digest, or does not answer", async () => {
      const f = await serve();
      noLauncher();
      for (const answer of [{}, { version: "not-a-digest" }, { version: sha(NEW).slice(1) }]) {
        f.answer = answer;
        const r = await install(f.base);
        assert.notEqual(r.status, 0, JSON.stringify(answer));
      }
      assert.ok(!fs.existsSync(path.join(state, "kiosk.ps1")), "a download with no digest to check it against is not installed");
      assert.deepEqual(leftovers(), []);
      const gone = await install("http://127.0.0.1:9");
      assert.notEqual(gone.status, 0);
      assert.ok(!fs.existsSync(path.join(state, "kiosk.ps1")));
    });

    it("is what the installer runs for the launcher, with no other way to fetch a script", async () => {
      // The installer as a whole needs an elevated Windows session, so its parse tree
      // is read instead: Install-Launcher is called from the main flow, and the one
      // other call that downloads a script is the updater's.
      const r = await pwsh(
        [
          "-Command",
          `$t = $null; $e = $null; $ast = [System.Management.Automation.Language.Parser]::ParseFile($env:INSTALLER, [ref]$t, [ref]$e);` +
            `$cmds = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] }, $true);` +
            `$inFn = { param($c) $p = $c.Parent; while ($p) { if ($p -is [System.Management.Automation.Language.FunctionDefinitionAst]) { return $p.Name }; $p = $p.Parent }; '' };` +
            `foreach ($c in $cmds) { $n = $c.GetCommandName(); if ($n -in 'Install-Launcher','Save-KioskScript') { "$n in [$(& $inFn $c)] $($c.Extent.Text)" } }`,
        ],
        { INSTALLER: path.join(KIOSK, "install-windows.ps1") },
      );
      assert.equal(r.status, 0, r.err);
      const calls = r.out.split("\n").filter(Boolean);
      assert.ok(calls.some((c) => c.startsWith("Install-Launcher in []")), `the main flow does not call Install-Launcher:\n${r.out}`);
      // Whatever it is called with: only the launcher's path may fetch a script
      // with a digest to hold it to, and the updater's is the other caller.
      const savers = calls.filter((c) => c.startsWith("Save-KioskScript")).map((c) => /^Save-KioskScript in \[([^\]]*)\]/.exec(c)?.[1]);
      assert.deepEqual(savers.sort(), ["Install-Launcher", "Install-Updater"], r.out);
    });
  });
});
