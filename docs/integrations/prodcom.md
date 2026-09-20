# ProdCom integration

Subscribes to ProdCom's live production transcription feed and surfaces it on the
dashboard's captions display and on a custom-layout **transcription strip**
object.

## How it works

ProdCom (prodcom.io) exposes an HTTP + WebSocket Application API (default port
24480) and publishes its own specification: `GET /api/v1/openapi.yaml`, rendered
at `/docs` on the box. Field names here come from that document, not from
guesswork.

`prodcom-service.ts` holds one WebSocket to `GET /api/v1/ws`, subscribes to the
`transcript` stream, normalises each entry into a `TranscriptLineDTO`, keeps a
rolling buffer (up to 100 lines from the last four hours), and re-broadcasts on
the `prodcom:transcript` channel.

It reconnects 4 s after a connection drops, then doubles that for each further
failure in a row, clamped by the service window the way every other integration
is — so a box that is off all week is not dialled every four seconds all week.
Any connection that comes up resets the ramp, so a drop mid-service is always
retried in about four seconds.

ProdCom sends a `{"type":"ping"}` heartbeat over that socket every 30 seconds
whether or not anyone is speaking, and the app answers it. Three missed
heartbeats (90 s of total silence) means the box is gone, not that the room is
quiet, so the connection is dropped and reopened.

