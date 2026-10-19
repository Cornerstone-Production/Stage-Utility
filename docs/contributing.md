# Contributing

## Commit convention

Stage Utility uses [Conventional Commits](https://www.conventionalcommits.org/).
CI checks every subject and the release tooling reads the types, so the convention
decides the version number.

`node scripts/check-commit-subjects.mjs [base]` runs the same check locally over
the commits since `base` (default `origin/beta`), naming each subject that does
not conform.

### Format

```
type(scope): subject
```

- **type** — required, from the table below.
- **scope** — optional, lower-case, the area touched, written from `a-z`, `0-9`,
  `.`, `+`, `/` and `-`: no spaces and no commas. Two areas can be joined with
  `+` (`feat(history+servicecue):`). Scopes in use:
  `design`, `patch`, `history`, `servicecue`, `attendance`, `integrations`, `sse`,
  `recorders`, `layout`, `layout-editor`, `advanced`, `server`, `pco`, `updater`,
  `types`, `rosstalk`.
- **scope, when it names the machinery** — `release`, `ci`, `dx` and `test` name
  this project's own tooling. A `feat`, `fix` or `perf` under one of them is typed
  honestly and still invisible to every operator, so it appears in no release
  notes and mints no release. The list is `main/services/internal-scopes.json`,
  read by the notes generator, the update dialog and the workflow alike. A
  breaking `!` is shown and counted whatever its scope.
- **subject** — imperative mood, no trailing period. Say what the change does, not
  what you did: "add rack color to the header", not "added rack color".

Body is free-form and encouraged for anything non-obvious — this repo's habit of
explaining *why* in the body is worth keeping.

### Types and what they release

| Type | Meaning | Version bump |
|---|---|---|
| `feat` | A new capability a user can see | **minor** |
| `fix` | A bug fix | **patch** |
| `perf` | Faster or lighter with no behavior change | **patch** |
| `refactor` | Restructuring with no behavior change | none |
| `docs` | Documentation only | none |
| `test` | Tests only | none |
| `build` | Build system, dependencies | none |
| `ci` | CI configuration | none |
| `chore` | Anything else with no user impact | none |
| `revert` | Reverts a previous commit | matches what it reverts |

Those ten are the whole list: `style:` and any other type fails the check.
`git revert`'s own `Revert "<original subject>"` form is accepted as written.

### Breaking changes

Append `!` after the type/scope, **and** explain the break in the body:

```
feat(types)!: rename Slot.channel to Slot.channelId

Any saved slots.json from before this release will not load; the migration in
slots-store.ts rewrites them on first read.
```

A `!` bumps the **major** version. Nothing in this repo has used one yet, which is
worth keeping true — most "breaking" changes here can be handled with a migration
in the store instead, the way the data-dir rename was.

### Why the level matters

The release flow reads these to decide the version, so the type is not cosmetic. A
`feat` shipped as `fix` produces a version number that lies about what changed. When
in doubt: could a user tell? Then it is `feat` or `fix`. Could only a developer tell?
Then it is `refactor`, `docs`, `test`, `build`, `ci` or `chore`.

### Merge commits

Merge commits (`Merge pull request #NNN from …`) are exempt — GitHub generates them
and they carry no release meaning. The release tooling ignores them and reads the
individual commits instead. This repo merges rather than squashes, so **the commits
you write are the ones that count** — the PR title is not what gets released from.

### Trailers

Commits carry no tool or session attribution. The one trailer the tooling reads
is `Beta-only: true`, below.

#### `Beta-only: true`

Put this on a `fix:` or `perf:` commit whose bug **never reached a stable
release** — a regression introduced and repaired inside the same release cycle.

```
fix(integrations): the Setup guide links to this build's branch

Beta-only: true
```

The release-notes generator drops such a commit from a stable release's
**Fixed** list, and counts it into the "N further fixes … were never in a
released version" line, so the omission is stated rather than silent. A
prerelease keeps it: somebody on the beta track has been running the broken
version, and for them the fix is the news.

The generator already suppresses a fix whose whole **scope** is new this release.
That rule cannot see a new feature built under an existing scope — in 1.13.0,
thirteen scopes carried both a `feat` and 42 fixes, and `integrations` is years
old even though the setup-guide link it fixes shipped in the same release. Only
the author knows whether the bug ever shipped, so only the author can say.

Rule of thumb: if somebody upgrading from the last stable release could not have
hit the bug, mark it.

CI runs a heuristic check (`scripts/check-beta-only.mjs`) that warns, but never
fails the build, on a `fix:`/`perf:` commit that touches a file also touched by
a `feat:` commit from this release cycle. It is a reminder, not a judge: sharing
a file does not mean sharing a bug, and a fix to a new feature in a file no
`feat:` commit happened to touch is invisible to it — the trailer remains the
author's call.

#### Correcting a trailer after the commit is on `beta`

A trailer that was missed, or added to a commit that did not need one, can only
be repaired in the commit until the commit reaches `beta`. `beta` is never
force-pushed, so from then on the body is fixed and the notes generator is the
only place left to say otherwise.

`docs/release-notes/overrides/<version>.json` is that place — a JSON array read
only when generating the notes for that exact version:

```json
[
  {
    "commit": "c9d5c299",
    "betaOnly": true,
    "reason": "The body says all five findings are in code from this branch, and the trailer was never added."
  }
]
```

| Field | |
|---|---|
| `commit` | a commit SHA, seven characters or more. Not a branch or a tag: a name that can move would apply the correction to whatever it points at on the day the release is cut |
| `betaOnly` | the decision the commit **should** have carried. `true` holds the fix back; `false` shows it, overriding both a wrong trailer and the new-scope heuristic |
| `reason` | required. An override with no reason is the same silent decision moved to a different file |

The reason is printed to the release log when the override is applied, so the
run says what it changed and why.

Everything here is a hard failure rather than a fallback: unreadable or
unparseable JSON, a missing field, a commit that does not resolve, one commit
listed twice, and an override naming a commit that is not a non-breaking
`fix:`/`perf:` in the release's range — that last one is a correction that would
never be applied, which reads as handled and is not.

A prerelease reads no override file. It keeps every fix regardless, because
somebody on the beta track has been running the broken version.

## Releases

Automated from the commit types above, by `.github/workflows/release.yml`. Your
commit type is what picks the version, so it is worth getting right.

| Push to | Produces |
|---|---|
| `beta` | a prerelease `X.Y.Z-beta.N`, tagged, published as a GitHub prerelease |
| `main` | the release `X.Y.Z`, tagged, published as the latest GitHub release |

A push containing only `docs`/`chore`/`refactor`/`test`/`ci`/`build`, or only
`feat`/`fix`/`perf` commits scoped to the tooling (`release`, `ci`, `dx`, `test`),
produces **no release at all**, so documentation churn and release-machinery fixes
do not mint versions. The rule is `scripts/release-level.sh`. Otherwise the level
is the highest severity among every commit since the last stable release — one `feat`
among twenty `docs` makes it a minor.

How that turns into a number, and how a running server gets the result, is in
[Releases and distribution](ops/distribution.md).

`package.json` is bumped and committed forward, then tagged. **Nothing is ever
force-pushed** — deployments track `beta` and a rewrite breaks their in-app updater.
The workflow runs lint, type-check, tests and build over the merged tree on every
push to `beta` or `main`, releasable or not, and only then tags, so a red build
cannot become a release. It is the one gate a push gets: the CI workflow runs on
pull requests only, and the release PR from `beta` to `main` is skipped there
because its head is a `beta` commit the release run has already verified and
marked with a `build` status.

To force a major, mark the commit breaking — `feat(types)!: …` plus an explanation in
the body.

## Branching

`main` ← `beta` ← feature branches.

- Feature work branches off `beta`, never off `main`.
- **Never force-push `beta` or `main`.** Deployments track `beta` and a rewrite
  breaks their in-app updater.
- **PRs are merged by the maintainer, and only by the maintainer.** An agent
  never runs `gh pr merge` — verbal approval in conversation is not
  authorisation. Get CI green, report the PR ready, and stop. (This replaces an
  earlier "explicit per-PR approval" wording, under which an agent once merged
  two PRs on a casual "you can merge them".)
- **Nothing is pushed directly to `beta` or `main`.** Every change — including a
  one-line fix — goes through a pull request off `beta`. Release automation is the
  exception: it commits the version bump and tag to those branches by design.

## Running it locally

```bash
npm run server   # the Node server, port 8788
npm run dev      # the UI on 3000, proxying /api to that server
```

Both halves read `STAGE_UTILITY_PORT`, so they move together:

```bash
STAGE_UTILITY_PORT=8799 npm run server
STAGE_UTILITY_PORT=8799 npm run dev
```

Set it on one and not the other and the UI talks to whatever is on 8788 —
which, on a machine that already runs a Stage Utility, is somebody's live
instance. The dev server prints its target on start; read it before you edit
anything.

## Before you open a PR

```bash
npm run lint && npm run type-check && npm test && npm run build
```

CI runs the same four, plus `npm audit --audit-level=high`. Lint is clean; a new
warning is yours to fix. Two cheap checks run on every pull request and are worth
running first: `node scripts/check-public-hygiene.mjs` (see
[Public hygiene](#public-hygiene)) and `node scripts/check-commit-subjects.mjs`.

CI runs them side by side rather than one after another: lint, type-check, build
and the audit in one job, and the test suite split across four more with
`npm test -- --test-shard=N/4`. A PR shows each, plus one `build` check that
passes only when all of them did. The release workflow verifies a push with the
same split, minus the audit and the action-pin check. Coverage is not part of the
PR gate: `coverage.yml` reports it for `beta` weekly, and on demand from the
Actions tab once the workflow is on `main`.

Not every check runs on every pull request. The secret scan, the commit
convention check and the public-hygiene check (below) run on all of them,
docs-only included. The script and workflow checks (below) run only when the files
they read change. CodeQL (`codeql.yml`, the extended query suite) runs on pull
requests to `beta` or `main`, on pushes to them, weekly, and by hand. JavaScript/TypeScript is analysed
every time; the other languages only when a change touches what they analyse:
Swift and C/C++ for `helper/macos/`, Ruby for a `.rb` file, and the workflows for
`.github/`. A change to either CodeQL workflow runs all of them, and so does every
push to `main`, the weekly run and a manual one. A language that does not run
shows as skipped, and on a pull request uploads an empty result under its own
category, so the `CodeQL` check still finds every configuration the base branch
has instead of reporting "configurations not found". What the scanner flags, and
what is dismissed, is in [Code scanning](reference/code-scanning.md). No check is
a required status check on `beta` or `main`: the release workflow pushes its
version bump to both directly, which a required check would refuse, so a merge is
gated by review of a green PR. The build and tests skip a PR that touches only `docs/` and Markdown; dependency
review runs only when `package.json` or the lockfile changes; the updater
survival matrix runs only for the updater, the installers and its own scripts;
and the Mac output helper's Swift build and tests (`helper-macos.yml`, on a
macOS runner) run only when `helper/` changes, or the Xcode selection
(`.github/actions/select-xcode`) that the release workflow's helper build shares.
A push to `beta` or `main` runs the gate once, in the release workflow, before it
tags, and writes the result to the commit as a `build` status, red or green. The
release PR from `beta` to `main` therefore shows no CI job of its own: its
`build` is that status on the `beta` head.

Chain them with `&&`, not `;`. With `;` a failure scrolls past and the commit
lands anyway — that is how a type error once reached `beta`.

Green is not finished. Two more questions, answered in the PR body:

- **Do the docs still describe this correctly?** A new integration, layout
  object, route, setting or changed default lands in the same commit as its
  entry in `docs/`. A capability documented nowhere gets used by nobody.
- **Does it log anything?** If it can fail, retry, reconnect or silently skip
  work, it says so on a tagged line the `/log` page surfaces. Log the decisions
  and the failures, not every success.

"No docs needed" and "nothing worth logging" are fine answers — say which, so
it reads as a decision rather than an omission.

### Script and workflow checks

Four checks cover the code that is not TypeScript. The installers run as root or
elevated on display machines, and the release workflow holds write access to the
repository.

| Check | Looks at | Runs when | Locally |
|---|---|---|---|
| ShellCheck | every tracked `*.sh`, and extensionless scripts with a shell shebang (`scripts/stage-upgrade`) | a shell script changes | `brew install shellcheck`, then `scripts/lint-shell.sh` |
| PSScriptAnalyzer | `scripts/kiosk/install-windows.ps1` | any `.ps1` changes | `brew install powershell`, `pwsh -c 'Install-Module PSScriptAnalyzer -Scope CurrentUser'`, then `pwsh scripts/lint-powershell.ps1` |
| zizmor | `.github/**`: workflows, composite actions, Dependabot config | anything under `.github` changes | `brew install zizmor` (or `pip install zizmor`), then `GH_TOKEN=$(gh auth token) zizmor .github` |
| Secret scan | the PR's commits and the working tree | every pull request | `gitleaks git . --log-opts="origin/beta..HEAD" --redact` |

The first three also run on every push to `main` and weekly, because a new
release of the tool can flag a file nobody touched. All four fail the job on any
finding.

`scripts/lint-shell.sh` and `scripts/lint-powershell.ps1` hold the file lists and
CI calls them, so a local run is the CI run. PSScriptAnalyzer covers the Windows
kiosk installer only. `install.ps1`, `scripts/update.ps1` and
`scripts/survival/run-windows.ps1` are listed as deferred in
`scripts/lint-powershell.ps1` and fail the analyzer today; a `.ps1` in neither
list fails the check, so a new script is linted or deferred on purpose. The
installer stays ASCII (see the header of that script for why).

A script piped to `sh` carries a `#!/bin/sh` shebang, because ShellCheck picks the
dialect from it and a bash shebang would check one shell and run another.

Findings are fixed. Where one is kept on purpose, suppress it where it stands,
naming the check and giving the reason on the same line:

```sh
# shellcheck disable=SC2086 # $_logs is a space-separated list of paths, meant to split
```

```powershell
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '', Justification = 'why')]
```

`scripts/lint-shell.sh` rejects a `disable=` that names no `SCxxxx` check, and a
`.shellcheckrc`. For zizmor, fix the workflow rather than adding a
`# zizmor: ignore`.

zizmor and the secret scan upload SARIF to code scanning, so their findings show
in the Security tab as well as the job log. ShellCheck and PSScriptAnalyzer have
no SARIF output; theirs are annotations on the PR diff. A fork or Dependabot pull
request cannot write to code scanning and skips the upload; the job still gates on
the scan.

### Merge-friendly guards

A test that pins an exact registry (every layout object type, every route,
every config store) should assert a sorted list, one entry per line — never a
bare count like `assert.equal(TYPES.length, 62)`. Two PRs that each add a
different entry touch different lines and merge without a conflict; a bare
count sits on the same line every time, so the second PR to land always
conflicts with the first. A count is also a weaker guard on its own: two
additions and one removal leave the number unchanged and the test still green.

## React state

Do not mirror a prop or a server value into state with an effect:

```tsx
// no
useEffect(() => setDraft(rule), [rule]);
```

That renders twice for every change — once with the stale value, then again once
the effect fires — so a stage display briefly paints the previous value. Prefer, in
order:

1. **Derive it.** State that is purely a function of props needs no state.
2. **`useResyncOn([deps], fn)`** (`renderer/lib/use-resync-on.ts`) when the state
   genuinely has to persist between changes — a draft being edited, a retry
   counter. It adjusts state during render, so the re-render happens before the
   browser paints and the stale frame never reaches the screen.

Where an effect both clears state synchronously and starts an async fetch, split
it: the clear goes in `useResyncOn`, the fetch stays in the effect.

Never write a ref during render (`ref.current = value` in the component body) — a
render may be discarded or replayed, and the write would outlive it. Use
**`useLatestRef(value)`** (`renderer/lib/use-latest-ref.ts`) for a value that must
escape the render that produced it, such as one read by a `ResizeObserver`
subscribed once. Anything rendered from belongs in state.

`react-hooks/set-state-in-effect` and `react-hooks/refs` enforce both of these.

## Tooltips and theme

`<Tooltip>` waits **2s** before opening, with no skip window — every tooltip waits
its full turn rather than the next one appearing instantly after the first. These
label controls that are already legible from their icon and position, so a tooltip
is for the rare moment someone is unsure, not something to fire at every pointer
crossing a toolbar. Anything an operator *must* read belongs in visible text or an
`InfoHint`, which opens on click and so works on touch.

The theme is `system` | `light` | `dark`, stored under `stage-utility-theme`.
`system` follows `prefers-color-scheme` live via a `matchMedia` listener, and is the
default when nothing is stored — so an install predating the option keeps the
behaviour it had. The pre-paint script in `app.html` reads the same key
and must stay in step with `useTheme`, or the page flashes the wrong theme on load.

## Dependencies

Two rules, and they are not negotiable.

**Only add a dependency that is actively maintained.** Check its last few real releases
and its own dependency tree before proposing it — a package published recently that still
pins ancient transitives is not maintained in the way that matters. Prefer small trees.

**Fix vulnerabilities at the root.** No `overrides`, no forced resolutions, no pinning
around a problem. Trace the advisory to the direct dependency that drags the stale chain
in (`npm why <pkg>` — the flagged leaf is rarely the cause), then either upgrade that
dependency properly or replace it and port the code. `npm audit` reaching zero is not
enough on its own; the feature that used the package needs a functional test too.

The reasoning is that an override leaves the stale package in the tree, so the next
advisory lands in exactly the same place, and an abandoned package can never be fixed
upstream — which is why `exceljs` was replaced by `write-excel-file` / `read-excel-file`
rather than pinned around.

Keep unrelated risk out of a security fix. A major bump that touches live render code
belongs in its own PR.

## Docs

Update `docs/` in the same commit as the change it describes. An integration gets a
page in `docs/integrations/`; a feature that changes operator behavior gets a note
wherever that behavior is documented. Docs that lag the code are worse than no docs,
because they are believed.

## Public hygiene

This repository is public, so tracked files carry no real addresses, people or
places. `node scripts/check-public-hygiene.mjs` reads every file `git ls-files`
lists (binaries and lockfiles are skipped) and exits 1 on any of:

| Rule | Fails on | Use instead |
|---|---|---|
| Private IPv4 | an address in 10/8, 172.16/12, 192.168/16, 100.64/10 (carrier-grade NAT, Tailscale) or 169.254/16 (link-local), outside `192.168.1.x`, `10.0.0.x` and `192.168.0.x`. The cloud-metadata endpoint `169.254.169.254` is allowed by name | `192.168.1.50` for a machine on the LAN; `10.0.0.x` for a second network |
| Email | an address not at `example.com`, `example.org` or `example.net` (or a subdomain), a reserved TLD (`.example`, `.test`, `.invalid`, `.localhost`) or `users.noreply.github.com`. Three addresses are allowed by name: `noreply@anthropic.com`, `git@github.com` and the RFC 2617 example `testrealm@host.com` | `someone@example.org` |
| Home path | a macOS, Linux or Windows home-directory path (a Windows one also with doubled backslashes) whose user is not `x`, `op`, `pi`, `someone`, `<someone>`, `youruser` or `Shared` | `/Users/someone/...` |
| Private term | a case-insensitive substring match against a list the repository keeps secret. A term is also found when it is wrapped over two lines of a comment, or separated by doubled or non-breaking spaces | a generic name: "The Gathering", "Main Room", `Main_Projector` |

### What it prints

One line per finding, `path:line: rule`. For the three generic rules the line
includes the matched value (`private IPv4 192.168.1.50`). A private-term finding
prints only `private term #N`, the entry's 1-based position in the list, never the
term. A term found in a file's name reports line `0`, with the term in the path
replaced by `***`. A term wrapped over lines is reported on the line where it
starts.

A home path whose user is a variable (`$USER`, `${ME}`, `$(id -un)`,
`%USERNAME%`) names nobody and is not flagged.

A line containing `hygiene-allow` is skipped by every rule. Reserve it for a
genuine exception, with the reason beside it. Each line whose finding was skipped
this way is listed at the end of the output, under
`[hygiene] N line(s) skipped by hygiene-allow`, so an exception is never invisible.

### What it protects, and what it does not

The check blocks a merge, not publication. A pushed branch is already public, and
the history keeps what was pushed: a finding means "fix this before it lands on
`beta`", and anything already pushed has to be treated as published.

### The term list

The list is the `PRIVATE_TERMS` repository secret in CI. Locally it comes from
`PRIVATE_TERMS` in the environment and a `.private-terms` file at the repo root
(git-ignored); environment entries are numbered before the file's.

One term per line, blank lines ignored, matched as a case-insensitive substring.
Prefer full names and phrases over short words: a short first name also matches
inside identifiers (`tom` is inside `atomic`).

Create or rotate the secret from a file of terms kept outside the repository:

```sh
gh secret set PRIVATE_TERMS --repo Cornerstone-Production/Stage-Utility < terms.txt
```

Setting it again replaces the whole list. Entries are numbered by position, so
`private term #N` in an older log refers to the list as it was then.

### When there is no list

With no list the check prints `PRIVATE_TERMS not set; checking generic rules
only` and runs the first three rules. A fork's PR and a Dependabot PR see exactly
that, because neither can read the repository secret.

The workflow sets `REQUIRE_TERMS=1` for a PR from a branch of this repository
(not from a fork, and not by Dependabot). With `REQUIRE_TERMS=1` and no list the
check fails with an error instead, so a deleted or misnamed secret turns every
such PR red rather than quietly weakening the check.

### An accepted risk

A PR from a branch of this repository runs the version of the script in that
PR, with the secret in its environment, so it could be edited to print the list.
That is accepted: only people with write access open such a PR, and they can
already read the repository's workflows and settings. Forks and Dependabot never
receive the secret.
