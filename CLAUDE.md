# Working in this repo

Notes for an agent making changes here. Conventions, branching and the release
flow live in [docs/contributing.md](docs/contributing.md) — this file covers only
what is specific to working on it as an agent.

## Everything goes through a pull request

Branch off `beta`, open a PR, let it be reviewed. No direct pushes for a one-line
fix, a docs typo, or to unblock CI. See
[Branching](docs/contributing.md#branching) for the rest of the rules, including
force-push and merge approval.

The exception is release automation, which commits the version bump and tag to
`beta` and `main` by design — that is the workflow's job, not yours.

## Review before opening the PR, not after

Three passes, looking for different things:

| Pass | Looks for |
|---|---|
| Correctness | bugs, edge cases, broken invariants |
| Simplification | reuse, duplication, over-complication, wrong altitude |
| Whole-PR review | anything the first two missed, once the diff is final |

In this workspace those are the `code-review`, `code-simplifier` and
`pr-review-toolkit` plugins — **personally installed, not committed here**, so a
fresh clone will not have them. Run the equivalent passes however you can.

Act on what they find before asking for a human's time. If you disagree with a
finding, say why; do not silently skip it.

## Verify before you claim

Run the checks in [Before you open a PR](docs/contributing.md#before-you-open-a-pr)
and read the output in this session. A green CI badge on an older commit is not
evidence about this one, and "the build succeeded" is not evidence that the
feature works.

For UI work, drive the real thing. A control that renders is not a control that
does anything — a `+ row` button once shipped adding a row the same code filtered
straight back out.

## When something breaks in production

Get evidence before forming a theory. The server exposes read-only diagnostics —
`/api/version`, `/api/log`, `/api/events` (see
[API](docs/reference/api.md)). The SSE hello burst is a full state snapshot, so
polling it twice shows what is advancing and what is frozen.

`/api/log` is token-gated when `STAGE_UTILITY_LOG_TOKEN` is set. A 401 there means
you need the token, not that the server is down.

Two traps that have cost real time:

- `[last-update]` log lines are a **replayed older log**, out of chronological
  order — filter by full date, never time-of-day. See
  [Updates and logs](docs/ops/updates-and-logs.md).
- `grep | head` exits 0 whatever grep found. Never use it to prove absence.

## Time, and other things that are not local

Servers run UTC. Anything asking "what day is it" or "is it 3am yet" goes through
the app time zone (`main/services/app-timezone.ts`), never the host clock — a UTC
box rolls its date at 19:00 in Chicago, which once stopped every recorder
mid-service.

Recording a live service is deliberately independent of the clock: while Planning
Center reports a service live, nothing time-based may stop it.

## Data that outlives a release

Every new persisted store goes in `CONFIG_FILES` (operator's work, restore it) or
`RUNTIME_FILES` (observations, do not) in the same change — a drift test fails
otherwise.

Do not delete an operator's data to tidy something up. Log it, or offer an
explicit action, and let them choose.
