// updater.ts — In-app self-update over git.
//
// The server runs from a git checkout (systemd/launchd/NSSM run `node --import
// tsx server.ts` from the repo root). This service:
//   - resolves the newest release tag on the track and checks whether we're on it,
//   - applies an update by spawning a detached script that does
//     `fetch → fast-forward to that tag → npm ci → npm run build` and then kills
//     this process, so the service manager restarts it with the new build.
//
// TAGS, NOT THE BRANCH TIP. The release workflow runs lint, type-check, tests and
// build before it tags, so a tag is verified code. The branch tip is whatever
// merged most recently — it may still be in CI, or may have failed it. Following
// the tip meant a red build could land on a stage display minutes after a merge.
//
// A track with no tags at all (a fork, or a branch that has never released) falls
// back to following the tip, so the updater never becomes a silent no-op.
//
// Degrades gracefully when this isn't a git checkout (isGitRepo:false → the UI
// tells the operator to update from the CLI).

import { execFile, spawn } from "node:child_process";

import { APP_ROOT } from "./app-root.js";
import { summarizeChangelog } from "./changelog.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";

import type { UpdateStatus } from "../types/stage.js";
import { getUserDataPath } from "./app-paths.js";
import { broadcast } from "./broadcaster.js";
import { latestOnTrack, newerThan } from "./release-tags.js";
import { appendUpdateLog, updateLogPath } from "./update-log.js";

const execFileAsync = promisify(execFile);

// main/services/updater.ts → repo root is two levels up.
const REPO_ROOT = APP_ROOT;

const CHANGELOG_CAP = 20;

// Update tracks the operator may switch between in-app (git branches on origin).
// "main" = stable/production, "beta" = pre-release test track.
const TRACKS = ["main", "beta"];

/**
 * The running version.
 *
 * A checkout carries package.json; a packaged install ships a VERSION file
 * instead, because the artifact contains no manifest. Without the second source a
 * packaged server reports 0.0.0 — which the UI shows, and which makes every
 * release look older than the one before it.
 */
function pkgVersion(): string {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")).version;
    if (v) return v;
  } catch {
    // no manifest — packaged install
  }
  try {
    const v = fs.readFileSync(path.join(REPO_ROOT, "VERSION"), "utf8").trim();
    if (v) return v;
  } catch {
    // neither — fall through
  }
  return "0.0.0";
}

class Updater {
  private status: UpdateStatus = {
    isGitRepo: false,
    branch: null,
    tracks: TRACKS,
    version: pkgVersion(),
    currentSha: null,
    currentDate: null,
    behind: 0,
    behindUserFacing: 0,
    latestSha: null,
    latestDate: null,
    changelog: [],
    lastCheckedAt: null,
    phase: "idle",
    step: null,
    restartPending: false,
    lastResult: null,
    error: null,
  };

  // While an apply runs, poll the progress/result files the detached script
  // writes so we can broadcast sub-phase progress (the server stays alive through
  // pull/install/build and is only killed at the very end).
  private liveLogOffset = 0;
  private progressTimer: ReturnType<typeof setInterval> | null = null;
  private applyStartedAt = 0;

  /** Log an update lifecycle event to stdout (captured live in the /log buffer)
   *  and to the persisted update.log (survives the post-update restart). */
  private logEvent(msg: string): void {
    console.log(`[updater] ${msg}`);
    appendUpdateLog(`[updater] ${msg}`);
  }

  /** Written by the update script when it applied a build but deliberately did
   *  NOT restart. Its presence is what makes "restart pending" survive polling. */
  private restartPendingFile(): string {
    return path.join(getUserDataPath(), "update-restart-pending");
  }

  private resultFile(): string {
    return path.join(getUserDataPath(), "update-result.json");
  }

  private progressFile(): string {
    return path.join(getUserDataPath(), "update-progress.json");
  }

  /** Read the detached updater's current step (written by scripts/update.*). */
  private readProgressStep(): UpdateStatus["step"] {
    try {
      const r = JSON.parse(fs.readFileSync(this.progressFile(), "utf8")) as { step?: string };
      const s = r.step;
      if (s === "pull" || s === "install" || s === "build" || s === "restarting") return s;
      return null;
    } catch {
      return null;
    }
  }

