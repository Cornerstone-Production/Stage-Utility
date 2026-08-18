# Telling the operator about updates

**Goal.** Three things, each shown once and never nagged:

1. a toast, bottom right, when an update becomes available;
2. a dot on the Advanced nav icon while one is available;
3. a dialog in the middle of the screen, after a successful update, showing the
   version and its release notes.

**Mockup:** https://claude.ai/code/artifact/8d84782a-dd78-46e9-b788-589580c7f7d5

**Why.** Today an update is only discoverable by opening Advanced and reading a
panel. Nothing tells you a release exists, and nothing tells you what changed
after you took one.

## What already exists

The `update:status` SSE channel (`renderer/lib/sse-channels.ts`) already carries
the whole `UpdateStatus` — `releasesBehind`, `behindUserFacing`, `targetTag`,
`changelog`, `latestDate` — broadcast on every change and re-sent on connect. So
availability is already streamed; none of this needs polling.

"An update is available" is currently decided in one place,
`advanced-section.tsx`: `tagBased ? releasesBehind : behindUserFacing`. Three
consumers now need that answer, so it becomes a shared function rather than a
third copy of the expression.

## Three gaps this has to close first

**The notes for the version you just installed are not kept.** `status.changelog`
lives only in memory, so after the restart it describes the *next* pending
update. A dialog reading it would show the wrong notes. The updater must snapshot
the changelog and the version it is leaving **before** applying, and persist that
across the restart.

**The grouping is thrown away.** `changeLinesFrom()` keeps only bullets under
`## New|Fixed|Changed|Improved|Breaking` and flattens them into one unlabelled
list, discarding the raw body. Notes grouped by category require it to keep the
section each bullet came from. The 20-line cap also goes up: a release dialog is
read once, not glanced at.

**Only the tab that pressed Update knows an update happened.** The current
handshake is `sessionStorage` in that one browser. A box updated by the hourly
auto-apply, or the app open on a second machine, sees nothing. The record moves
server-side.

A smaller one: the rail fetches update status **once on mount** rather than
subscribing, so a dot there would be stale until reload — as the version label it
already shows also is. The rail moves onto the existing query/SSE path.

## Where the state lives

A new store, `update-notices.json`, classified **runtime**:

```ts
{
  /** The tag we have already announced. Null until something is announced. */
  announcedTag: string | null;
  /** Set when an update completes; cleared when the operator dismisses the
   *  dialog. Null the rest of the time. */
  justUpdated: {
    version: string;
    fromVersion: string | null;
    notes: { section: string; lines: string[] }[];
    at: string;
  } | null;
}
```

Runtime, not config, because it is an observation rather than the operator's
work: a config snapshot restored from last month must not re-announce a version
or suppress one. The updater's existing marker files (`update-track`,
`update-restart-pending`) are bare `writeFileSync` calls that bypass the store
registry; this does not copy that.

## 1. The toast

Fired when the available tag differs from `announcedTag`.

**The announcement is spent only when it is actually delivered.** Marking it at
detection time means an update found at 3am, with nobody connected, is never
announced at all. So the server marks `announcedTag` only once the toast has gone
to at least one connected client — which is what makes "once" mean once *seen*
rather than once *computed*.

Wording names the version and what to do: `Stage Utility 1.12.0 is available —
Advanced to install`. It uses the existing toast, bottom right, 4-second
auto-dismiss.

The existing "N updates available" toast on a **manual** check stays. That one
is a direct answer to a button press and should fire every time, announced or
not.

## 2. The dot

A small accent dot on the Advanced row in the rail, present exactly while an
update is available — driven by the same shared predicate, not by whether the
toast fired.

`SidebarListItem` already renders `{children}`, which is the extension point; no
badge exists on any nav item today, so this adds one. It must work in the
collapsed rail, where the label is `sr-only` and the row is a tooltip target —
the dot is the only visible signal there, so it cannot hang off the text.

The dot is decoration; the accessible name carries the meaning, so the row reads
as "Advanced, update available" rather than leaving a screen reader with a dot it
cannot describe.

## 3. The post-update dialog

Shown once after any successful update, **including one applied automatically** —
that is the case the current handshake misses entirely, and the one where you did
not watch it happen.

It shows the version installed, and the notes grouped by section:

```
Updated to 1.12.0
  Breaking    …
  New         …
  Fixed       …
```

Dismiss is an explicit button. Dismissing clears `justUpdated`, so it never
appears again for that version. Nothing else clears it: not a reload, not a
navigation. If the operator closes the tab without dismissing, it is waiting next
time — which is the point of recording it server-side.

**With no notes it still says something.** A version that produced no usable
lines shows "Updated to 1.12.0" and nothing else. An empty dialog reads as
broken; a short one reads as a quiet release.

## Testing

The pure parts — the availability predicate, section-preserving parsing — are
tested as functions. Beyond that:

- A status where an update is available, with no client connected, leaves
  `announcedTag` unchanged; connecting a client then announces it exactly once.
  This is the whole point of delivery-time marking, so it is proven rather than
  assumed.
- A second client connecting after an announcement does not re-toast.
- A release body with `## Breaking` and `## Fixed` sections parses into two
  groups with their lines intact, and a body with no recognised sections yields
  no groups rather than one unlabelled blob.
- The dot appears and disappears with availability, in both expanded and
  collapsed rail, and the row's accessible name says why.
- `justUpdated` survives a restart: written before the apply, read after, and
  cleared only by dismissal. Verified against a real server rather than by
  unit-testing the store, because "it looked saved until the next restart" is a
  failure this repository has already had.
- An update applied without any browser open still shows the dialog to the next
  client that connects.
