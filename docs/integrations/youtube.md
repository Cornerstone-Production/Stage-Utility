# YouTube

Shows whether you are live on YouTube and for how long, in the same places the
recording widgets appear. YouTube reports the real start time, so the elapsed
clock is not an estimate.

If Resi restreams to YouTube, this reports that same broadcast — which is the
point: Resi can only tell you it is sending. This tells you it arrived.

## Two ways to check

**Settings → Integrations → YouTube → How to check**, which offers *Public
channel* and *My broadcasts*.

| | Public channel | My broadcasts |
|---|---|---|
| What you enter | an API key and your channel | an OAuth client ID, secret and refresh token |
| Sees | anything a viewer could see | every broadcast on the channel, private and unlisted included |
| Setup | a few minutes | a consent round-trip, and a token to look after |

**Public channel is the default, and is the right answer for most churches.** A
service streamed to the world is a public broadcast, and checking it the way a
viewer's client would answers the question that actually matters — is it
reaching anyone.

Choose **My broadcasts** if your streams are unlisted or private. Nothing public
means nothing to find, and this mode is the only one that can see them.

### Public channel

1. Make a project at **console.cloud.google.com**.
2. Enable **YouTube Data API v3**.
3. Create an **API key**.
4. Paste it below, with your channel — either the handle (`@yourchurch`) or the
   id (`UC…`). Both are in your channel's URL.

### My broadcasts (OAuth)

1. The same project, with the same API enabled.
2. Create an **OAuth client ID** of type *Desktop app*.
3. Use it once to authorise the scope
   `https://www.googleapis.com/auth/youtube.readonly`, and keep the **refresh
   token** it returns.
4. Paste the client ID, client secret and refresh token below.

An API key cannot do this second job. "Are *my* broadcasts live" is a question
about the signed-in channel, and only an OAuth token can answer it.

## What it reports

| | |
|---|---|
| **Live** | a broadcast is on air — `lifeCycleStatus` is `live`, or the video has a start time and no end time |
| **Off air** | YouTube is reachable and nothing is live |
| **—** | not set up, or cannot be reached |

`testing` and `liveStarting` do not count as live. Neither is going out to an
audience, and an indicator that lights during a test broadcast would be wrong at
exactly the moment someone trusts it.

## Quota

A Google project gets 10,000 API units a day. A check costs 1 unit on OAuth and
2 on the public path, and Stage Utility polls quickly while someone is watching a
screen and slowly otherwise, on the same service-aware schedule the other
integrations use — a normal week lands near 2,000 units.

The obvious-looking `search.list?eventType=live` is not used: it costs 100 units
a call, so polling it through a single service would spend most of the day's
budget.

If the quota does run out, the integration says so and waits half an hour rather
than retrying into a door that stays shut until midnight Pacific.

## On a screen

**YouTube status** is a layout object, and the twin of **OBS status** and **REAPER
status** — the same three states in the same words, so a wall carrying more than
one of them reads as one design:

| | |
|---|---|
| Offline | dimmed. YouTube is not set up, or cannot be reached |
| Off air | grey — reachable, nothing going out |
| Live | green, with the elapsed time underneath |

Green, not the red a recorder uses: red is what OBS and REAPER mean by rolling,
and a wall carrying both wants one of them shouting rather than two. **Fill green
when live** paints the whole widget instead of the word; **Hide when idle** makes
it a tally light, drawing nothing at all until something is going out.

**Streaming status** is the same widget asking about every platform at once, or
about one you pick.

**On Home** the same widget is drawn as a card instead: the platform's name, the
state as a word, and a line saying whether YouTube is connected — the shape SPL and
the recording cards use, so a row of them reads as a row. The wall keeps the
larger all-caps word, which is what it is for.

## Automation

- **Triggers:** YouTube goes live · YouTube stops streaming
- **Condition:** YouTube is streaming

"Stops streaming" does not fire when YouTube simply becomes unreachable.
