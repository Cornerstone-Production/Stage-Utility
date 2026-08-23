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

Resi does not report when a stream started, so the elapsed time is measured from
the moment Stage Utility **watched it go live** — a poll that found Resi
reachable and off air, followed by one that found it streaming. That moment is
saved, so restarting the server mid-service does not reset the clock to zero.

A stream that was already running the first time Stage Utility looked shows
**Live** with no elapsed time. This is the honest answer: the app has no way to
know how long it has been going, and a clock started at first sight would time
how long the integration had been running, not the broadcast. It happens when
the integration is set up during a service, or when Resi is unreachable for the
part of the service in which the stream began. The clock returns for the next
stream.

If Resi ever does start reporting a real start time, the integration prefers it
over both.

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
the recording cards use, so a row of them reads as a row. Anywhere else — a
console, a display — it is the wall widget above, matching OBS status and REAPER
status beside it. The surface decides, not which of the two objects you picked.

## Automation

- **Triggers:** Resi goes live · Resi stops streaming
- **Condition:** Resi is streaming

"Stops streaming" deliberately does not fire when Resi merely becomes
unreachable. Unreachable is unknown, not stopped, and a rule that stopped a
recording because an API call timed out would do it mid-service.
