# Resi

Shows whether Resi is streaming — in the context bar, on Home, and as a layout
object on any screen, the same places the recording widgets appear.

## What it needs

**Settings → Integrations → Resi**

| Field | |
|---|---|
| Resi Email | your Resi account sign-in |
| Resi Password | stored encrypted, like every other credential here |
| Encoders to watch | optional; blank watches all of them |

## Why it wants an account login

Resi publishes a "Go Live API" that takes a scoped client id and secret. It
cannot answer this question. That API has no way to list active streams — the
only way to get a stream's id is to be the thing that started it — so it can
report on a stream Stage Utility began and nothing else. If your Resi goes live
on a Resi schedule, it is invisible to that API. There are no webhooks either.

The endpoint that *can* answer reports encoder state, which is true whoever
started the stream. It is part of Resi's own web app rather than their published
API, and it takes an account sign-in because that is what it is built for.

**This means Resi could change it without notice.** If they do, the integration
shows an error and everything else in the app carries on. Nothing else depends
on it.

## What it reports

| | |
|---|---|
| **Live** | any watched encoder reports `started` |
| **Off air** | Resi is reachable and no watched encoder is streaming |
| **—** | Resi is not set up, or cannot be reached |

The elapsed time is measured from when Stage Utility first saw the stream, not
from a start time Resi reports — it does not send one. That moment is saved, so
restarting the server mid-service does not reset the clock to zero. If Resi ever
does start reporting a real start time, the integration prefers it.

## Automation

- **Triggers:** Resi goes live · Resi stops streaming
- **Condition:** Resi is streaming

"Stops streaming" deliberately does not fire when Resi merely becomes
unreachable. Unreachable is unknown, not stopped, and a rule that stopped a
recording because an API call timed out would do it mid-service.
