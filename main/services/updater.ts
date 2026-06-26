// updater.ts — In-app self-update over git.
//
// The server runs from a git checkout (systemd/launchd/NSSM run `node --import
// tsx server.ts` from the repo root). This service:
//   - checks how far behind the upstream branch we are (`git fetch` + rev-list),
//   - applies an update by spawning a detached script that does
//     `git pull → npm ci → npm run build` and then kills this process, so the
//     service manager restarts it with the new build.
//
// Degrades gracefully when this isn't a git checkout (isGitRepo:false → the UI
// tells the operator to update from the CLI).

import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type { UpdateStatus } from "../types/stage.js";
import { getUserDataPath } from "./app-paths.js";
import { broadcast } from "./broadcaster.js";

const execFileAsync = promisify(execFile);

// main/services/updater.ts → repo root is two levels up.
const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..", "..");

const CHANGELOG_CAP = 20;

// Update tracks the operator may switch between in-app (git branches on origin).
// "main" = stable/production, "beta" = pre-release test track.
const TRACKS = ["main", "beta"];

function pkgVersion(): string {
  try {
    return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
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
    latestSha: null,
    latestDate: null,
    changelog: [],
    lastCheckedAt: null,
    phase: "idle",
    step: null,
    lastResult: null,
    error: null,
  };

  // While an apply runs, poll the progress/result files the detached script
  // writes so we can broadcast sub-phase progress (the server stays alive through
  // pull/install/build and is only killed at the very end).
  private progressTimer: ReturnType<typeof setInterval> | null = null;
  private applyStartedAt = 0;

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
      await this.git(["fetch", "--quiet", "origin", branch], 90_000);

      const currentSha = await this.git(["rev-parse", "--short", "HEAD"]);
      const currentDate = await this.git(["show", "-s", "--format=%cI", "HEAD"]);
      const upstream = `origin/${branch}`;
      const latestSha = await this.git(["rev-parse", "--short", upstream]);
      const latestDate = await this.git(["show", "-s", "--format=%cI", upstream]);
      const behindStr = await this.git(["rev-list", "--count", `HEAD..${upstream}`]);
      const behind = Number.parseInt(behindStr, 10) || 0;
      const changelog =
        behind > 0
          ? (await this.git(["log", "--format=%s", `HEAD..${upstream}`]))
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean)
              .slice(0, CHANGELOG_CAP)
          : [];

      this.status = {
        ...this.status,
        isGitRepo: true,
        branch,
        version: pkgVersion(),
        currentSha,
        currentDate,
        behind,
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

  get phase(): UpdateStatus["phase"] {
    return this.status.phase;
  }

  /**
   * Apply an update: validate, then spawn a detached script that pulls, installs,
   * builds, and (on success) kills this process so the service manager restarts
   * it with the new build. Returns immediately; progress arrives via SSE.
   */
  async applyUpdate(): Promise<UpdateStatus> {
    if (this.status.phase === "updating") throw new Error("An update is already running.");
    if (!this.status.isGitRepo) {
      // Re-check in case we never fetched.
      await this.checkForUpdate();
      if (!this.status.isGitRepo) throw new Error("Not a git checkout — update from the command line.");
    }
    const dirty = await this.git(["status", "--porcelain"]).catch(() => "");
    if (dirty) throw new Error("Working tree has uncommitted changes; resolve them before updating.");

    return this.launch(this.status.branch ?? "main", false);
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

    return this.launch(branch, true);
  }

  /** Spawn the detached update/switch script and enter the "updating" phase. */
  private launch(branch: string, checkout: boolean): UpdateStatus {
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
      // When set, the script checks out the branch (force-points it at origin)
      // before building — used for switching tracks, not a same-branch update.
      STAGE_UPDATE_CHECKOUT: checkout ? "1" : "",
      // So `npm`/`node` resolve under a service manager's minimal PATH.
      STAGE_UPDATE_NODE_DIR: path.dirname(process.execPath),
      STAGE_UPDATE_SERVER_PID: String(process.pid),
      STAGE_UPDATE_RESULT: this.resultFile(),
      STAGE_UPDATE_PROGRESS: this.progressFile(),
    };

    console.log(`[updater] ${checkout ? "switching to" : "applying update on"} ${branch} via ${script}`);
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
  private startProgressPolling(): void {
    if (this.progressTimer) clearInterval(this.progressTimer);
    this.progressTimer = setInterval(() => {
      if (this.status.phase !== "updating") {
        this.stopProgressPolling();
        return;
      }
      const result = this.readResult();
      if (result && Date.parse(result.finishedAt || "") >= this.applyStartedAt) {
        if (result.ok) {
          if (this.status.step !== "restarting") {
            this.status = { ...this.status, step: "restarting" };
            this.broadcast();
          }
        } else {
          // Failed apply — server lives on. Drop back to idle and show why.
          this.status = { ...this.status, phase: "idle", step: null };
          this.stopProgressPolling();
          this.broadcast();
        }
        return;
      }
      const step = this.readProgressStep();
      if (step && step !== this.status.step) {
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
