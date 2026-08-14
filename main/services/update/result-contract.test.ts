import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// The result file is the ONLY thing that tells the UI an apply is over, and four
// different programs write it: scripts/update.sh (git), install.sh (tarball),
// install.ps1 (Windows tarball) and homebrew-strategy.ts (brew).
//
// Three of the four wrote {ok,error,at} while updater.ts readResult() reads
// {ok,finishedAt,log}. The poller's test is
//
//     Date.parse(result.finishedAt || "") >= this.applyStartedAt
//
// and Date.parse("") is NaN, so a NaN comparison is false and every result those
// three wrote was discarded. A Homebrew update in the window before the tap
// regenerates writes ok:false with the reason and deliberately restarts nothing;
// the operator saw "Downloading update…" for the full ten-minute watchdog and
// then a fabricated stall, for a run that had finished cleanly and said why.
//
// Guarding by grepping the source would have been satisfied by a comment — and
// install.sh carried one claiming "the format matches scripts/update.sh exactly"
// while it did not. So each writer is RUN here and its output pushed through the
// same predicate the poller uses.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..", "..", "..");

/** updater.ts readResult() + the startProgressPolling() match test, verbatim. */
function pollerAccepts(raw: string, applyStartedAt: number): boolean {
  const r = JSON.parse(raw) as { ok?: boolean; finishedAt?: string; log?: string };
  if (typeof r.ok !== "boolean") return false;
  const result = { ok: r.ok, finishedAt: r.finishedAt ?? "", log: r.log ?? null };
  return Date.parse(result.finishedAt || "") >= applyStartedAt;
}

function tmpResultPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "stage-result-")), "result.json");
}

describe("update result-file contract", () => {
  it("install.sh writes a result the poller accepts, and carries the reason", () => {
    const out = tmpResultPath();
    // Drive the REAL script down its failure path: swap mode against a prefix it
    // cannot write reaches the precondition and calls die() -> write_result.
    const startedAt = Date.now() - 1000;
    assert.throws(
      () =>
        execFileSync("bash", [path.join(REPO, "install.sh")], {
          env: {
            ...process.env,
            STAGE_UPDATE_MODE: "swap",
            STAGE_PREFIX: "/nonexistent-stage-utility-prefix",
            STAGE_UPDATE_RESULT: out,
          },
          stdio: "pipe",
        }),
      "the installer must fail when it cannot write the prefix",
    );

    const raw = fs.readFileSync(out, "utf8");
    assert.ok(pollerAccepts(raw, startedAt), `poller rejected install.sh's result: ${raw}`);
    const parsed = JSON.parse(raw) as { ok: boolean; log: string };
    assert.equal(parsed.ok, false);
    // The reason must survive into `log`, or the UI reports a failure with no cause.
    assert.match(parsed.log, /Cannot write/, "the failure reason must reach the operator");
  });

  it("the Homebrew strategy writes a result the poller accepts", async () => {
    const { HomebrewStrategy } = await import("./homebrew-strategy.js");
    const out = tmpResultPath();
    const startedAt = Date.now() - 1000;
    const plan = new HomebrewStrategy().plan({
      track: "beta",
      checkout: false,
      deferRestart: false,
      version: "1.10.0",
      env: {},
    });
    // The no-op branch's writeResult is inside the generated script. Run just the
    // writer by driving the script's own printf through bash with the env set.
    const script = plan.args[plan.args.length - 1];
    const writer = script
      .split("\n")
      .join(" ")
      .match(/if \[ -n "\$STAGE_UPDATE_RESULT" \]; then printf [^;]+; fi/);
    assert.ok(writer, "could not find the result writer in the generated script");
    execFileSync("bash", ["-c", writer[0]], {
      env: { ...process.env, STAGE_UPDATE_RESULT: out },
      stdio: "pipe",
    });

    const raw = fs.readFileSync(out, "utf8");
    assert.ok(pollerAccepts(raw, startedAt), `poller rejected the brew result: ${raw}`);
  });

  it("scripts/update.sh writes a result the poller accepts", () => {
    const out = tmpResultPath();
    const log = path.join(path.dirname(out), "update.log");
    fs.writeFileSync(log, "some update output\n");
    const startedAt = Date.now() - 1000;
    // update.sh's writer is a self-contained node -e; run it the way the script does.
    const src = fs.readFileSync(path.join(REPO, "scripts", "update.sh"), "utf8");
    const nodeExpr = src.match(/node -e '([^']+)'/);
    assert.ok(nodeExpr, "could not find update.sh's result writer");
    execFileSync("node", ["-e", nodeExpr[1], "true", out, log], { stdio: "pipe" });

    const raw = fs.readFileSync(out, "utf8");
    assert.ok(pollerAccepts(raw, startedAt), `poller rejected update.sh's result: ${raw}`);
  });

  it("install.ps1 declares the same keys", () => {
    // PowerShell is not available on the CI runners, so this one is a source
    // check — scoped to the Write-UpdateResult body and matched against the
    // emitted line, not a prose mention. Scoping matters: the PROGRESS file is a
    // different contract that legitimately still writes {step,at}, and asserting
    // over the whole file caught that instead.
    const ps = fs.readFileSync(path.join(REPO, "install.ps1"), "utf8");
    const body = ps.match(/function Write-UpdateResult[\s\S]*?\n}/);
    assert.ok(body, "could not find Write-UpdateResult in install.ps1");
    assert.match(body[0], /`"ok`":\$b,`"finishedAt`":`"\$finishedAt`",`"log`":`"\$e`"/, "install.ps1 must write ok/finishedAt/log");
    assert.doesNotMatch(body[0], /`"error`":|`"at`":/, "the old {ok,error,at} shape must be gone");
  });
});

