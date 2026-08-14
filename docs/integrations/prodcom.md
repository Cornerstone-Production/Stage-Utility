# ProdCom integration

Subscribes to ProdCom's live production transcription feed and surfaces it on the
dashboard's captions display and on a custom-layout **transcription strip**
object.

## How it works

ProdCom (prodcom.io) exposes an HTTP Application API (default port 24480) with a
purpose-built transcript SSE stream. `prodcom-service.ts` holds one long-lived
connection to `GET /api/v1/transcript/stream`, normalises each event into a
`TranscriptLineDTO`, keeps a rolling buffer (up to 100 lines), and re-broadcasts
on the `prodcom:transcript` channel. It reconnects (~4 s) if the stream drops.

A dropped cable or a switch port going down leaves the socket half-open — no
close arrives, so nothing would notice. TCP keepalive probes the box every 30s
once the stream is quiet and reconnects when it stops answering, which is why a
silent room does not trip it: a live box answers the probe whether or not anyone
is speaking.

Transcript field names aren't in ProdCom's public docs, so `normalizeLine()`
parses defensively — trying several likely field names, degrading to raw text,
and never throwing. Interim partials (many per second while someone speaks) are
coalesced into at most one broadcast per ~250 ms; final lines push immediately.
Per-speaker channel colors flow through so the captions feed can label and tint
each speaker.

Testing the integration reaches the ProdCom host/port; the API Key is only sent
when ProdCom's "Require Authentication" is on. The key is stored encrypted
(secret key `apiKey`).

## Setup

**In ProdCom:** enable the **Application API** in ProdCom's settings and note the
**port** (default 24480). If you turn on **Require Authentication**, copy the
**API key** from those settings.

**In Stage:** Settings → Integrations → **ProdCom** → enter the **Host** (IP),
**API Port**, and (only if required) the **API Key**, enable it, and **Test
connection**.

**On a layout:** add object → **transcription strip**. Options: latest-line vs.
multi-speaker scrolling feed, max lines, and hide specific channels by name.
