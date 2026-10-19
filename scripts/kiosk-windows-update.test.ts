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
// and install-windows.ps1 itself, which needs the ScheduledTasks module and an
// elevated token. Those need a Windows PC; the installer is only checked to parse.

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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KIOSK = path.join(HERE, "kiosk");
const UPDATER = path.join(KIOSK, "kiosk-update-windows.ps1");
const hasPwsh = spawnSync("sh", ["-c", "command -v pwsh"]).status === 0;
const sha = (b: Buffer | string) => crypto.createHash("sha256").update(b).digest("hex");

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
}

async function fakeServer(): Promise<Fake> {
  const fake = { checks: [], downloads: 0, answer: {}, launcher: NEW } as unknown as Fake;
  fake.server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/api/machine-updates/check") {
      fake.checks.push(Object.fromEntries(url.searchParams));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(fake.answer));
    } else if (url.pathname === "/kiosk/kiosk-windows.ps1") {
      fake.downloads++;
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
        { machine: "11111111-2222-3333-4444-555555555555", platform: "windows", have: sha(OLD), host: undefined, state: "idle", target: "", detail: "" },
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

      f.answer = { version: sha(NEW), update: false, reason: "This PC is on the server's launcher." };
      await runUpdater();
      assert.equal(f.downloads, 1, "an updated PC downloads nothing more");
      assert.deepEqual(
        { ...f.checks[1], host: undefined },
        { machine: "11111111-2222-3333-4444-555555555555", platform: "windows", have: sha(NEW), host: undefined, state: "updated", target: sha(NEW), detail: "" },
      );
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

    it("the server file pins the PC: it asks that server, not the one it was installed from", async () => {
      const installedFrom = await serve();
      const pinned = await serve();
      installedFrom.answer = upToDate();
      pinned.answer = upToDate();
      pointAt(installedFrom.base);
      await runUpdater();
      assert.equal(installedFrom.checks.length, 1);
      assert.equal(pinned.checks.length, 0);

      pointAt(`${pinned.base}/`, path.join(state, "server"));
      await runUpdater();
      assert.equal(installedFrom.checks.length, 1, "the installed-from server is not asked once the PC is pinned");
      assert.equal(pinned.checks.length, 1);
    });

    it("downloads the launcher from the server that told it to update", async () => {
      const installedFrom = await serve();
      const pinned = await serve();
      pinned.answer = updateToNew();
      installedFrom.launcher = Buffer.from("Write-Output 'wrong server'\r\n");
      pointAt(installedFrom.base);
      pointAt(pinned.base, path.join(state, "server"));
      await runUpdater();
      assert.equal(installedFrom.downloads, 0);
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
});
