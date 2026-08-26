# Universal In-App Updates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Update and switch tracks from Settings → Advanced on every install method — Homebrew, the one-line installers, and a git checkout.

**Architecture:** One `UpdateStrategy` interface with three implementations, chosen by a declared install kind. All three emit the *existing* progress/result file protocol, so `updater.ts`'s poller and the whole renderer are untouched. Every strategy stages and swaps **while the server keeps serving**, then signals it to exit as the final action — the ordering `update.sh` already uses. Nothing stops the service before its work is done, so there is no cgroup teardown to escape.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node built-in test runner via `tsx --test`, bash + PowerShell installers, GitHub Actions.

## Global Constraints

- Node ≥ 24. TypeScript strict. Imports use `.js` specifiers even for `.ts` sources.
- No new runtime dependencies. Use `node:` builtins only.
- Never use emojis in code, UI, comments, or commit messages.
- Every strategy MUST validate it can run *before* starting, and MUST write a result file on failure. The UI must always be able to leave the "updating" phase.
- No strategy may stop the service before its work is finished. Stage, swap, then signal the pid as the last action. Downtime is one restart, never the length of the update. **One documented exception:** a Homebrew *track switch* is inherently uninstall-then-install. That path is macOS-only, where a detached child was verified to survive `launchctl bootout` (2026-08-02). It does not license a stop-first path anywhere else.
- The progress/result protocol is fixed and MUST NOT change: `STAGE_UPDATE_PROGRESS` receives `{"step":"<step>","at":"<iso>"}`; `STAGE_UPDATE_RESULT` receives `{"ok":<bool>,"error":"<string>","at":"<iso>"}`. Steps are `pull`, `install`, `build`, `restarting`.
- A declared `STAGE_UTILITY_INSTALL_KIND` always beats inference.
- Inference is used ONLY to select a strategy, never to decide where to write.
- Run `npm run type-check && npm run lint && npm test` before every commit.
- Commit messages are Conventional Commits. No Claude attribution, no session links.
- Work on branch `feat/universal-updates`, off `beta`.

---

### Task 1: Install-kind detection

**Files:**
- Create: `main/services/update/install-kind.ts`
- Test: `main/services/update/install-kind.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type InstallKind = "git" | "tarball" | "homebrew" | "unknown"` and `function detectInstallKind(env: NodeJS.ProcessEnv, appRoot: string, exists: (p: string) => boolean): InstallKind`.

Dependencies are injected (`env`, `appRoot`, `exists`) so the tests need no real filesystem.

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectInstallKind } from "./install-kind.js";

const noFiles = () => false;

