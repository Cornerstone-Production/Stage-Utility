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
2. **APIs & Services → OAuth consent screen**: External, then add the Google
   account that owns the channel as a **test user**. The app never needs to be
   published or verified — nobody but you signs in to it.
3. Create an **OAuth client ID** of type *Web application*, and add
   `https://developers.google.com/oauthplayground` as an authorised redirect URI.
4. Open the [OAuth Playground](https://developers.google.com/oauthplayground).
   Under the gear icon tick **Use your own OAuth credentials** and paste the
   client ID and secret. In step 1 enter the scope
   `https://www.googleapis.com/auth/youtube.readonly` and authorise as the
   channel's account; in step 2 press **Exchange authorization code for
   tokens** and copy the **refresh token**.
5. Paste the client ID, client secret and refresh token below.

A token minted while the consent screen is in *Testing* expires after seven
days, and one minted with the Playground's own credentials (the gear box left
unticked) belongs to Google's project, not yours — either way the check fails
with `invalid_grant` and the operator does step 4 again. Moving the consent
screen to *In production* removes the seven-day limit; Google shows an
"unverified app" warning on the way through, which is fine for an app only you
sign in to.

An API key cannot do this second job. "Are *my* broadcasts live" is a question
about the signed-in channel, and only an OAuth token can answer it.

## What it reports

| | |
|---|---|
| **Live** | a broadcast is on air — `lifeCycleStatus` is `live`, or the video has a start time and no end time |
| **Off air** | YouTube is reachable and nothing is live |
| **Off air, late** | nothing is live and a broadcast was scheduled to have started — see below |
| **—** | not set up, or cannot be reached |

`testing` and `liveStarting` do not count as live. Neither is going out to an
audience, and an indicator that lights during a test broadcast would be wrong at
exactly the moment someone trusts it.

### Viewers

While live, YouTube also reports how many people are watching, and the widget
shows it beside the elapsed clock — `12:34 · 137 watching`.

The count is **only available on the public path**. A `liveBroadcast` carries no
audience figure, so reading one under *My broadcasts* would mean a second
request on every poll, and the count is not worth that against the daily budget.
Nothing is shown rather than a wrong number.

Nothing is shown either when the channel owner has hidden the count in YouTube
Studio, or in the first moments of a broadcast before YouTube has one. A hidden
count reads as no count, never as nobody watching.

### A start that did not happen

A broadcast scheduled in YouTube that is past its start time with nothing live
turns the widget amber and says how late it is — `Off air`, `6:12 late`. It is
the one off-air state with a colour, because off air is what a wall sits in all
week and a colour that is always there stops being read.

It waits a minute before saying anything, and stops after two hours: an upcoming
broadcast that was cancelled rather than started keeps its scheduled time for as
long as it sits on the channel, and a widget red since March is a widget nobody
looks at.

This too needs the **public path**. *My broadcasts* asks YouTube for broadcasts
that are `active`, and one that has not started is not among them — seeing it
would mean a second request on every poll of the whole week when nothing is
live. Under *My broadcasts* a late start is visible only once the broadcast is
actually going out.

## Quota

A Google project gets 10,000 API units a day. A check costs 1 unit on OAuth and
2 on the public path, and Stage Utility polls quickly while someone is watching a
screen and slowly otherwise, on the same service-aware schedule the other
integrations use — a normal week lands near 2,000 units.

The viewer count and the scheduled start are free: both arrive inside a response
the poll already makes.

The obvious-looking `search.list?eventType=live` is not used: it costs 100 units
a call, so polling it through a single service would spend most of the day's
budget.

If the quota does run out, the integration says so and waits half an hour rather
than retrying into a door that stays shut until midnight Pacific.

## On a screen

**Streaming status**, with its **Platform** set to YouTube, is a layout object and the
twin of **OBS status** and **REAPER status** — the same three states in the same words, so a wall carrying more than
one of them reads as one design:

| | |
|---|---|
| Offline | dimmed. YouTube is not set up, or cannot be reached |
| Off air | grey — reachable, nothing going out |
| Off air, late | amber, with how late beside it |
| Live | green, with the elapsed time and the viewer count beside it |

Green, not the red a recorder uses: red is what OBS and REAPER mean by rolling,
and a wall carrying both should tell them apart by colour rather than by weight.
Late is amber for the same reason — a room carrying recorders and streams wants
exactly one red.

Live fills the whole widget by default, exactly as OBS status and REAPER status
fill red while recording — the four sit side by side and are meant to read as one
set. Turn **Fill green when live** off to colour just the word instead. **Hide
when idle** makes it a tally light, drawing nothing at all until something is
going out — except for a late start, which it still shows. A tally light that
switches itself off exactly when the stream failed to start is a light that has
hidden the one event it exists to report.

**Streaming status** is the same widget asking about every platform at once, or
about one you pick.

**On Home** the same widget is drawn as a card instead: the platform's name, the
state as a word, and a line saying whether YouTube is connected — the shape SPL and
the recording cards use, so a row of them reads as a row. Anywhere else — a
console, a display — it is the wall widget above, matching OBS status and REAPER
status beside it. The surface decides, not which of the two objects you picked.

## Automation

- **Triggers:** YouTube goes live · YouTube stops streaming
- **Condition:** YouTube is streaming

"Stops streaming" does not fire when YouTube simply becomes unreachable.
