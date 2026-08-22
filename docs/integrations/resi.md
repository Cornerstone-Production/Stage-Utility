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

## On a screen

**Resi status** is a layout object, and the twin of **OBS status** and **REAPER
status** — the same three states in the same words, so a wall carrying more than
one of them reads as one design:

| | |
|---|---|
| Offline | dimmed. Resi is not set up, or cannot be reached |
| Off air | grey — reachable, nothing going out |
| Live | green, with the elapsed time underneath |

Green, not the red a recorder uses: red is what OBS and REAPER mean by rolling,
and a wall carrying both wants one of them shouting rather than two. **Fill green
when live** paints the whole widget instead of the word; **Hide when idle** makes
it a tally light, drawing nothing at all until something is going out.

**Streaming status** is the same widget asking about every platform at once, or
about one you pick.

**On Home** the same widget is drawn as a card instead: the platform's name, the
state as a word, and a line saying whether Resi is connected — the shape SPL and
the recording cards use, so a row of them reads as a row. The wall keeps the
larger all-caps word, which is what it is for.

## Automation

- **Triggers:** Resi goes live · Resi stops streaming
- **Condition:** Resi is streaming

"Stops streaming" deliberately does not fire when Resi merely becomes
unreachable. Unreachable is unknown, not stopped, and a rule that stopped a
recording because an API call timed out would do it mid-service.
