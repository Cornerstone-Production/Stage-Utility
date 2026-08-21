# YouTube

Shows whether you are live on YouTube and for how long, in the same places the
recording widgets appear. YouTube reports the real start time, so the elapsed
clock is not an estimate.

If Resi restreams to YouTube, this reports that same broadcast — which is worth
knowing if you want a second opinion on whether the stream is actually out.

## Setting it up

Heavier than the other integrations, because Google requires OAuth. Once only:

1. Make a project at **console.cloud.google.com**.
2. Enable **YouTube Data API v3**.
3. Create an **OAuth client ID** of type *Desktop app*.
4. Use it once to authorise the scope
   `https://www.googleapis.com/auth/youtube.readonly`, and keep the **refresh
   token** it returns.
5. Paste the client ID, client secret and refresh token into
   **Settings → Integrations → YouTube**.

An API key will not work. "Are *my* broadcasts live" is a question about the
signed-in channel, and only an OAuth token can answer it.

## What it reports

| | |
|---|---|
| **Live** | a broadcast whose `lifeCycleStatus` is `live` |
| **Off air** | YouTube is reachable and nothing is live |
| **—** | not set up, or cannot be reached |

`testing` and `liveStarting` do not count as live. Neither is going out to an
audience, and an indicator that lights during a test broadcast would be wrong at
exactly the moment someone trusts it.

## Quota

A Google project gets 10,000 API units a day. Stage Utility polls quickly while
someone is watching a screen and slowly otherwise, on the same service-aware
schedule the other integrations use — a normal week lands near 1,000 units.

If the quota does run out, the integration says so and waits half an hour rather
than retrying into a door that stays shut until midnight Pacific.

## Automation

- **Triggers:** YouTube goes live · YouTube stops streaming
- **Condition:** YouTube is streaming

"Stops streaming" does not fire when YouTube simply becomes unreachable.
