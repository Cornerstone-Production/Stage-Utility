// strategy.ts — how an update is applied, per install method.
//
// The app knows WHAT it wants (this track, this version, restart or defer) but
// not HOW to get it: a git checkout pulls and builds, a packaged install re-runs
// its installer, a Homebrew install asks brew. One interface, three answers.
//
// `plan()` returns what to spawn rather than spawning it. That is the whole
// reason these are testable — a test asserts argv and env without launching
// anything, and the single place that actually spawns lives in updater.ts.

import type { InstallKind } from "./install-kind.js";

export interface SpawnPlan {
  command: string;
  args: string[];
  env: Record<string, string>;
  /**
   * Where to run it. Omitted means the install root — right for a git checkout,
   * whose commands need the repository.
   *
   * A PACKAGED strategy must set this, because the install root is exactly what
   * the update replaces. `brew cleanup` deletes the old keg, which was the
   * script's own working directory, and from that moment every `brew` command
   * fails with "The current working directory must exist to run brew" — after
   * `bootout` has already unregistered the service. Observed on a real box
   * (v1.10.0-beta.29 -> .30): keg upgraded, label gone, nothing serving.
   */
  cwd?: string;
}

export interface ApplyOptions {
  /** Branch or release track: "main" or "beta". */
  track: string;
  /** True when switching tracks rather than updating on the current one. */
  checkout: boolean;
  /** Build everything but stop short of the restart, leaving a marker. */
  deferRestart: boolean;
  /** Pin an exact release, or null for the newest on the track. */
  version: string | null;
  /** Protocol vars: STAGE_UPDATE_PROGRESS, _RESULT, _LOG, _SERVER_PID, and so on. */
  env: Record<string, string>;
}

export interface UpdateStrategy {
  readonly kind: InstallKind;
  /**
   * Checked BEFORE anything is spawned.
   *
   * Spawning into the void is how the packaged-install bug behaved: the child was
   * detached with stdio ignored, so a missing script failed instantly and
   * silently, nothing was written to the progress or result file, and the UI sat
   * on "Downloading update..." forever with no way to learn it had failed.
   */
  canApply(): { ok: true } | { ok: false; reason: string };
  plan(options: ApplyOptions): SpawnPlan;
}
