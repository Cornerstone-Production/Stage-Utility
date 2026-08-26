# In-app updates on every install method

**Goal:** Update and switch tracks from Settings → Advanced regardless of how the
server was installed — Homebrew, a one-line installer, or a git checkout.

## Why

`updater.ts` spawns `scripts/update.sh` with `cwd = APP_ROOT` and needs a `.git`.
A packaged install ships only the built server (`build/`, `node`, `public/`,
`server.mjs`, `VERSION`), so the script does not exist. Because the child is
spawned detached with `stdio: "ignore"`, bash exited instantly and nothing was
written to the progress or result file — the UI sat on "Downloading update…"
indefinitely with no way to learn it had already failed.

That is now guarded (it refuses with a message), but refusing is not the goal.
The point of a packaged install is that a non-technical operator keeps it current
without a terminal.

## Install kinds

Declared, never sniffed. The packaged launchers already export
`STAGE_UTILITY_ROOT`; they also export `STAGE_UTILITY_INSTALL_KIND`.

| Kind | How it is known |
|---|---|
| `homebrew` | launcher exports `STAGE_UTILITY_INSTALL_KIND=homebrew` |
| `tarball` | launcher exports `STAGE_UTILITY_INSTALL_KIND=tarball` |
| `git` | nothing exported and `APP_ROOT/.git` exists |
| unknown | anything else — refuse with the reason |

### Legacy fallback

The launcher ships *with* the install, so a machine installed before this change
exports nothing and would refuse forever — the only way to get a launcher that
declares its kind is an update it will not perform.

So when the variable is absent, infer from `APP_ROOT`:

| Matches | Inferred kind |
|---|---|
| contains `/Cellar/stage-utility/` | `homebrew` |
| `/opt/stage-utility` (Linux) | `tarball` |
| `/usr/local/stage-utility` (macOS) | `tarball` |
| `C:\Program Files\Stage Utility` (Windows) | `tarball` |
| none of the above | `unknown` — refuse |

Those are the exact prefixes `install.sh` and `install.ps1` write to, so the list
has one source of truth rather than being a guess about where things usually live.

The inference selects a strategy and **is never used to decide where to write** —
each strategy still resolves its own paths from brew or the installer. A declared
kind always wins.

This is a deliberate, scoped softening of "never sniff". Without it every existing
operator needs a terminal once, which is the thing this design exists to remove.

## Strategy per kind

One interface — `canApply()`, `apply(track, version?)`, `switchTrack(track)` —
with three implementations.

### git — unchanged

Today's behaviour: fetch, checkout when switching, `npm ci` if the lockfile
changed, build, restart.

### tarball — re-run the current installer

Fetch `install.sh` (or `install.ps1` on Windows) from the repository at update
time and run it detached with `STAGE_TRACK` set, plus `STAGE_VERSION` when
pinning. The installer already does platform detection, checksum verification,
the swap, service re-registration and restart.

Fetched rather than vendored in the archive **deliberately**: a vendored copy
would mean the *old* release's installer performs every upgrade, capping how fast
an installer fix reaches anyone. Fetching is also the identical path the
documented one-liner uses, so there is one tested code path, not two.

Run with `STAGE_UPDATE_MODE=swap`, so the installer stages and swaps while the
server keeps serving and signals it only at the end — see "Surviving the restart"
below. Fresh-install mode is unchanged.

If the fetch fails — no DNS, GitHub unreachable, a proxy blocking
`raw.githubusercontent.com` — **refuse before touching anything**: write
`{ok:false, error}` to the result file and leave the install exactly as it was.
No cached-installer fallback; running older installer logic silently is the
staleness this design exists to avoid.

### homebrew — delegate to brew

Brew owns the Cellar, so the app never writes into the keg.

- **Update:** `brew update && brew upgrade stage-utility`
- **Switch track:** resolve the target formula **first**, then
  `brew uninstall <current>`, `brew install <target>`, `brew services start <target>`