A heartbeat proves the box is alive; it does not prove the subscription is
delivering. See [A socket that carries nothing](#a-socket-that-carries-nothing)
for the check that covers the difference.

On (re)connect the app primes itself from REST, in this order:

- `GET /api/v1/channels` for each channel's name and colour, keyed by channel id
- `GET /api/v1/keywords` and `GET /api/v1/channels/{id}/keywords` for the words
  ProdCom marks sensitive (see [Sensitive keywords](#sensitive-keywords))
- `GET /api/v1/transcript?since=…&limit=200&offset=…` for the transcript so far

That transcript endpoint is paginated, mandatorily so, and ascending from the
oldest entry the box still holds — often several days back. `since` narrows it to
the same four-hour horizon the buffer keeps, and the app walks every page
`hasMore` reports, up to 20 pages. **`since` must be whole seconds**
(`2026-09-11T08:00:00Z`); ProdCom 2.3.2 silently ignores a timestamp carrying
milliseconds and answers with its entire history from the oldest row.

This is live captions, not history — a finalised line older than four hours is
dropped from the buffer even if fewer than 100 lines have arrived since, and rows
older than that horizon are skipped on backfill even when the server returned
them. So a reconnect cannot re-import a service from days ago just because
ProdCom's own history still holds it.

Only entries whose `source` is `audio` become captions. A message an operator
typed into a comms channel (`typed`) and a line ProdCom's own automations
produced (`automation`) are skipped and logged once per kind per connection —
they are not something somebody said, and a stage or lobby wall is not where they
belong.

Per-speaker colour comes from the channel list, not from the transcript entry: a
transcript entry has no colour field. The channel record is also the current
name, so a channel renamed mid-service is labelled correctly; where no channel
record is available the entry's own denormalised `channelName` is used and the
display picks its own colour.

If a key is required, it is sent as `Authorization: Bearer <key>` — the one
security scheme the specification declares.

### A socket that carries nothing

A ProdCom build can accept the upgrade, list the transcript stream in its welcome
frame, answer every heartbeat, and then deliver no transcript entry at all — while
`GET /api/v1/transcript` goes on returning the same lines. Nothing about the
connection looks wrong from the client's side, so without a specific check the
captions display simply stays empty and the integration card reads connected.

While the WebSocket is the live transport and has delivered **no** transcript
entry, the app asks REST one question at the one-minute mark: has ProdCom
recorded any `source: audio` entries beyond the ones it already held when this
socket opened? Typed and automation entries do not count — they never become
captions, so a socket that did not deliver one has missed nothing.

The question is asked as a **row count**, not as a time. On connect the app reads
`meta.totalCount` from `GET /api/v1/transcript`, and the check then reads the
rows past that offset. No timestamp is compared on either side, because a ProdCom
is an appliance whose clock is its own: a box running fast would answer "yes" for
lines spoken before the socket ever opened and get a healthy connection torn
down, and a box running slow would answer "no" for ever and hide the very failure
this check exists to catch. A row count has neither failure — ProdCom's
transcript is append-only and ascending from the oldest entry, so rows beyond the
baseline are exactly the rows added since.

If the count cannot be read the check does nothing at all for that connection,
and says so on connect.

- **Nothing spoken** — nothing was missed. The question is asked again a minute
  later.
- **REST could not be asked** — nothing happens, and the log says so. "No lines"
  and "could not ask" are not the same answer, and acting on the second is how a
  transport that is working gets torn down.
- **Lines the socket never delivered** — the socket is reopened **without** the
  `subscribe` frame, on the theory that ProdCom's own subscription filter is what
  swallowed them. If that socket then delivers, captions stay on the WebSocket
  and the log records which subscription worked.
- **Silent both ways** — captions move to the SSE fallback, and the integration
  card says `Fallback stream — the websocket carried no transcript` rather than
  claiming a healthy socket.

The first transcript entry over a socket ends the check for that connection: a
socket that is carrying the transcript is never asked again and costs no further
REST calls.

### The SSE fallback

If the WebSocket will not come up, the app falls back to the older
`GET /api/v1/transcript/stream` and keeps offering the WebSocket again: every
third reconnect, and every five minutes whether or not anything reconnects. Both
rules are needed. The counter handles a box that is dropping the fallback anyway;
the timer handles a fallback that is up and quiet, which never reconnects and so
never counts — a ProdCom that has been restarted and would now upgrade is picked
up within five minutes rather than at the next restart of this server.

The timer's attempt is made **beside** the live stream, not in place of it. If
the WebSocket opens, the fallback is dropped and the app switches to it; if it
does not, the fallback is untouched and nothing else happens — no reconnect, no
re-read of channels or keywords, no backfill, and no second refusal diagnosis.
So a box that genuinely has no WebSocket costs one refused upgrade every five
minutes and nothing more.

Both rules widen — to every 20 reconnects and every 30 minutes — once a box has
been shown to [accept a socket and carry nothing on
it](#a-socket-that-carries-nothing). A refused upgrade is free, by the paragraph
above; a socket that *opens* is not, because opening it drops the fallback and it
is then given a minute to prove itself. On such a box the re-test is on
probation: it must deliver a transcript entry within that minute or captions go
straight back to the fallback, with no REST call, because the question has
already been answered for this box. The card reads `Re-testing the websocket that
carried no transcript` while that minute runs, and no recovery is announced until
a transcript entry actually arrives. A re-test that does deliver clears the
verdict and keeps the socket.

Everything the app learns about a box's WebSocket is forgotten when the
integration is reconfigured or re-enabled, so an upgraded or replaced ProdCom
gets a clean first attempt with the documented `subscribe` frame.

That stream sends no keepalive of any kind, so on that path a dropped cable is
caught by TCP keepalive probing the box every 30 s, and a box
that answers TCP while its application has stopped is caught by a 15-minute
data-silence timer — which cannot tell a dead box from a quiet evening, and is
the reason the WebSocket is preferred.

### Diagnostics

Interim partials (many per second while someone speaks) are coalesced into at
most one broadcast per ~250 ms; final lines push immediately. An in-progress line
(a partial) is held per channel until its final arrives, or for 30 seconds after
it last changed; an unchanged re-send from ProdCom does not reset that clock, and
a sweep every five seconds clears a stale partial even when nobody else speaks.

The `/log` page has the evidence when something looks wrong:

- `[prodcom] websocket open — streams offered: …` on every connection
- `[prodcom] no websocket frame for 90s — heartbeat missed …` when the box goes
- `[prodcom] websocket delivered no transcript in 60s while ProdCom has at least
  N spoken line(s) since it opened — reopening it without the subscribe frame`,
  and then either `[prodcom] the websocket delivers the transcript with no
  subscribe frame sent …` when that works, or `[prodcom] websocket delivered no
  transcript with or without the subscribe frame …` naming the new retry cadence
  when it does not. `[prodcom] the websocket has carried no transcript in 60s and
  this box has failed that test before …` is a later re-test being dropped, and
  `[prodcom] the websocket is carrying the transcript again …` is one that came
  good. `[prodcom] could not read the transcript row count (…)` on connect means
  this connection has no baseline and the check will not run at all for it.
  `[prodcom] could not check whether the websocket is missing transcript
  lines (…)` means REST did not answer and nothing was changed. The
  "nothing was said, so nothing was missed" case is `console.debug`, so it is in
  the terminal and deliberately not on `/log`
- `[prodcom] websocket unavailable (…) — falling back to the transcript SSE stream`
  once per outage, not once per retry, with a reminder carrying the attempt count
  every 15 minutes while it lasts, and `[prodcom] websocket is back …` when it
  recovers. The per-retry "retrying the websocket after N SSE reconnect(s)" is
  `console.debug`, so it is in the terminal but deliberately not on `/log`. The
  five-minute retry logs nothing at all: it neither drops the stream nor counts a
  reconnect, so there is nothing for it to report until it succeeds, and then
  `websocket is back` says so.

  The reason in that line names the HTTP status the handshake was refused with.
  Node's WebSocket exposes no status for a refused upgrade — a 426, a 401 and a
  missing route all arrive as close code 1006 — so the same URL is asked once
  over plain HTTP before the fallback opens. That probe is bounded: 4 s of socket
  silence, and a 6-second wall-clock deadline that a box answering with an
  endless body cannot push back. If it runs out, the fallback opens on the bare
  close reason rather than waiting:

  | Reason | Means |
  |---|---|
  | `upgrade refused with HTTP 426 (Upgrade Required)` | the box answered, and said no — the WebSocket API is off or the build is too old |
  | `upgrade refused with HTTP 401 (Unauthorized)` | the key is wrong or missing |
  | `upgrade accepted by a probe but the WebSocket closed before open (code 1006)` | the handshake is fine; the socket is dying after it |
  | `probe failed: …` | the box could not be reached at all |

  Where a refusal carried a body, its first 200 bytes follow as
  `— the box said: …`.
- `[prodcom] backfill: N line(s) over P page(s)`, and
  `[prodcom] backfill failed after P page(s) (…)` when a page did not answer
- `[prodcom] backfill skipped N line(s) older than 4h`
- `[prodcom] channel list unavailable (…)` when colours could not be read
- `[prodcom] keywords loaded: N global (M sensitive), …` on a change, and
  `[prodcom] hiding text that matches a keyword marked sensitive …` once per
  connection the first time anything is actually hidden
- `[prodcom] keyword list unavailable (…)`, saying whether earlier keywords are
  still being applied or nothing is being hidden at all
- `[prodcom] sensitive-keyword redaction turned OFF …` when the setting moves
- `[prodcom] not captioning "typed" entries — they are not spoken audio`
- `[prodcom] partial on channel … in progress for Ns` at one minute and every
  five after, `[prodcom] final on channel … with no partial in flight` when a
  final lands on a channel that has no partial while others do (the renamed
  channel case), and `[prodcom] transcript cleared by operator` naming every live
  partial and its age when the clear button is pressed

Text is never logged, only its length, and neither is any keyword — only counts.
`PRODCOM_DEBUG=1` logs every raw WebSocket and SSE frame verbatim, which is how
to capture the shape of a live transcript event; it prints transcript text that
would otherwise be redacted, so leave it off outside a debugging session.

## Setup

**In ProdCom:** enable the **Application API** in ProdCom's settings and note the
**port** (default 24480). If you turn on **Require Authentication**, copy the
**API key** from those settings.

**In Stage:** Settings → Integrations → **ProdCom** → enter the **Host** (IP),
**API Port**, and (only if required) the **API Key**, enable it, and **Test
connection** — which reads `GET /api/v1/status` and reports the version and
channel count. The key is stored encrypted (secret key `apiKey`). **Hide
sensitive keywords** is on by default; see
[Sensitive keywords](#sensitive-keywords).

**On a layout:** add object → **transcription strip**. Options: latest-line vs.
multi-speaker scrolling feed, max lines, and hide specific channels by name.

## Sensitive keywords

ProdCom keywords carry an `isSensitive` flag, and ProdCom replaces matched text
with asterisks in its own interface. This app does the same before a line reaches
any display, so a word hidden on the operator's screen is not shown in full on a
stage or lobby wall.

**Matching is ProdCom's, from its own specification.** A keyword's `text` is a
case-insensitive **substring** — `cast` matches inside `broadcast` — and each
matched character becomes one asterisk, so the line keeps its length. Global
keywords apply on every channel; a keyword scoped to a channel applies only
there. A keyword that is not marked sensitive is ProdCom's own highlight and is
never hidden here.

Keywords are read on connect and on the same throttled refresh as the channel
list: `GET /api/v1/keywords` for the global ones, and
`GET /api/v1/channels/{id}/keywords` per channel. Where a build embeds a
`keywords` array in the channel record itself, that is used and the per-channel
request is skipped.

**The keyword list never leaves the server.** Matching happens server-side, not in
the browser, because a list of flagged words is as sensitive as the transcript
that contains them — the words are never broadcast, never written to a config
export, and never logged. Only counts appear on `/log`.

**The buffer keeps the original.** Redaction happens on the way out, so nothing
is destroyed: a redacted line carries `redactions`, the number of hidden runs,
and the full text stays readable at `GET /api/prodcom/transcript/raw`. That route
is gated by `STAGE_UTILITY_LOG_TOKEN` in exactly the way `/log` is — unset means
open, set means `?token=…` or a `401`.

If the keyword read fails, whatever was loaded before stays loaded and is still
applied; a transient failure mid-service does not un-redact the displays. On a
connection where nothing has ever loaded, nothing is hidden, and the log says so.

**Three consequences worth knowing.** A `prodcom.phrase-said` automation trigger
reads the same broadcast the displays do, so a phrase that is also a sensitive
keyword stops matching while redaction is on. `PRODCOM_DEBUG=1` prints every raw
frame verbatim, transcript text included — it is a debugging escape hatch, not
something to leave on. And matching is over whole text, so while a line is still
in progress a partly-recognised keyword can show its first few letters for a
moment before the word completes and is hidden; ProdCom's own live view behaves
the same way.

**Turning it off.** Settings → Integrations → **ProdCom** → **Hide sensitive
keywords**. On by default. Off sends the transcript in full to every display; it
does not change ProdCom's own redaction, and it never edits your keywords.