  private async git(args: string[], timeoutMs = 60_000): Promise<string> {
    const { stdout } = await execFileAsync("git", args, { cwd: REPO_ROOT, timeout: timeoutMs });
    return stdout.trim();
  }

  /** Read the detached updater's last result file (written by scripts/update.*). */
  private readResult(): UpdateStatus["lastResult"] {
    try {
      const raw = fs.readFileSync(this.resultFile(), "utf8");
      const r = JSON.parse(raw) as { ok?: boolean; finishedAt?: string; log?: string };
      if (typeof r.ok !== "boolean") return null;
      return { ok: r.ok, finishedAt: r.finishedAt ?? "", log: r.log ?? null };
    } catch {
      return null;
    }
  }

  /** Cached status (no network). Refreshes the local bits (sha, result file). */
  getStatus(): UpdateStatus {
    return {
      ...this.status,
      version: pkgVersion(),
      step: this.status.phase === "updating" ? this.status.step : null,
      restartPending: this.isRestartPending(),
      lastResult: this.readResult(),
    };
  }

  /** Fetch upstream and recompute how far behind we are. Network-touching. */
  async checkForUpdate(): Promise<UpdateStatus> {
    // Don't stomp an in-flight apply.
    if (this.status.phase === "updating") return this.getStatus();
    this.status.phase = "checking";
    this.status.error = null;
    try {
      // Is this a git checkout at all?
      const inside = await this.git(["rev-parse", "--is-inside-work-tree"]).catch(() => "false");
      if (inside !== "true") {
        this.status = { ...this.status, isGitRepo: false, phase: "idle", lastCheckedAt: new Date().toISOString() };
        this.broadcast();
        return this.getStatus();
      }

      const branch = await this.git(["rev-parse", "--abbrev-ref", "HEAD"]);
      // --tags so a box that has never seen them gets the full set; --force so a
      // retagged release (rare, but it happens) doesn't wedge the fetch.
      await this.git(["fetch", "--quiet", "--tags", "--force", "origin", branch], 90_000);

      const currentSha = await this.git(["rev-parse", "--short", "HEAD"]);
      const currentDate = await this.git(["show", "-s", "--format=%cI", "HEAD"]);
      const upstream = `origin/${branch}`;

      // Only tags actually reachable from this track. A tag cut on main is not a
      // candidate for a beta box until it lands in beta's history.
      const tags = (
        await this.git(["tag", "--list", "v[0-9]*", "--merged", upstream]).catch(() => "")
      )
        .split("\n")
        .map((t) => t.trim())
        .filter(Boolean);

      const target = latestOnTrack(tags, branch);
      const tagBased = target !== null;

      // The newest tag at or behind HEAD — what this box is actually running.
      const currentTag = tagBased
        ? (await this.git(["describe", "--tags", "--abbrev=0", "--match", "v[0-9]*", "HEAD"]).catch(
            () => "",
          )) || null
        : null;

      // No tags on this track (a fork, or a branch that has never released) →
      // follow the tip, exactly as before, rather than reporting "up to date"
      // forever.
      const targetRef = target ? target.tag : upstream;
      const latestSha = await this.git(["rev-parse", "--short", targetRef]);
      const latestDate = await this.git(["show", "-s", "--format=%cI", targetRef]);
      const behindStr = await this.git(["rev-list", "--count", `HEAD..${targetRef}`]).catch(() => "0");
      const behind = Number.parseInt(behindStr, 10) || 0;

      const releasesBehind = tagBased ? newerThan(tags, branch, currentTag).length : 0;

      // Merged but not yet released: non-zero while a release build runs, and
      // stays non-zero when one fails — the signal that a track is stalled rather
      // than quiet.
      //
      // Curated the same way the changelog is, because a `ci:` or `docs:` commit
      // deliberately produces no release. Counting raw commits would leave a box
      // permanently reporting work as "waiting to be released" when nothing is
      // ever coming, which is exactly the false alarm this line exists to avoid.
      const unreleasedCommits = tagBased
        ? summarizeChangelog(
            (await this.git(["log", "--format=%s", `${targetRef}..${upstream}`]).catch(() => "")).split("\n"),
          ).length
        : 0;
      // Curated, not raw: see changelog.ts for why the release workflow's own
      // version bump and the merge commits are not news.
      // Two different counts, and the difference matters. `behind` is the literal
      // git distance. `behindUserFacing` is how much of it an operator would notice.
      //
      // The release workflow pushes its own `chore(release): vX.Y.Z` commit AFTER
      // the merge that triggered it, so every merge leaves exactly one of these
      // trailing behind a box that has already updated. Reporting that as "1 update
      // available" trains people to ignore the banner, which is the opposite of what
      // it is for.
      // Scoped to the target, not the tip: commits still awaiting release are not
      // news to an operator, because Update will not bring them.
      const pending =
        behind > 0
          ? summarizeChangelog((await this.git(["log", "--format=%s", `HEAD..${targetRef}`])).split("\n"))
          : [];
      const behindUserFacing = pending.length;
      const changelog = pending.slice(0, CHANGELOG_CAP);

      this.status = {
        ...this.status,
        isGitRepo: true,
        branch,
        version: pkgVersion(),
        currentSha,
        currentDate,
        behind,
        behindUserFacing,
        currentTag,
        targetTag: target?.tag ?? null,
        releasesBehind,
        unreleasedCommits,
        tagBased,
        latestSha,
        latestDate,
        changelog,
        lastCheckedAt: new Date().toISOString(),
        phase: "idle",
        error: null,
      };
    } catch (err) {
      this.status = {
        ...this.status,
        phase: "idle",
        lastCheckedAt: new Date().toISOString(),
        error: String(err instanceof Error ? err.message : err),
      };
    }
    this.broadcast();
    return this.getStatus();
  }

