# Display URLs

Every address the server answers on: the screens, and the operator pages they
must not collide with. What those operator pages do is
[The operator app](features/operator-app.md).

## Permanent addresses

A display is reached at `/<id>` — `/display-1`, `/display-2`. That id is assigned
once and never changes. Slot configuration is keyed by it, and Raspberry Pis,
bookmarks and printed QR codes point at it, so it stays stable.

Nor is an id ever handed out twice: deleting a display retires its id for good, so
a new one created afterwards cannot inherit the old one's slots or answer a
bookmark meant for it. View ids work the same way.

## Friendly URLs

A display can also carry a **slug**: set `left-mic` on `display-1` and `/left-mic`
reaches the same screen. Both addresses work.

It is an alias, not a rename — the id keeps working, and clearing a slug only
removes the alias. Nothing is rekeyed, so nothing is lost.

Slugs are rejected, with the reason shown on the card, if they are reserved, start
with `preview-`, collide with another display's id or slug, or contain anything
outside `a-z`, `0-9` and `-`.

Reserved: the empty path, `settings`, `log`, `logs`, `photos`, `enroll`, and every
operator page below — `history`, `baptism`, `patch`, `scriptview`, `automation`,
`plan`, `screens`, `consoles`, `views`, `displays` — plus the `preview-` prefix.
These are pages in their own right: a display slugged `history` would render the
History page rather than the display.

The reserved list is derived from the app's own route table rather than written
out a second time, so a page added to the app is reserved the moment it is
routed.

Slugs are re-checked at every start, not only when they are saved. When an update
claims a path a display was already using — `/logs` became the log viewer's second
spelling — that display is moved aside rather than left shadowed: `logs` becomes
`logs-2`, and a `[slug-migration]` line on [`/log`](ops/updates-and-logs.md) names
the screen, the old URL and the new one. The `/<id>` address is untouched, so a Pi,
a bookmark or a printed QR pointed at it keeps working, and the new alias is what
the screen's card shows.

Where both exist, the id wins, so a display is always reachable at its permanent
address.

## Operator pages

These render in the operator app: one page with a sidebar and the live service
[context bar](features/context-bar.md), rather than separate chrome-free pages.
They follow the light/dark theme, unlike the always-dark display URLs above.

| URL | What it is |
| --- | --- |
| `/` | Home |
| `/screens` | Screens and the views they show |
| `/scriptview/manage` | Rundown launcher |
| `/patch` | This week's stage patch, for volunteers |
| `/automation` | Automation rules |
| `/plan` | Which service and plan this machine follows |
| `/history` | Service history, timing and attendance — read-only |
| `/baptism` | Baptism operator |
| `/settings/integrations` | Connected devices and services |
| `/settings/branding` | App name, logos, accent colour |
| `/settings/advanced` | Updates, network, backups, kiosk devices |

Plus the pages reached from those: `/screens/<view id>/edit` (the layout
editor), `/consoles/<view id>` (a console you built), `/patch/edit`,
`/scriptview/presets`, `/scriptview/<service type>/<layout>`, and
`/history/manage`.

Moving between them does not reload the page, so the event stream and cached
plan data survive a navigation.

`/log` is not one of them. It is a plain page the server renders itself — an
operator diagnostic rather than a destination, reachable from
**Settings → Advanced → Open log**, and gated behind a token when one is set. It
also answers on `/logs`, which redirects to `/log` with the query string intact;
both spellings are reserved, so neither can be taken as a display slug. `/log`
is canonical — it is what the app links to and what these docs quote.

`/settings` on its own lands on Integrations. `/views` and `/displays` redirect
to `/screens`, and the old `#hash` deep links into the settings window resolve
to their new routes — bookmarks and printed links keep working.

`/history` is **read-only**: it is a link handed to people outside Production, so
it shows the record without the controls that change it. It also renders without
the app's sidebar and header — just the record and its own "History" heading — so
the link shows nothing else of the app. The operator's own history — edit
recorded times, merge a split service, delete one — is `/history/manage`, in the
sidebar under Services, with the app's usual chrome.

`/scriptview` works the same way: the rundown launcher with its own "ScriptView"
heading and no sidebar or header, for a stage tablet or a producer's second
screen, and each rundown under it, `/scriptview/<service type>/<layout>`, is the
whole window. The operator's copy of the launcher is `/scriptview/manage`, in the
sidebar under Content, with the app's usual chrome; `/scriptview/presets`, which
edits layouts, keeps the chrome too.

## Polling transport

Append `?transport=poll` to any Stage Utility URL — a display, a console, an
operator page — and that page collects updates with one small request every two
seconds instead of holding the `/api/events` stream open. It receives the same
channels, in the same order, starting from the same connect-time snapshot, so
nothing renders differently.

Use it for an embedded browser that buffers or drops a long-lived response. The
Ross Ultritouch's fallback browser is the case it was built for: it holds the
event stream and releases a minute's worth of frames at once, so the panel shows
a minute-old service. See [Ultritouch](integrations/ultritouch.md).

Clocks and countdowns stay right on this transport. Each poll response carries
the server's clock stamped as it is sent, and the page places the server against
its own monotonic clock using half the round trip it just measured — so a frame
that waited two seconds in the buffer costs nothing, and the page never reads
the host's wall clock at all.

The cost is one HTTP request per client every two seconds — about 43,000 a day
against a stream's one connection — plus up to two seconds of latency on every
update. A held stream is cheaper and immediate, so this is opt-in per URL and
never sticky: drop the query string and the page is back on the stream.

A failing poll backs off, doubling to a 20 second ceiling, and returns to two
seconds on the first success. The ceiling is deliberately under the server's 30
second client expiry, so a backed-off client is not dropped from the registry
every cycle. A page brought back into view polls immediately rather than waiting
out the rest of its interval.

The server names polling clients on [`/log`](ops/updates-and-logs.md):

```
[events] poll client 1cef964f-8175-4b73-bc5e-693de5785d9f started
[events] poll client 1cef964f-8175-4b73-bc5e-693de5785d9f expired (no poll for 30s)
```

A client that has not polled for 30 seconds is treated as gone, and any producer
that only runs while something is watching stands down with it — the same
accounting an open stream gets. Open streams are named too, as
`[events] stream client connected (3 streams)`.

## QR codes

A QR encodes the `/<id>` address and never a slug, since a printed code outlives
the session it was made in. Codes are for screens you mount; the operator pages
above are links you send someone, so they have none.

Turning the connect QR on and off is **Settings → Branding → Show connect QR on
displays**, and it is global rather than per screen.

## Icon colors

Every display icon can be retinted by clicking it on the Screens page. The colour
and the glyph are stored under one key, so a change made in one place shows
everywhere the same thing is drawn. That key is the **view id** for a screen
showing a control surface — the Screens card and the console's sidebar tab are one
icon between them — and the **display id** for every other screen.

A colour or glyph set before that key moved is still read off the display id, and
moves onto the current key the next time you change it.

Untinted icons use the theme accent. Clearing a color returns it to that default.