describe("detectInstallKind", () => {
  it("prefers a declared kind over anything inferable", () => {
    const env = { STAGE_UTILITY_INSTALL_KIND: "homebrew" } as NodeJS.ProcessEnv;
    assert.equal(detectInstallKind(env, "/opt/stage-utility", noFiles), "homebrew");
  });

  it("rejects a declared kind that is not a known value", () => {
    const env = { STAGE_UTILITY_INSTALL_KIND: "nonsense" } as NodeJS.ProcessEnv;
    assert.equal(detectInstallKind(env, "/srv/app", noFiles), "unknown");
  });

  it("calls a checkout with a .git directory git", () => {
    const exists = (p: string) => p === "/srv/app/.git";
    assert.equal(detectInstallKind({}, "/srv/app", exists), "git");
  });

  it("infers homebrew from a Cellar path when nothing is declared", () => {
    const root = "/opt/homebrew/Cellar/stage-utility/1.9.5/libexec";
    assert.equal(detectInstallKind({}, root, noFiles), "homebrew");
  });

  it("infers tarball from each documented install prefix", () => {
    assert.equal(detectInstallKind({}, "/opt/stage-utility", noFiles), "tarball");
    assert.equal(detectInstallKind({}, "/usr/local/stage-utility", noFiles), "tarball");
    assert.equal(detectInstallKind({}, "C:\\Program Files\\Stage Utility", noFiles), "tarball");
  });

  it("detects a Windows install in a subdirectory of the prefix", () => {
    // install.ps1 creates releases\<version> and a `current` junction, so the
    // real appRoot is BELOW the prefix and joined with a backslash.
    const root = "C:\\Program Files\\Stage Utility\\current";
    assert.equal(detectInstallKind({}, root, noFiles), "tarball");
  });

  it("prefers git over path inference when a checkout sits under a known prefix", () => {
    const exists = (p: string) => p === "/opt/stage-utility/.git";
    assert.equal(detectInstallKind({}, "/opt/stage-utility", exists), "git");
  });

  it("does not treat a mere substring of a prefix as an install", () => {
    assert.equal(detectInstallKind({}, "/opt/stage-utility-other", noFiles), "unknown");
  });

  it("returns unknown for an unrecognised location", () => {
    assert.equal(detectInstallKind({}, "/home/someone/scratch", noFiles), "unknown");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx --test main/services/update/install-kind.test.ts`
Expected: FAIL — cannot find module `./install-kind.js`.

- [ ] **Step 3: Implement**

```ts
// install-kind.ts — how this copy of the server was installed.
//
// Declared by the packaged launchers rather than guessed, because a wrong guess
// writes to the wrong place. Inference exists only for installs that predate the
// launcher change: it picks a STRATEGY and never decides a path.

export type InstallKind = "git" | "tarball" | "homebrew" | "unknown";

const DECLARED: readonly InstallKind[] = ["git", "tarball", "homebrew"];

/** Exactly the prefixes install.sh and install.ps1 write to. */
const TARBALL_PREFIXES = [
  "/opt/stage-utility",
  "/usr/local/stage-utility",
  "C:\\Program Files\\Stage Utility",
];

/**
 * Is `appRoot` the prefix itself, or something beneath it?
 *
 * Both separators are accepted because the Windows prefix is backslash-joined
 * and a real install root is a SUBDIRECTORY of it (install.ps1 creates
 * releases\<version> plus a `current` junction). Matching only on "/" made every
 * real Windows path fall through to "unknown".
 *
 * The segment boundary is load-bearing: a bare startsWith would make
 * "/opt/stage-utility-other" look like a tarball install.
 */
function isUnder(appRoot: string, prefix: string): boolean {
  if (appRoot === prefix) return true;
  return appRoot.startsWith(`${prefix}/`) || appRoot.startsWith(`${prefix}\\`);
}

export function detectInstallKind(
  env: NodeJS.ProcessEnv,
  appRoot: string,
  exists: (p: string) => boolean,
): InstallKind {
  const declared = env.STAGE_UTILITY_INSTALL_KIND?.trim();
  if (declared) {
    return (DECLARED as readonly string[]).includes(declared)
      ? (declared as InstallKind)
      : "unknown";
  }
  if (exists(`${appRoot}/.git`)) return "git";
  if (appRoot.includes("/Cellar/stage-utility/")) return "homebrew";
  if (TARBALL_PREFIXES.some((p) => isUnder(appRoot, p))) return "tarball";
  return "unknown";
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx tsx --test main/services/update/install-kind.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add main/services/update/install-kind.ts main/services/update/install-kind.test.ts
git commit -m "feat(update): detect how the server was installed"
```

---

### Task 2: Strategy interface, and today's git behaviour behind it

**Files:**
- Create: `main/services/update/strategy.ts`
- Create: `main/services/update/git-strategy.ts`
- Test: `main/services/update/git-strategy.test.ts`

**Interfaces:**
- Consumes: `InstallKind` from Task 1.
- Produces:
  - `interface SpawnPlan { command: string; args: string[]; env: Record<string, string> }`
  - `interface UpdateStrategy { readonly kind: InstallKind; canApply(): { ok: true } | { ok: false; reason: string }; plan(o: ApplyOptions): SpawnPlan }`
  - `interface ApplyOptions { track: string; checkout: boolean; deferRestart: boolean; version: string | null; env: Record<string, string> }`
  - `class GitStrategy implements UpdateStrategy` with `constructor(appRoot: string, exists?: (p: string) => boolean)`

`plan()` returns *what to spawn* rather than spawning. That is the whole reason these are testable: a test asserts argv and env without launching anything.

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitStrategy } from "./git-strategy.js";

const all = () => true;

describe("GitStrategy", () => {
  it("refuses when the update script is missing", () => {
    const s = new GitStrategy("/srv/app", (p) => !p.endsWith("update.sh"));
    const r = s.canApply();
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /update\.sh/);
  });

  it("refuses when there is no checkout", () => {
    const s = new GitStrategy("/srv/app", (p) => !p.endsWith(".git"));
    assert.equal(s.canApply().ok, false);
  });

  it("plans a bash spawn of the repo's update script", () => {
    const s = new GitStrategy("/srv/app", all);
    const plan = s.plan({ track: "beta", checkout: true, deferRestart: false, version: null, env: {} });
    assert.equal(plan.command, "bash");
    assert.deepEqual(plan.args, ["/srv/app/scripts/update.sh"]);
  });

  it("passes the checkout flag through only when switching tracks", () => {
    const s = new GitStrategy("/srv/app", all);
    const on = s.plan({ track: "beta", checkout: true, deferRestart: false, version: null, env: {} });
    const off = s.plan({ track: "beta", checkout: false, deferRestart: false, version: null, env: {} });
    assert.equal(on.env.STAGE_UPDATE_CHECKOUT, "1");
    assert.equal(off.env.STAGE_UPDATE_CHECKOUT, "");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx --test main/services/update/git-strategy.test.ts`
Expected: FAIL — cannot find module `./git-strategy.js`.

- [ ] **Step 3: Implement both files**

```ts
// strategy.ts
import type { InstallKind } from "./install-kind.js";

export interface SpawnPlan {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface ApplyOptions {
  track: string;
  checkout: boolean;
  deferRestart: boolean;
  version: string | null;
  /** Protocol vars (STAGE_UPDATE_PROGRESS, _RESULT, _LOG, _SERVER_PID, ...). */
  env: Record<string, string>;
}

export interface UpdateStrategy {
  readonly kind: InstallKind;
  /** Checked BEFORE anything is spawned. Never spawn into the void. */
  canApply(): { ok: true } | { ok: false; reason: string };
  plan(options: ApplyOptions): SpawnPlan;
}
```

```ts
// git-strategy.ts — today's behaviour, unchanged, behind the interface.
import * as fs from "node:fs";
import * as path from "node:path";
import type { InstallKind } from "./install-kind.js";
import type { ApplyOptions, SpawnPlan, UpdateStrategy } from "./strategy.js";

export class GitStrategy implements UpdateStrategy {
  readonly kind: InstallKind = "git";
  constructor(
    private readonly appRoot: string,
    private readonly exists: (p: string) => boolean = fs.existsSync,
  ) {}

  private script(): string {
    const name = process.platform === "win32" ? "update.ps1" : "update.sh";
    return path.join(this.appRoot, "scripts", name);
  }

  canApply(): { ok: true } | { ok: false; reason: string } {
    if (!this.exists(this.script())) {
      return { ok: false, reason: `No update script at ${this.script()}.` };
    }
    if (!this.exists(path.join(this.appRoot, ".git"))) {
      return { ok: false, reason: "This is not a git checkout." };
    }
    return { ok: true };
  }

  plan(o: ApplyOptions): SpawnPlan {
    const env = {
      ...o.env,
      STAGE_UPDATE_BRANCH: o.track,
      STAGE_UPDATE_CHECKOUT: o.checkout ? "1" : "",
      STAGE_UPDATE_DEFER_RESTART: o.deferRestart ? "1" : "",
      ...(o.version ? { STAGE_UPDATE_TAG: o.version } : {}),
    };
    // update.ps1 is PowerShell, not bash. The pre-refactor updater branched on
    // platform here and losing that would break Windows checkouts silently.
    if (process.platform === "win32") {
      return {
        command: "powershell.exe",
        args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", this.script()],
        env,
      };
    }
    return { command: "bash", args: [this.script()], env };
  }
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx tsx --test main/services/update/git-strategy.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add main/services/update/strategy.ts main/services/update/git-strategy.ts main/services/update/git-strategy.test.ts
git commit -m "refactor(update): put the git update path behind a strategy interface"
```

---

### Task 3: Installer gains swap mode, and reports progress

**Files:**
- Modify: `install.sh` (protocol helpers, `STAGE_UPDATE_MODE=swap` branch)
- Modify: `install.ps1` (same)
- Test: `scripts/survival/run-swap-linux.sh` (added in Task 8; this task only produces the behaviour it exercises)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `install.sh` / `install.ps1` honour `STAGE_UPDATE_PROGRESS` and `STAGE_UPDATE_RESULT` when set, and are silent when unset, so a human running the installer sees no change.
  - `STAGE_UPDATE_MODE=swap` — stage, swap, then signal `STAGE_UPDATE_SERVER_PID`. Skips service registration entirely, because the service already exists and is running.

Two things make this task load-bearing.

The protocol is what lets the renderer stay untouched: the installer narrates itself in the format `updater.ts` already polls.

Swap mode is what keeps the displays alive. Fresh-install mode legitimately stops and registers a service; an update must not, because stopping first would put every screen dark for the whole download **and** tear down the cgroup that the updater is running in. Staging while the server serves, swapping atomically, and signalling last is the ordering `scripts/update.sh` already proves works.

- [ ] **Step 1: Add the helpers to `install.sh`, immediately after `set -euo pipefail`**

```bash
# Update protocol (optional). When the app drives this script it passes these
# paths; a human running the installer by hand passes neither and the helpers
# become no-ops. Format matches scripts/update.sh exactly, because the app's
# poller already knows how to read it.
_now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
write_progress() {
  [ -n "${STAGE_UPDATE_PROGRESS:-}" ] || return 0
  printf '{"step":"%s","at":"%s"}' "$1" "$(_now)" >"$STAGE_UPDATE_PROGRESS" 2>/dev/null || true
}
write_result() {
  [ -n "${STAGE_UPDATE_RESULT:-}" ] || return 0
  printf '{"ok":%s,"error":"%s","at":"%s"}' "$1" "${2:-}" "$(_now)" >"$STAGE_UPDATE_RESULT" 2>/dev/null || true
}
# Any non-zero exit reports failure, so the UI can never wait forever.
trap 'write_result false "installer failed - see the server log"' ERR
```

- [ ] **Step 2: Call them at the existing stages in `install.sh`**

Add `write_progress pull` immediately before the archive download; `write_progress install` immediately before extraction; `write_progress build` immediately before service registration; and `write_progress restarting` plus `write_result true ""` immediately before the script starts the service.

- [ ] **Step 3: Add swap mode to `install.sh`**

`install.sh` already downloads to `$WORK`, verifies the sha256, and replaces `$RELEASE_DIR`. Swap mode reuses all of that and changes only the ending. After the extract-and-replace step, branch instead of registering a service:

```bash
# Update mode. The service already exists and is RUNNING: everything above
# happened while it kept serving. Do not stop it, do not re-register it - swap
# is already done, so the only thing left is to ask it to exit. The service
# manager relaunches it on the new files.
#
# Ordering matters. Stopping the service first would blank every display for the
# length of the download, and on systemd it would tear down the cgroup this
# script is running in, killing the update midway.
if [ "${STAGE_UPDATE_MODE:-}" = "swap" ]; then
  write_progress restarting
  write_result true ""
  if [ -n "${STAGE_UPDATE_SERVER_PID:-}" ]; then
    sleep 1                                        # let the HTTP response flush
    kill "$STAGE_UPDATE_SERVER_PID" 2>/dev/null || true
  fi
  exit 0
fi
```

Guard the service-registration block that follows so it only runs for a fresh install:

```bash
if [ "${STAGE_UPDATE_MODE:-}" != "swap" ]; then
  # ... existing systemd / launchd / service registration ...
fi
```

- [ ] **Step 4: Verify the no-op path by hand**

Run: `bash -n install.sh`
Expected: no syntax errors.

Run: `STAGE_UPDATE_PROGRESS=/tmp/p.json bash -c 'source <(sed -n "1,30p" install.sh); write_progress pull; cat /tmp/p.json'`
Expected: prints `{"step":"pull","at":"..."}`.

- [ ] **Step 5: Mirror the helpers and swap mode in `install.ps1`**

```powershell
function Write-UpdateProgress($Step) {
  if (-not $env:STAGE_UPDATE_PROGRESS) { return }
  $at = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  "{`"step`":`"$Step`",`"at`":`"$at`"}" | Set-Content -Path $env:STAGE_UPDATE_PROGRESS -Encoding utf8
}
function Write-UpdateResult($Ok, $ErrorText) {
  if (-not $env:STAGE_UPDATE_RESULT) { return }
  $at = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  $b = if ($Ok) { "true" } else { "false" }
  "{`"ok`":$b,`"error`":`"$ErrorText`",`"at`":`"$at`"}" | Set-Content -Path $env:STAGE_UPDATE_RESULT -Encoding utf8
}
```

Call them at the same four stages, and wrap the body in `try { ... } catch { Write-UpdateResult $false $_.Exception.Message; throw }`.

Then add the same swap branch after the files are replaced, before task registration:

```powershell
# Update mode - see the rationale in install.sh. The scheduled task already
# exists and is running; swapping is done, so only the exit signal remains.
if ($env:STAGE_UPDATE_MODE -eq "swap") {
  Write-UpdateProgress "restarting"
  Write-UpdateResult $true ""
  if ($env:STAGE_UPDATE_SERVER_PID) {
    Start-Sleep -Seconds 1
    Stop-Process -Id ([int]$env:STAGE_UPDATE_SERVER_PID) -Force -ErrorAction SilentlyContinue
  }
  exit 0
}
```

- [ ] **Step 6: Commit**

```bash
git add install.sh install.ps1
git commit -m "feat(install): add swap mode, and report progress the app can poll"
```

---

### Task 4: Tarball strategy

**Files:**
- Create: `main/services/update/tarball-strategy.ts`
- Test: `main/services/update/tarball-strategy.test.ts`

**Interfaces:**
- Consumes: `UpdateStrategy`, `ApplyOptions`, `SpawnPlan` from Task 2; swap mode from Task 3.
- Produces: `class TarballStrategy implements UpdateStrategy`, `constructor(platform: NodeJS.Platform)`.

The installer is FETCHED at update time, never vendored: a vendored copy would be the previous release's installer, capping how fast an installer fix reaches anyone.

**There is no `systemd-run`, and no platform-specific spawn.** An earlier draft ran Linux work in a transient scope to escape the unit's cgroup. That was solving a problem this design no longer has: the cgroup only tears down because something called `systemctl stop`, and swap mode never does. Every platform runs the same shape — stage and swap while serving, signal last — so Linux and macOS differ only in which interpreter runs the fetched script.

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TarballStrategy } from "./tarball-strategy.js";

const INSTALLER = "https://raw.githubusercontent.com/Cornerstone-Production/Stage-Utility/main/install.sh";

const base = { track: "main", checkout: false, deferRestart: false, version: null, env: {} };

describe("TarballStrategy", () => {
  it("always asks the installer for swap mode, so the service is never stopped first", () => {
    for (const platform of ["linux", "darwin", "win32"] as NodeJS.Platform[]) {
      const p = new TarballStrategy(platform).plan(base);
      assert.equal(p.env.STAGE_UPDATE_MODE, "swap", `${platform} must use swap mode`);
    }
  });

  it("never reaches for systemd-run: nothing stops the unit, so there is no cgroup to escape", () => {
    const p = new TarballStrategy("linux").plan(base);
    assert.equal(p.command, "bash");
    assert.ok(!p.args.join(" ").includes("systemd-run"), "swap mode removes the need for a scope");
  });

  it("runs the same shape on Linux and macOS", () => {
    const linux = new TarballStrategy("linux").plan(base);
    const mac = new TarballStrategy("darwin").plan(base);
    assert.deepEqual(linux.args, mac.args);
  });

  it("can always apply, because it has no external prerequisite", () => {
    assert.equal(new TarballStrategy("linux").canApply().ok, true);
  });

  it("fetches the installer rather than running a local copy", () => {
    const p = new TarballStrategy("darwin").plan(base);
    assert.ok(p.args.join(" ").includes(INSTALLER), "must curl the current installer");
  });

  it("passes the track through, and a pinned version when given", () => {
    const beta = new TarballStrategy("darwin").plan({ ...base, track: "beta" });
    assert.equal(beta.env.STAGE_TRACK, "beta");
    const pinned = new TarballStrategy("darwin").plan({ ...base, version: "v1.9.6" });
    assert.equal(pinned.env.STAGE_VERSION, "v1.9.6");
  });

  it("uses PowerShell on Windows", () => {
    const p = new TarballStrategy("win32").plan(base);
    assert.equal(p.command, "powershell.exe");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx --test main/services/update/tarball-strategy.test.ts`
Expected: FAIL — cannot find module `./tarball-strategy.js`.

- [ ] **Step 3: Implement**

```ts
// tarball-strategy.ts — update a one-line-installer install by re-running the
// CURRENT installer, fetched at update time.
import type { InstallKind } from "./install-kind.js";
import type { ApplyOptions, SpawnPlan, UpdateStrategy } from "./strategy.js";

const REPO = "Cornerstone-Production/Stage-Utility";
const SH = `https://raw.githubusercontent.com/${REPO}/main/install.sh`;
const PS1 = `https://raw.githubusercontent.com/${REPO}/main/install.ps1`;

export class TarballStrategy implements UpdateStrategy {
  readonly kind: InstallKind = "tarball";
  constructor(private readonly platform: NodeJS.Platform) {}

  /** Nothing to check: the installer is fetched, and swap mode needs no tooling. */
  canApply(): { ok: true } | { ok: false; reason: string } {
    return { ok: true };
  }

  plan(o: ApplyOptions): SpawnPlan {
    const env = {
      ...o.env,
      STAGE_TRACK: o.track,
      // Stage and swap while the server keeps serving, then signal it to exit.
      // Without this the installer would stop the service first, blanking every
      // display for the whole download and - on systemd - tearing down the
      // cgroup this process runs in, killing the update midway.
      STAGE_UPDATE_MODE: "swap",
      ...(o.version ? { STAGE_VERSION: o.version } : {}),
    };

    if (this.platform === "win32") {
      return {
        command: "powershell.exe",
        args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `irm ${PS1} | iex`],
        env,
      };
    }
    return { command: "bash", args: ["-c", `curl -fsSL ${SH} | bash`], env };
  }
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx tsx --test main/services/update/tarball-strategy.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add main/services/update/tarball-strategy.ts main/services/update/tarball-strategy.test.ts
git commit -m "feat(update): update a packaged install by re-running the current installer"
```

---

### Task 5: Homebrew strategy

**Files:**
- Create: `main/services/update/homebrew-strategy.ts`
- Test: `main/services/update/homebrew-strategy.test.ts`

**Interfaces:**
- Consumes: `UpdateStrategy`, `ApplyOptions`, `SpawnPlan` from Task 2.
- Produces: `class HomebrewStrategy implements UpdateStrategy`, `constructor(exists?: (p: string) => boolean)`, plus exported `const BREW_PATHS = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"]` and `FORMULA = { main: "stage-utility", beta: "stage-utility-beta" }`.

Brew owns the Cellar, so the app never writes into the keg. A track switch is uninstall-then-install, and the target formula is resolved FIRST so a typo cannot leave the machine with nothing installed.

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HomebrewStrategy, BREW_PATHS } from "./homebrew-strategy.js";

const noBrew = () => false;
const brewAt = (want: string) => (p: string) => p === want;

describe("HomebrewStrategy", () => {
  it("refuses when brew cannot be found, naming where it looked", () => {
    const r = new HomebrewStrategy(noBrew).canApply();
    assert.equal(r.ok, false);
    for (const p of BREW_PATHS) assert.ok((r as { reason: string }).reason.includes(p));
  });

  it("finds brew on Apple silicon and on Intel", () => {
    assert.equal(new HomebrewStrategy(brewAt(BREW_PATHS[0])).canApply().ok, true);
    assert.equal(new HomebrewStrategy(brewAt(BREW_PATHS[1])).canApply().ok, true);
  });

  it("updates in place with brew upgrade, never touching the keg itself", () => {
    const s = new HomebrewStrategy(brewAt(BREW_PATHS[0]));
    const p = s.plan({ track: "main", checkout: false, deferRestart: false, version: null, env: {} });
    const line = p.args.join(" ");
    assert.ok(line.includes("brew update"));
    assert.ok(line.includes("upgrade stage-utility"));
    assert.ok(!line.includes("uninstall"), "a same-track update must not uninstall");
  });

  it("switches tracks by resolving the target BEFORE uninstalling anything", () => {
    const s = new HomebrewStrategy(brewAt(BREW_PATHS[0]));
    const p = s.plan({ track: "beta", checkout: true, deferRestart: false, version: null, env: {} });
    const line = p.args.join(" ");
    const resolve = line.indexOf("info stage-utility-beta");
    const uninstall = line.indexOf("uninstall");
    assert.ok(resolve >= 0, "must resolve the target formula");
    assert.ok(uninstall > resolve, "resolve must happen before uninstall");
  });

  it("restarts the service after switching, since uninstall stops the agent", () => {
    const s = new HomebrewStrategy(brewAt(BREW_PATHS[0]));
    const p = s.plan({ track: "beta", checkout: true, deferRestart: false, version: null, env: {} });
    assert.ok(p.args.join(" ").includes("services start stage-utility-beta"));
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx --test main/services/update/homebrew-strategy.test.ts`
Expected: FAIL — cannot find module `./homebrew-strategy.js`.

- [ ] **Step 3: Implement**

```ts
// homebrew-strategy.ts — delegate to brew, which owns the keg.
import * as fs from "node:fs";
import type { InstallKind } from "./install-kind.js";
import type { ApplyOptions, SpawnPlan, UpdateStrategy } from "./strategy.js";

/** A launchd agent gets a minimal PATH, so brew is resolved by absolute path. */
export const BREW_PATHS = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"];

export const FORMULA = { main: "stage-utility", beta: "stage-utility-beta" } as const;

export class HomebrewStrategy implements UpdateStrategy {
  readonly kind: InstallKind = "homebrew";
  constructor(private readonly exists: (p: string) => boolean = fs.existsSync) {}

  private brew(): string | null {
    return BREW_PATHS.find((p) => this.exists(p)) ?? null;
  }

  canApply(): { ok: true } | { ok: false; reason: string } {
    if (!this.brew()) {
      return { ok: false, reason: `Could not find brew. Looked in: ${BREW_PATHS.join(", ")}.` };
    }
    return { ok: true };
  }

  plan(o: ApplyOptions): SpawnPlan {
    const brew = this.brew() ?? BREW_PATHS[0];
    const target = o.track === "beta" ? FORMULA.beta : FORMULA.main;
    const other = target === FORMULA.beta ? FORMULA.main : FORMULA.beta;

    // Same track: a plain upgrade.
    // Switching: resolve the target FIRST, so a formula that does not exist fails
    // while the current one is still installed. Uninstalling stops the agent, so
    // the new formula's service is started explicitly.
    const script = o.checkout
      ? [
          `${brew} update`,
          `${brew} info ${target} >/dev/null`,
          `${brew} uninstall ${other} || true`,
          `${brew} install ${target}`,
          `${brew} services start ${target}`,
        ].join(" && ")
      : [`${brew} update`, `${brew} upgrade ${target}`, `${brew} services restart ${target}`].join(" && ");

    return { command: "bash", args: ["-c", script], env: { ...o.env } };
  }
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx tsx --test main/services/update/homebrew-strategy.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add main/services/update/homebrew-strategy.ts main/services/update/homebrew-strategy.test.ts
git commit -m "feat(update): delegate Homebrew installs to brew"
```

---

### Task 6: Wire the strategies into the updater

**Files:**
- Modify: `main/services/updater.ts` (the `launch()` method, currently around lines 381-449)
- Create: `main/services/update/select-strategy.ts`
- Test: `main/services/update/select-strategy.test.ts`

**Interfaces:**
- Consumes: every class from Tasks 1, 2, 4, 5.
- Produces: `function selectStrategy(kind: InstallKind, platform: NodeJS.Platform, exists?: (p: string) => boolean): UpdateStrategy | null` — `null` for `"unknown"`.

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { selectStrategy } from "./select-strategy.js";

describe("selectStrategy", () => {
  it("maps each known kind to its strategy", () => {
    assert.equal(selectStrategy("git", "linux")?.kind, "git");
    assert.equal(selectStrategy("tarball", "linux")?.kind, "tarball");
    assert.equal(selectStrategy("homebrew", "darwin")?.kind, "homebrew");
  });

  it("returns null for an unknown install so the caller can refuse clearly", () => {
    assert.equal(selectStrategy("unknown", "linux"), null);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx --test main/services/update/select-strategy.test.ts`
Expected: FAIL — cannot find module `./select-strategy.js`.

- [ ] **Step 3: Implement the selector**

```ts
import * as fs from "node:fs";
import { GitStrategy } from "./git-strategy.js";
import { HomebrewStrategy } from "./homebrew-strategy.js";
import type { InstallKind } from "./install-kind.js";
import type { UpdateStrategy } from "./strategy.js";
import { TarballStrategy } from "./tarball-strategy.js";
import { APP_ROOT } from "../app-root.js";

export function selectStrategy(
  kind: InstallKind,
  platform: NodeJS.Platform,
  exists: (p: string) => boolean = fs.existsSync,
): UpdateStrategy | null {
  if (kind === "git") return new GitStrategy(APP_ROOT, exists);
  if (kind === "tarball") return new TarballStrategy(platform);
  if (kind === "homebrew") return new HomebrewStrategy(exists);
  return null;
}
```

- [ ] **Step 4: Replace the body of `launch()` in `updater.ts`**

Delete the packaged-install guard added earlier (the `!fs.existsSync(script)` block) and the hardcoded `script` constant, and drive the spawn from the strategy instead:

```ts
const kind = detectInstallKind(process.env, REPO_ROOT, fs.existsSync);
const strategy = selectStrategy(kind, process.platform);
if (!strategy) {
  throw new Error(
    `Cannot update: this install was not recognised (detected "${kind}"). ` +
      "Reinstall with the documented installer, or use brew upgrade.",
  );
}
const ready = strategy.canApply();
if (!ready.ok) throw new Error(`Cannot update: ${ready.reason}`);

const plan = strategy.plan({
  track: branch,
  checkout,
  deferRestart,
  version: tag,
  env: env as Record<string, string>,
});
const child = spawn(plan.command, plan.args, {
  cwd: REPO_ROOT,
  detached: true,
  stdio: "ignore",
  env: plan.env,
  ...(process.platform === "win32" ? { windowsHide: true } : {}),
});
child.unref();
```

- [ ] **Step 5: Verify nothing regressed**

Run: `npm run type-check && npm run lint && npm test`
Expected: type-check and lint clean; all tests pass.

- [ ] **Step 6: Commit**

```bash
git add main/services/update/select-strategy.ts main/services/update/select-strategy.test.ts main/services/updater.ts
git commit -m "feat(update): choose the update strategy from the install kind"
```

---

### Task 7: Launchers declare their install kind

**Files:**
- Modify: `scripts/update-homebrew-formula.mjs` (the generated launcher script, and add the beta formula)
- Modify: `install.sh` (the launcher/service definition it writes)
- Modify: `install.ps1` (same)
- Modify: `packaging/homebrew/stage-utility.rb`

**Interfaces:**
- Consumes: nothing.
- Produces: every packaged launcher exports `STAGE_UTILITY_INSTALL_KIND`; the tap holds both `stage-utility` and `stage-utility-beta`.

- [ ] **Step 1: Add the export to the Homebrew launcher**

In the formula's generated `bin/stage-utility` wrapper, alongside the existing `STAGE_UTILITY_ROOT` line:

```bash
export STAGE_UTILITY_INSTALL_KIND="homebrew"
```

- [ ] **Step 2: Add the export to the tarball launchers**

`install.sh` writes a launcher and a service unit; add to both:

```bash
export STAGE_UTILITY_INSTALL_KIND="tarball"
```

For `install.ps1`, add `STAGE_UTILITY_INSTALL_KIND=tarball` to the scheduled task's environment.

- [ ] **Step 3: Generate the beta formula**

In `scripts/update-homebrew-formula.mjs`, generate a second formula from the newest *prerelease*, writing `Formula/stage-utility-beta.rb` with class name `StageUtilityBeta` and the same structure. Both are regenerated on every release run.

- [ ] **Step 4: Verify the generator**

Run: `node scripts/update-homebrew-formula.mjs --dry-run`
Expected: prints both formulae, each with a `version` and per-platform `sha256` values.

- [ ] **Step 5: Commit**

```bash
git add scripts/update-homebrew-formula.mjs install.sh install.ps1 packaging/homebrew/stage-utility.rb
git commit -m "feat(install): declare the install kind, and publish a beta formula"
```

---

### Task 8: Survival tests in CI on all three platforms

**Files:**
- Create: `scripts/survival/parent.mjs`
- Create: `scripts/survival/child.mjs`
- Create: `scripts/survival/run-linux.sh`
- Create: `scripts/survival/run-macos.sh`
- Create: `scripts/survival/run-windows.ps1`
- Create: `.github/workflows/survival.yml`

**Interfaces:**
- Consumes: nothing.
- Produces: a CI job per platform that fails if a detached updater would be killed by its own service teardown.

These prove the part unit tests cannot: that the work *finishes* and the service comes back.

Two cases per platform, and the second matters as much as the first:

1. **Swap mode completes** — the updater runs to the end while the service is up, signals it, and the service manager relaunches it. This is the shipped path.
2. **Stop-first dies** — the same work, but with a `systemctl stop` before it. On Linux this must be shown to be killed midway. That failing case is the evidence that stops anyone reintroducing a stop-first installer later and quietly reopening the hole.

The macOS survival property was verified by hand on 2026-08-02 (a detached child survived `launchctl bootout`, reparented to pid 1, and ran to completion), which is what makes a Homebrew track switch safe. These tests make that repeatable and extend it to the two platforms never checked.

- [ ] **Step 1: Write the harness**

```js
// scripts/survival/child.mjs — stands in for the updater doing real work.
import fs from "node:fs";
const out = process.env.SURVIVAL_LOG;
let n = 0;
const t = setInterval(() => {
  n++;
  fs.appendFileSync(out, `tick ${n}\n`);
  if (n >= 15) { clearInterval(t); fs.appendFileSync(out, "FINISHED\n"); }
}, 1000);
```

```js
// scripts/survival/parent.mjs — stands in for the server, spawning exactly as
// updater.ts does: detached, stdio ignored, unref'd.
import { spawn } from "node:child_process";
const child = spawn(process.execPath, ["scripts/survival/child.mjs"], {
  detached: true,
  stdio: "ignore",
  env: process.env,
});
child.unref();
setInterval(() => {}, 1000); // stay alive like the server does
```

- [ ] **Step 2: Write the Linux runner — swap mode completes, stop-first does not**

```bash
#!/usr/bin/env bash
# run-linux.sh — proves the shipped ordering works, and that the ordering we
# rejected genuinely does not. The second case failing is the point: it is the
# evidence that keeps a stop-first installer from being reintroduced later.
set -euo pipefail

run_case() { # $1 = "swap"|"stopfirst", $2 = expected "yes"|"no"
  local log; log=$(mktemp)
  sudo systemd-run --unit=survival-test --setenv=SURVIVAL_LOG="$log" \
    "$(command -v node)" scripts/survival/parent.mjs
  sleep 4
  # swap mode never stops the unit; the updater signals the server at the end and
  # the service manager relaunches it. stopfirst is what an installer that stops
  # before working would do.
  if [ "$1" = "stopfirst" ]; then sudo systemctl stop survival-test || true; fi
  sleep 14
  local got=no; grep -q FINISHED "$log" && got=yes
  sudo systemctl stop survival-test >/dev/null 2>&1 || true
  echo "  case=$1 expected=$2 got=$got"
  [ "$got" = "$2" ]
}

run_case swap      yes   # work finishes: nothing stopped it
run_case stopfirst no    # cgroup teardown kills it midway - why swap mode exists
```

- [ ] **Step 3: Add a swap-mode integration check for the installer**

`scripts/survival/run-swap-linux.sh` runs the real `install.sh` with
`STAGE_UPDATE_MODE=swap` against a throwaway service and asserts three things:
the service is still answering *during* the download, `STAGE_UPDATE_RESULT`
contains `{"ok":true`, and the service is answering again afterwards on the new
version. This is the behaviour Task 3 produces; the unit tests only prove the app
asked for it.

- [ ] **Step 4: Write the macOS and Windows runners**

`run-macos.sh` loads a throwaway launchd agent running `parent.mjs`, tears it down with `launchctl bootout`, and asserts `FINISHED` appears. `run-windows.ps1` registers a throwaway scheduled task, runs it, calls `Stop-ScheduledTask`, and asserts `FINISHED` appears.

- [ ] **Step 5: Add the CI workflow**

```yaml
name: survival
on: [push, pull_request]
jobs:
  survival:
    strategy:
      fail-fast: false
      matrix:
        include:
          - { os: ubuntu-latest, run: "bash scripts/survival/run-linux.sh" }
          - { os: macos-latest,  run: "bash scripts/survival/run-macos.sh" }
          - { os: windows-latest, run: "pwsh scripts/survival/run-windows.ps1" }
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with: { node-version: 24 }
      - run: ${{ matrix.run }}
```

- [ ] **Step 6: Run the Linux case locally if a systemd host is available, else rely on CI**

Run: `bash scripts/survival/run-linux.sh`
Expected: `case=swap expected=yes got=yes` then `case=stopfirst expected=no got=no`.

If `stopfirst` reports `got=yes`, do not treat that as a pass — it means the teardown is not reaching the process and the test is no longer proving anything. Investigate before continuing.

- [ ] **Step 7: Commit**

```bash
git add scripts/survival .github/workflows/survival.yml
git commit -m "test(update): prove the updater survives its own service teardown"
```

---

### Task 9: Documentation

**Files:**
- Modify: `docs/ops/install-and-config.md`
- Modify: `docs/ops/homebrew.md`
- Modify: `docs/ops/distribution.md`

**Interfaces:**
- Consumes: nothing.
- Produces: docs that match the shipped behaviour.

- [ ] **Step 1: Correct the Homebrew page**

`docs/ops/homebrew.md` currently says a Homebrew install cannot update from Settings. Replace that with: updates and track switches work from Settings → Advanced; switching tracks swaps between the `stage-utility` and `stage-utility-beta` formulae; data lives in `$(brew --prefix)/var/stage-utility` and survives the switch. Also correct the upgrade row to `brew update && brew upgrade stage-utility`, since `brew upgrade` alone never sees new versions of a third-party tap.

- [ ] **Step 2: Note the requirement in the install docs**

In `docs/ops/install-and-config.md`, state that an in-app update keeps serving throughout: the new version is downloaded, verified and swapped into place while the current one runs, and the only interruption is a single restart at the end. There is no extra tooling requirement on any platform.

- [ ] **Step 3: Commit**

```bash
git add docs/ops/install-and-config.md docs/ops/homebrew.md docs/ops/distribution.md
git commit -m "docs(update): in-app updates now work on every install method"
```

---

## Self-review

**Spec coverage.** Install kinds and the legacy fallback → Task 1. Strategy interface → Task 2. Tarball (fetched installer, swap mode, refuse on fetch failure) → Tasks 3, 4. Homebrew (delegate, resolve-before-uninstall, restart the agent, brew path resolution) → Task 5. Unchanged progress protocol → Task 3, consumed in Task 6. Beta formula → Task 7. Stage-swap-signal ordering, so the service is never stopped before its work is done → Task 3, enforced by Task 4, proven both ways in Task 8. Survival tests on three runners → Task 8. Error handling (validate before spawning, always write a result) → Tasks 2-6. Docs → Task 9.

**Known gap, deliberately deferred:** the spec's staged rollout (one `beta` cycle against the prod box before `main`) is a release decision, not a code change, so it has no task. It must still happen.

**Open question — Windows file locking.** Swap mode assumes files can be replaced under a running process. That holds on Unix, where the server keeps its open inodes and only picks up new files on restart. Windows locks open executables, so replacing `node.exe` while the scheduled task runs may fail outright.

Task 8's Windows runner is what surfaces this; do not pre-solve it. If it fails, the likely answer is stop-swap-start on Windows only — a documented platform exception with its own downtime, not a redesign of the other two. **Stop and raise it rather than inventing a workaround**, because the wrong fix here (retry loops, force-unlock, staging the binary elsewhere) is worse than the downtime.

**Type consistency.** `UpdateStrategy`, `ApplyOptions`, `SpawnPlan`, `InstallKind` are defined once in Tasks 1-2 and used unchanged after. `canApply()` returns the same discriminated union everywhere. `plan()` returns `SpawnPlan` in all three strategies.
