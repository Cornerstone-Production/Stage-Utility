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
  what you did: "add rack colour to the header", not "added rack colour".

Body is free-form and encouraged for anything non-obvious — this repo's habit of
explaining *why* in the body is worth keeping.

### Types and what they release

| Type | Meaning | Version bump |
|---|---|---|
| `feat` | A new capability a user can see | **minor** |
| `fix` | A bug fix | **patch** |
| `perf` | Faster or lighter with no behaviour change | **patch** |
| `refactor` | Restructuring with no behaviour change | none |
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

## Branching

`main` ← `beta` ← feature branches.

- Feature work branches off `beta`, never off `main`.
- **Never force-push `beta` or `main`.** Deployments track `beta` and a rewrite
  breaks their in-app updater.
- PRs to `main` are opened but never merged without explicit per-PR approval.
- Pushing directly to `beta` is fine for small changes.

## Before you push

```bash
npm run lint && npm run type-check && npm test && npm run build
```

CI runs the same four. There is one long-standing lint warning
(`patch-import.tsx:170`); anything beyond that is yours.

## Docs

Update `docs/` in the same commit as the change it describes. An integration gets a
page in `docs/integrations/`; a feature that changes operator behaviour gets a note
wherever that behaviour is documented. Docs that lag the code are worse than no docs,
because they are believed.