  get behind(): number {
    return this.status.behind;
  }

  /** True when a build is installed but this process is still the old code. */
  private isRestartPending(): boolean {
    try {
      return fs.existsSync(this.restartPendingFile());
    } catch {
      return false;
    }
  }

  get phase(): UpdateStatus["phase"] {
    return this.status.phase;
  }

  /**
   * Apply an update: validate, then spawn a detached script that pulls, installs,
   * builds, and (on success) kills this process so the service manager restarts
   * it with the new build. Returns immediately; progress arrives via SSE.
   */
  async applyUpdate(opts: { deferRestart?: boolean } = {}): Promise<UpdateStatus> {
    if (this.status.phase === "updating") throw new Error("An update is already running.");
    if (!this.status.isGitRepo) {
      // Re-check in case we never fetched.
      await this.checkForUpdate();
      if (!this.status.isGitRepo) throw new Error("Not a git checkout — update from the command line.");
    }
    const dirty = await this.git(["status", "--porcelain"]).catch(() => "");
    if (dirty) throw new Error("Working tree has uncommitted changes; resolve them before updating.");

    const branch = this.status.branch ?? "main";
    return this.launch(branch, false, opts.deferRestart === true, this.status.targetTag ?? null);
  }

  /**
   * The newest release tag on a track we may not be standing on.
   *
   * Track-switching has to fetch the other branch before it can see its tags.
   * Resolved here rather than in the update script so that both paths order
   * versions through the same tested comparator — a shell `sort` would rank a
   * prerelease above its own release. Null means the track has no tags and the
   * script should follow its tip.
   */
  private async targetTagFor(branch: string): Promise<string | null> {
    try {
      await this.git(["fetch", "--quiet", "--tags", "--force", "origin", branch], 90_000);
      const tags = (await this.git(["tag", "--list", "v[0-9]*", "--merged", `origin/${branch}`]))
        .split("\n")
        .map((t) => t.trim())
        .filter(Boolean);
      return latestOnTrack(tags, branch)?.tag ?? null;
    } catch {
      return null; // offline or no such branch — the script surfaces the failure
    }
  }

