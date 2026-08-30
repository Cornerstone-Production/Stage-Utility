# Display URLs and tool links

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

Reserved: `settings`, `log`, `photos`, `baptism`, `history`, `patch`, `scriptview`,
the empty path, and the `preview-` prefix. These are pages in their own right — a
display slugged `history` would render the History page rather than the display.

Where both exist, the id wins, so a display is always reachable at its permanent
address.

## Operator surfaces

These render in the operator app: one page with navigation and a live service
context bar, rather than the separate chrome-free pages they used to be. They
follow the light/dark theme, unlike the always-dark display URLs above.

| URL | What it is |
| --- | --- |
| `/history` | Service history, timing and attendance — read-only |
| `/patch` | This week's stage patch, for volunteers |
| `/scriptview` | Rundown viewer |
| `/baptism` | Baptism operator |
| `/automation` | Automation rules |
| `/integrations` | Connected devices and services |

Moving between them does not reload the page, so the event stream and cached
plan data survive a navigation.

`/settings` remains its own page for now.

`/history` is **read-only**: it is a link handed to people outside Production, so
it shows the record without the controls that change it. The operator's own
history — edit recorded times, merge a split service, delete one — is
`/history/manage`, in the rail under Services.

## Tool links

The tool pages — `/baptism`, `/patch`, `/scriptview`, `/history`, `/log` — are
listed under **Settings → Connect → Tools**, with the same copy-to-clipboard
treatment display links get.

The display picker at `/` tiles `/scriptview`, `/baptism`, `/patch` and `/history`.
`/log` is deliberately not there — it is an operator diagnostic, not a volunteer
destination.

Tools have no QR codes of their own; they are links you send someone rather than
codes you print and mount. Where a QR does appear it encodes the `/<id>` address
and never a slug, since a printed code outlives the session it was made in.

They are not on the Displays tab, which answers a different question: which view a
physical screen shows.

## Icon colors

Every display icon can be retinted by clicking it on the Screens page. Colors are
keyed to the display id, so a colour set in one place shows everywhere including
the picker.

Untinted icons use the theme accent. Clearing a color returns it to that default.
