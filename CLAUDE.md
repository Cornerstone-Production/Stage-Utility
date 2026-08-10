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

Drive the real server for anything that holds state. Unit tests over the helpers
are not enough: a wireless password that could not be cleared, and a baptism
restore that the next append deleted, both had green tests over the pieces and a
broken path through them. Kill a test server by **port**, never `pkill -f` on an
env-var prefix — the prefix is not in the process command line, so the old server
survives and the next run tests stale code.

## Fixing a repeated pattern

Before committing a fix to something that appears more than once, grep for every
instance and fix them together. Say in the commit how many you found and how many
you changed.

This is the most expensive recurring mistake in this repo. The `endedAt` guard
lived in one of three recorders; `.catch` in one of four; `safe()` was applied on
write but not on read; the SSE buffer cap was in one of two identical parsers; a
timeout was on `test()` but not the long-lived stream. Each was fixed once, alone,
and the copies drifted on.

If the same shape exists in three places, prefer removing the duplication over
fixing it three times.

## A guard must fail on the bug it guards

Any test written to catch a class of bug ships with proof: delete the guard, or
reintroduce the bug, and watch the test go red in this session. Say so in the
commit.

Guards written here have repeatedly passed on the exact defect they were added
for:

- a channel scan matched only literal `invoke("…")`, missing ~90 call sites that
  go through a local `ipc()` wrapper — the panels where the bug lived
- a route-coverage scan matched raw file text, so a **comment** naming the broken
  path satisfied it; stripping comments then swallowed real code and hid a route
  that exists
- a telemetry-parity check matched source text, so an interface declaring the
  field satisfied it, and deleting the line that assigns the value left it green
- a store-classification scan used a regex that could not cross a `>`, so it found
  22 of 23 stores and was green by luck

Prefer a check the type system enforces, or one that runs the real code path, over
one that reads source text. If it must read source: walk the tree recursively,
match on something prose cannot satisfy (an assignment, not a bare constructor
name), and assert an EXACT count rather than a floor — a floor with slack is how
three config stores went missing from every backup with the suite green.

## Do not swallow a failure

A new `catch` either rethrows or returns the failure to its caller. A `catch` that
only logs is how an archive import reported success having written nothing, and
how a failed save read as saved until the next restart lost the work.

A function that can partially fail returns what failed; the caller decides what to
tell the operator.

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

Every persisted store declares itself as the operator's work (`"config"` —
restore it) or an observation (`"runtime"` — do not) in its constructor. The type
checker will not let you skip it, and `config-snapshot.test.ts` fails if the
store is never imported, or lands in the wrong half.

Do not delete an operator's data to tidy something up. Log it, or offer an
explicit action, and let them choose.