  /**
   * Switch update tracks (e.g. main ↔ beta) and apply: checks out the target
   * branch (force-pointing it at origin/<branch>), then installs/builds/restarts.
   * Same machinery as applyUpdate but with the checkout step enabled.
   */
  async switchTrack(branch: string): Promise<UpdateStatus> {
    if (!TRACKS.includes(branch)) throw new Error(`Unknown update track: ${branch}`);
    if (this.status.phase === "updating") throw new Error("An update is already running.");
    if (!this.status.isGitRepo) {
      await this.checkForUpdate();
      if (!this.status.isGitRepo) throw new Error("Not a git checkout — switch tracks from the command line.");
    }
    if (branch === this.status.branch) {
      // Already on this track — just run a normal update so it's not a no-op.
      return this.applyUpdate();
    }
    const dirty = await this.git(["status", "--porcelain"]).catch(() => "");
    if (dirty) throw new Error("Working tree has uncommitted changes; resolve them before switching tracks.");

    return this.launch(branch, true, false, await this.targetTagFor(branch));
  }

  /**
   * Restart the server process (no git needed). Relies on the service manager
   * (systemd/launchd/NSSM) to relaunch it — the same mechanism the post-update
   * kill depends on. Flags "restarting" so the UI shows the reload step, then
   * exits after the HTTP response has flushed.
   */
  restart(): UpdateStatus {
    // Taking the restart resolves the pending state; clear it before we exit so a
    // relaunch does not come up still claiming an update is waiting.
    try {
      fs.rmSync(this.restartPendingFile(), { force: true });
    } catch {
      /* best-effort */
    }
    if (this.status.phase === "updating") throw new Error("An update is already running.");
    console.log("[updater] manual restart requested — exiting for the service manager to relaunch");
    this.status = { ...this.status, phase: "updating", step: "restarting" };
    this.broadcast();
    setTimeout(() => process.exit(0), 600);
    return this.getStatus();
  }

