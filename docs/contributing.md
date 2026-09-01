# Contributing

## Commit convention

Stage Utility uses [Conventional Commits](https://www.conventionalcommits.org/).
This is not a new imposition — an audit of the last 200 commits found **every
non-merge commit already followed it**. Writing it down turns a habit into
something CI can check and the release tooling can read.

### Format

```
type(scope): subject
```

- **type** — required, from the table below.
- **scope** — optional, lower-case, the area touched. Two areas can be joined with
  `+` (`feat(history+scriptview):`), as this repo already does. Scopes in use:
  `design`, `patch`, `history`, `scriptview`, `attendance`, `integrations`, `sse`,
  `recorders`, `layout`, `layout-editor`, `advanced`, `server`, `pco`, `updater`,
  `types`, `rosstalk`.
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

Commits made with Claude Code carry:

```
Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_…
```

These are informational and do not affect the release level.

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

## Releases

Automated from the commit types above, by `.github/workflows/release.yml`. Your
commit type is what picks the version, so it is worth getting right.

| Push to | Produces |
|---|---|
| `beta` | a prerelease `X.Y.Z-beta.N`, tagged, published as a GitHub prerelease |
| `main` | the release `X.Y.Z`, tagged, published as the latest GitHub release |

A push containing only `docs`/`chore`/`refactor`/`test`/`ci`/`build` produces **no
release at all**, so documentation churn does not mint versions. Otherwise the level
is the highest severity among every commit since the last stable release — one `feat`
among twenty `docs` makes it a minor.

How that turns into a number, and how a running server gets the result, is in
[Releases and distribution](ops/distribution.md).

`package.json` is bumped and committed forward, then tagged. **Nothing is ever
force-pushed** — deployments track `beta` and a rewrite breaks their in-app updater.
The workflow re-runs lint, type-check, tests and build before it tags, so a red build
cannot become a release.

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

CI runs the same four. There is one long-standing lint warning
(`patch-import.tsx:170`); anything beyond that is yours.

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