describe("the installer records which track it was asked for", () => {
  // `beta` deliberately takes stable releases too — a release outranks the
  // prereleases that led to it — so a beta box lands on a hyphen-less version
  // as a matter of course. detect-track infers the track from that version
  // string when nothing else says otherwise, and the inference then reads
  // "main" and never offers another beta.
  //
  // updater.ts writes this record on every in-app apply, but install.sh never
  // did. So `STAGE_TRACK=beta` plus a fresh install landed on stable with no
  // record: the operator asked for beta and quietly got main.
  //
  // Driven through the REAL script. curl/tar/sha256sum are stubbed on PATH so
  // the download, verify and unpack all succeed offline — the record is written
  // after those, deliberately, so that a failed install never relabels the track
  // of a working one. A source check would not have caught that ordering.
  it("writes the track into the data directory, where it outlives every release", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stage-track-"));
    const data = path.join(dir, "data");
    const prefix = path.join(dir, "prefix");
    const bin = path.join(dir, "bin");
    fs.mkdirSync(prefix, { recursive: true });
    fs.mkdirSync(bin, { recursive: true });

    const DIGEST = "0".repeat(64);
    const stub = (name: string, body: string) => {
      const f = path.join(bin, name);
      fs.writeFileSync(f, `#!/usr/bin/env bash\n${body}\n`);
      fs.chmodSync(f, 0o755);
    };
    // -o means "download the archive"; anything else is the releases API call,
    // which must name the archive and carry its digest.
    stub(
      "curl",
      `out=""
       for ((i=1; i<=$#; i++)); do if [ "\${!i}" = "-o" ]; then j=$((i+1)); out="\${!j}"; fi; done
       if [ -n "$out" ]; then printf 'archive' > "$out"; exit 0; fi
       printf '{\\n "assets": [\\n  {\\n   "name": "%s",\\n   "digest": "sha256:%s"\\n  }\\n ]\\n}\\n' "stage-utility-9.9.9-\${STAGE_TEST_PLATFORM}.tar.gz" "${DIGEST}"`,
    );
    stub("sha256sum", `printf '${DIGEST}  -\n'`);
    // Unpack = produce the runtime the script insists on before switching.
    stub("tar", `d=""; for ((i=1; i<=$#; i++)); do if [ "\${!i}" = "-C" ]; then j=$((i+1)); d="\${!j}"; fi; done
       mkdir -p "$d"; printf '#!/bin/sh\\n' > "$d/node"; chmod +x "$d/node"`);

    const arch = process.arch === "arm64" ? "arm64" : "x64";
    const platform = `${process.platform === "darwin" ? "darwin" : "linux"}-${arch}`;

    execFileSync("bash", [path.join(REPO, "install.sh")], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        STAGE_TEST_PLATFORM: platform,
        STAGE_UPDATE_MODE: "swap",
        STAGE_TRACK: "beta",
        STAGE_PREFIX: prefix,
        STAGE_DATA: data,
        STAGE_VERSION: "v9.9.9",
      },
      stdio: "pipe",
    });

    const record = path.join(data, "update-track");
    assert.ok(fs.existsSync(record), "the installer must record the track it was given");
    assert.equal(fs.readFileSync(record, "utf8").trim(), "beta");
  });
});