  /** Spawn the detached update/switch script and enter the "updating" phase. */
  private launch(branch: string, checkout: boolean, deferRestart: boolean, tag: string | null): UpdateStatus {
    const isWin = process.platform === "win32";
    const script = path.join(REPO_ROOT, "scripts", isWin ? "update.ps1" : "update.sh");

    // Clear stale progress/result so the poller only reacts to this run.
    this.applyStartedAt = Date.now();
    try {
      fs.writeFileSync(this.progressFile(), JSON.stringify({ step: "pull", at: new Date().toISOString() }));
    } catch {
      /* best-effort */
    }
    try {
      fs.rmSync(this.resultFile(), { force: true });
    } catch {
      /* best-effort */
    }

    const env = {
      ...process.env,
      STAGE_UPDATE_REPO: REPO_ROOT,
      STAGE_UPDATE_BRANCH: branch,
      // The verified release to land on. Empty means the track has no tags, and
      // the script follows the branch tip instead.
      STAGE_UPDATE_TAG: tag ?? "",
      // When set, the script checks out the branch (force-points it at origin)
      // before building — used for switching tracks, not a same-branch update.
      STAGE_UPDATE_CHECKOUT: checkout ? "1" : "",
      // auto-install: build everything, then stop short of the kill and leave a
      // marker, so the operator chooses when the displays go dark.
      STAGE_UPDATE_DEFER_RESTART: deferRestart ? "1" : "",
      STAGE_UPDATE_RESTART_PENDING: this.restartPendingFile(),
      // So `npm`/`node` resolve under a service manager's minimal PATH.
      STAGE_UPDATE_NODE_DIR: path.dirname(process.execPath),
      STAGE_UPDATE_SERVER_PID: String(process.pid),
      STAGE_UPDATE_RESULT: this.resultFile(),
      STAGE_UPDATE_PROGRESS: this.progressFile(),
      STAGE_UPDATE_LOG: updateLogPath(),
      // Where the script writes its live output. Tailed below so /log narrates the
      // update as it happens, instead of only summarising once it is over.
      STAGE_UPDATE_LIVE_LOG: this.liveLogFile(),
    };
    try {
      fs.writeFileSync(this.liveLogFile(), ""); // start each run from empty
    } catch {
      /* best effort */
    }
    this.liveLogOffset = 0;

    this.logEvent(
      `${checkout ? "switching to" : "applying update on"} ${branch} — ` +
        `${this.status.currentTag ?? this.status.currentSha ?? "?"} -> ${tag ?? this.status.latestSha ?? "tip"}` +
        ` (${this.status.behind} commit${this.status.behind === 1 ? "" : "s"})`,
    );
    const child = isWin
      ? spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], {
          cwd: REPO_ROOT,
          detached: true,
          stdio: "ignore",
          env,
          windowsHide: true,
        })
      : spawn("bash", [script], { cwd: REPO_ROOT, detached: true, stdio: "ignore", env });
    child.unref();

    this.status = { ...this.status, phase: "updating", step: "pull" };
    this.startProgressPolling();
    this.broadcast();
    return this.getStatus();
  }

  /**
   * While an apply runs, watch the script's progress/result files (~1s) and
   * broadcast sub-phase changes:
   *   - progress file advances pull → install → build → (restarting) → broadcast.
   *   - a result file newer than applyStartedAt with ok=false means the build
   *     failed and the server was NOT killed: return to idle + surface the error.
   *   - ok=true means success is imminent (the script sleeps briefly, then kills
   *     us); flag "restarting" so the UI shows the final step before the socket
   *     drops and the service manager relaunches with the new build.
   */
  private liveLogFile(): string {
    return path.join(getUserDataPath(), "update-live.log");
  }

  /**
   * Surface new lines from the running script's log.
   *
   * The script narrates itself — the commit range and subjects it pulled, how many
   * files changed, whether the reinstall and rebuild are needed or skipped, and
   * npm/vite's own output. All of that used to sit in a temp file until the run
   * finished, so the only thing visible while an update ran was "step: install".
   *
   * Only the script's own `[update]` narration is forwarded; npm and vite's raw
   * output stays in update.log rather than flooding /log with progress bars.
   */
  private drainLiveLog(): void {
    let text: string;
    try {
      text = fs.readFileSync(this.liveLogFile(), "utf8");
    } catch {
      return; // not created yet
    }
    if (text.length <= this.liveLogOffset) return;
    const fresh = text.slice(this.liveLogOffset);
    this.liveLogOffset = text.length;
    for (const raw of fresh.split("\n")) {
      const line = raw.trimEnd();
      if (!line.startsWith("[update]")) continue;
      this.logEvent(line.replace(/^\[update\]\s?/, ""));
    }
  }

  private startProgressPolling(): void {
    if (this.progressTimer) clearInterval(this.progressTimer);
    this.progressTimer = setInterval(() => {
      if (this.status.phase !== "updating") {
        this.stopProgressPolling();
        return;
      }
      const result = this.readResult();
      if (result && Date.parse(result.finishedAt || "") >= this.applyStartedAt) {
        this.drainLiveLog();
        if (result.ok) {
          if (this.status.step !== "restarting") {
            this.logEvent("build succeeded — restarting into the new version");
            this.status = { ...this.status, step: "restarting" };
            this.broadcast();
          }
        } else {
          // Failed apply — server lives on. Drop back to idle and show why.
          this.logEvent(`update FAILED — server left running on the current version${result.log ? ` (see update.log)` : ""}`);
          this.status = { ...this.status, phase: "idle", step: null };
          this.stopProgressPolling();
          this.broadcast();
        }
        return;
      }
      this.drainLiveLog();
      const step = this.readProgressStep();
      if (step && step !== this.status.step) {
        this.logEvent(`step: ${step}`);
        this.status = { ...this.status, step };
        this.broadcast();
      }
    }, 1000);
    // Don't keep the event loop alive solely for this timer.
    this.progressTimer.unref?.();
  }

  private stopProgressPolling(): void {
    if (this.progressTimer) {
      clearInterval(this.progressTimer);
      this.progressTimer = null;
    }
  }

  private broadcast(): void {
    broadcast("update:status", this.getStatus());
  }
}

export const updater = new Updater();
