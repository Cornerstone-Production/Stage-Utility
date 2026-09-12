# ProdCom integration

Subscribes to ProdCom's live production transcription feed and surfaces it on the
dashboard's captions display and on a custom-layout **transcription strip**
object.

## How it works

ProdCom (prodcom.io) exposes an HTTP Application API (default port 24480) and
publishes its own specification: `GET /api/v1/openapi.yaml`, rendered at `/docs`
on the box. Field names here come from that document, not from guesswork.

`prodcom-service.ts` holds one long-lived connection to
`GET /api/v1/transcript/stream`, normalises each event into a
`TranscriptLineDTO`, keeps a rolling buffer (up to 100 lines from the last four
hours), and re-broadcasts on the `prodcom:transcript` channel. It reconnects
(~4 s) if the stream drops.

On (re)connect the app primes itself from two REST reads, in this order:

- `GET /api/v1/channels` for each channel's name and colour, keyed by channel id
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

A dropped cable or a switch port going down leaves the socket half-open — no
close arrives, so nothing would notice. TCP keepalive probes the box every 30s
once the stream is quiet and reconnects when it stops answering, which is why a
silent room does not trip it: a live box answers the probe whether or not anyone
is speaking. A box that answers TCP while its application has stopped producing
is caught by a 15-minute data-silence timer.

### Diagnostics

Interim partials (many per second while someone speaks) are coalesced into at
most one broadcast per ~250 ms; final lines push immediately. An in-progress line
(a partial) is held per channel until its final arrives, or for 30 seconds after
it last changed; an unchanged re-send from ProdCom does not reset that clock, and
a sweep every five seconds clears a stale partial even when nobody else speaks.

The `/log` page has the evidence when something looks wrong:

- `[prodcom] backfill: N line(s) over P page(s)`, and
  `[prodcom] backfill failed after P page(s) (…)` when a page did not answer
- `[prodcom] backfill skipped N line(s) older than 4h`
- `[prodcom] channel list unavailable (…)` when colours could not be read
- `[prodcom] not captioning "typed" entries — they are not spoken audio`
- `[prodcom] no transcript data for 900s — treating the stream as dead`
- `[prodcom] partial on channel … in progress for Ns` at one minute and every
  five after, `[prodcom] final on channel … with no partial in flight` when a
  final lands on a channel that has no partial while others do (the renamed
  channel case), and `[prodcom] transcript cleared by operator` naming every live
  partial and its age when the clear button is pressed

Text is never logged, only its length. `PRODCOM_DEBUG=1` logs every raw frame
verbatim.

## Setup

**In ProdCom:** enable the **Application API** in ProdCom's settings and note the
**port** (default 24480). If you turn on **Require Authentication**, copy the
**API key** from those settings.

**In Stage:** Settings → Integrations → **ProdCom** → enter the **Host** (IP),
**API Port**, and (only if required) the **API Key**, enable it, and **Test
connection** — which reads `GET /api/v1/status` and reports the version and
channel count. The key is stored encrypted (secret key `apiKey`).

**On a layout:** add object → **transcription strip**. Options: latest-line vs.
multi-speaker scrolling feed, max lines, and hide specific channels by name.

## Known gap: sensitive keywords are not redacted

ProdCom keywords carry an `isSensitive` flag, and ProdCom replaces matched text
with asterisks in its own interface. This app renders the transcript raw, so a
word redacted on the operator's screen still reaches a stage or lobby display in
full. Nothing here reads the keyword list yet.