Resolve the brew binary from `/opt/homebrew/bin/brew` then `/usr/local/bin/brew`
before trusting `PATH` — a launchd agent gets a minimal one.

**Data survives a switch.** Data lives in `$(brew --prefix)/var/stage-utility`,
outside the keg; `brew uninstall` removes the keg only. Verified on a real
install: `settings.json`, `views.json`, `baptism.json` and `cache/` sit in `var/`,
as do `secrets.bin` and `encryption.key` once PCO is configured.

**The service must be restarted explicitly.** Uninstalling stops the
`brew services` agent; the switch is not complete until the new formula's agent
is started.

## Progress protocol — unchanged

`update.sh` already writes `{"step","at"}` to `STAGE_UPDATE_PROGRESS` and a JSON
result to `STAGE_UPDATE_RESULT`, and `updater.ts` polls both. `install.sh` and a
small brew wrapper script emit the **same two files**, so the existing progress
bar, step labels and restart handling work with **no renderer change**.

This is what keeps the change small: the UI already knows how to narrate an
update. Only who performs it changes.

## Packaging and tap changes

- `scripts/update-homebrew-formula.mjs` also generates `stage-utility-beta` from
  the newest prerelease, so switching tracks under brew means switching formula.
  Both formulae are regenerated on every release.
- No archive change. The installer is fetched, not shipped.

## Error handling

Generalises the fix already on beta: **every strategy validates that it can run
before it starts, and writes a result file on failure.** The UI must always be
able to leave the "updating" phase.

Specifically:

- unknown install kind → refuse, naming what was detected
- `brew` binary not found → refuse, naming the paths tried
- installer fetch failed → refuse, naming the URL
- target formula does not resolve → refuse **before** uninstalling anything

## Surviving the restart — the load-bearing mechanism

Every strategy ends by stopping the service that is running the app, so the
script doing the work must outlive its own parent. This is the part most likely
to fail, and it does **not** behave the same on both platforms.

### macOS / launchd — verified empirically, 2026-08-02

A throwaway launchd agent spawned a child exactly as `updater.ts` does
(`detached: true`, `stdio: "ignore"`, `unref()`), then the job was torn down with
`launchctl bootout` — which is what `brew services stop` runs.

Result: the parent died; **the child survived**, reparented to pid 1, and kept
working (25 → 30 ticks after the bootout) through to a clean finish. launchd kills
by job, and `detached: true` calls `setsid()`, which escapes it.

So the Homebrew flow — uninstall, install, `services start` — is sound.

### Linux / systemd — NOT proven, must be handled differently

systemd kills by **cgroup**, and `setsid()` does not escape a cgroup. The default
`KillMode=control-group` therefore takes the detached script down with the unit.
The macOS result above does not carry over, and assuming it would is the single
most likely way this ships broken.

**Decision: keep serving until the last moment — stage, swap, then signal.**

`update.sh` was inspected before deciding (2026-08-02). It never calls
`systemctl stop` or `systemctl restart` at all. It does every slow step — pull,
`npm ci`, build — while the service runs normally, and only as its **final
action** kills the server pid so the service manager relaunches it:

```
write_progress restarting
kill "$STAGE_UPDATE_SERVER_PID"      # last line
```

That ordering is not an accident, and it is worth preserving: displays keep
serving through the whole download, and the outage is one restart rather than the
length of the update.

An earlier draft of this spec had the tarball strategy hand control to
`install.sh`, which stops the service *first* and then does the slow work. That
was wrong twice over. It would have put the displays dark for the entire
download — a regression dressed up as a feature — and stopping the unit is
precisely what tears down the cgroup and kills the updater mid-swap, which is
what made `systemd-run --scope --collect` seem necessary.

Remove the stop and the cgroup problem disappears with it. So every strategy
follows the same order:

1. Download and verify the archive into a staging directory — **still serving**
2. Extract and prepare it — **still serving**
3. Atomically swap the install directory into place — **still serving**, because
   a running process keeps its open inodes; the new files are simply not used yet
4. Kill the server pid and let the service manager relaunch on the new files

Step 4 is the last action, so nothing remains to be killed. No cgroup escape, no
`systemd-run`, and no dependency to refuse on when it is missing.

This means `install.sh` needs an **update mode** (`STAGE_UPDATE_MODE=swap`):
stage, swap, signal — distinct from its fresh-install mode, which legitimately
does stop and register a service.

### What still stops before it works

A Homebrew **track switch** is inherently uninstall-then-install, so there is
real work after the teardown. That path is macOS-only, where the launchd result
above already proves a detached child survives. Nothing else stops the service
before finishing.

**Still verified on a real systemd box before release**, not reasoned about — but
what is being verified changes: no longer "does the child escape the cgroup" but
"does the swap complete and the service come back".

### Windows / Task Scheduler — NOT proven

`install.ps1` stops and restarts a scheduled task. PowerShell's `Start-Process`
detaches by default, so the shape is closer to launchd than to systemd, but
Task Scheduler can terminate a task's descendants and this has never been
exercised. Needs the same empirical check as the other two.

## Testing

- Unit: install-kind detection across env + filesystem fixtures, including the
  unknown case.
- Unit: strategy selection per kind.
- Unit: progress/result file parsing (partly covered today).
- Integration: assert the **spawn contract** — argv and env for each strategy —
  against a fake installer, without swapping anything.
- Brew itself is not meaningfully testable here; cover binary resolution and argv
  construction only.

### Survival tests — required, not optional

The unit tests above prove the app *asks* for the right thing. They prove nothing
about whether the work finishes once the service dies. Each platform needs a
harness that reproduces the real teardown:

- **macOS:** a throwaway launchd agent spawns a detached child; `launchctl bootout`
  the job; assert the child survived and ran to completion. Already done by hand
  and passing — this makes it repeatable.
- **Linux:** the same shape under a throwaway systemd unit. Two cases, and both
  matter: a swap-mode run must complete and the unit must come back on the new
  files; and a run that *does* `systemctl stop` first must be shown to die
  mid-work, which is the evidence that keeps anyone from reintroducing it.
- **Windows:** the same against a throwaway scheduled task.

A release must not ship a strategy whose survival test has not run on that
platform. Treat a skipped survival test as a failing one.

**These run in CI, not on hardware anyone owns.** CI is currently
`ubuntu-latest` only; this adds `macos-latest` and `windows-latest`. All three
GitHub-hosted runners are full VMs with real service managers — ubuntu has
systemd, macOS has launchd, Windows has Task Scheduler — so each survival test
exercises the genuine teardown rather than a simulation of it.

That matters beyond convenience: without it, the systemd and Windows paths would
be written on a Mac and verified nowhere, which is how the cgroup difference
would have reached a Sunday morning. It also means the tests keep running after
this work ships, so a future change to `install.sh` cannot quietly break the
restart handoff.

The prod box remains the final check for systemd — a GitHub runner is not a Pi —
but it is the last gate, not the only one.

### Staging rollout

Ship behind the existing update-track split: run it on `beta` against the real
prod box for at least one update cycle before it reaches `main`. An update that
half-applies before a Sunday is worse than one that refuses.

## Risks

**A failed brew track switch leaves nothing installed.** Resolving the target
formula first shrinks the window, but if `brew install` fails after the uninstall
the operator must run one `brew install` by hand. Accepted: the alternative is
installing both formulae simultaneously, which collide on the same binary name.

**The installer becomes a live dependency of updating.** A broken `install.sh` on
`main` breaks in-app updates for every tarball install at once. Mitigation: the
installer is already exercised by every fresh install, and the release workflow
can smoke-test it.
