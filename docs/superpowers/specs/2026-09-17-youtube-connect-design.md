# Connect YouTube

**Goal.** Connecting the YouTube integration in *My broadcasts* mode is a
button and a code typed on a phone, not a refresh token pasted from Google's
OAuth Playground.

**Why.** The OAuth path needs a refresh token. Today the operator mints one in
the Playground, with the gear box ticked so it belongs to their own project,
and pastes it. Prod's token expired on 16 Sep because the consent screen was
in Testing, and the repair was the same Playground round trip. Google's OAuth
2.0 for TV and limited-input devices ("device flow") fits this app exactly:
no redirect URL, so it works on a plain-HTTP LAN address; the app shows a
short code, the operator enters it at google.com/device from any device, and
the token arrives at the server.

The device flow does not change how long a token lives. A token from a consent
screen in Testing still expires after seven days. The docs say so, and the
connection row says so while the screen is in Testing (Google's error on
expiry is the same `invalid_grant` either way, so the row can only repeat the
advice, not detect the state).

## What the operator does

1. Google Cloud console: enable YouTube Data API v3; OAuth consent screen,
   External, **Publish app** (the seven-day limit is the Testing state);
   Credentials, create an OAuth client of type **TVs and Limited Input
   devices**. Copy the client ID and secret.
2. Stage Utility, Settings, Integrations, YouTube: How to check = My
   broadcasts; paste client ID and secret; **Save**.
3. Press **Connect YouTube**. The row shows a code such as `GQVQ-SHNC` and the
   address google.com/device. On a phone, open the address, sign in with the
   channel's Google account, enter the code, allow read-only access.
4. Within a few seconds the row reads **Connected**, with the channel's name,
   and the integration goes green.

Web-application and Desktop OAuth clients cannot use the device flow. Google
answers `invalid_client` or `unauthorized_client`; the row says "This OAuth
client cannot use the device flow. Create one of type TVs and Limited Input
devices."

## Server

New `main/services/youtube-connect.ts`, a small state machine with one pending
attempt at most:

| Step | Request | Handling |
|---|---|---|
| start | `POST https://oauth2.googleapis.com/device/code` with `client_id`, `scope=https://www.googleapis.com/auth/youtube.readonly` | store `device_code` (never sent to a browser), `user_code`, `verification_url`, `expires_in`, `interval`; log |
| poll | `POST https://oauth2.googleapis.com/token` with `client_id`, `client_secret`, `device_code`, `grant_type=urn:ietf:params:oauth:grant-type:device_code`, every `interval` seconds (minimum 5) | `authorization_pending`: keep waiting. `slow_down`: add 5 s to the interval. `access_denied`: state error "You declined the request in Google". `expired_token`: state error "The code expired; press Connect again". Success: store the refresh token and finish |
| finish | `GET https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true` with the new access token | store `channelTitle` (not a secret) beside the config; run the integration's test so the card turns green |

The refresh token is written through the same path `setConfig` uses for
secret fields, so it lands in the credentials file, never in settings.json or
a config snapshot. `channelTitle` is ordinary config.

Routes, same-origin browser writes like every other integration write, in
`main/services/routes/integration-routes.ts`:

| Method | Path | Answer |
|---|---|---|
| POST | `/api/integrations/youtube/connect` | starts an attempt using the SAVED client ID and secret; `409` with a sentence when either is blank ("Save the client ID and secret first") or mode is not `oauth`; answers the status below |
| GET | `/api/integrations/youtube/connect` | `{ status: "idle" \| "pending" \| "connected" \| "error", userCode?, verificationUrl?, expiresAt?, message?, channelTitle? }` |
| DELETE | `/api/integrations/youtube/connect` | cancels a pending attempt, or with `{ "disconnect": true }` clears the stored refresh token and `channelTitle` and stops the service |

`connected` means a refresh token is stored; the row reads it from the config
(a masked secret is present) plus `channelTitle`, so a token pasted by hand
also shows as connected, without a channel name until the next Connect.

A pending attempt is memory only. A restart forgets it; the operator presses
Connect again. Starting while one is pending cancels the first.

## The connection row

In `renderer/components/integrations-panel.tsx`, a field type
`"oauth-device"` on the descriptor replaces the Refresh Token password field
for YouTube: `{ key: "refreshToken", label: "Connection", type: "oauth-device",
showIf: { key: "mode", equals: "oauth" } }`. The panel renders it as one row
with four looks:

| State | Row |
|---|---|
| idle, no token | "Not connected" and **Connect YouTube**. Disabled with the hint "Save the client ID and secret first" while either saved value is blank or the card has unsaved changes to them |
| pending | the code in large monospace, "Enter this code at google.com/device", a countdown from `expiresAt`, and **Cancel** |
| connected | "Connected" with the channel title when known, **Reconnect** and **Disconnect** |
| error | the message from the server in the card's error style, and **Try again** |

While pending the panel polls `GET …/connect` every 2 s; it stops on any
other state. Under the row a disclosure **Paste a token instead** opens the
old password field, so the Playground path still works and a hand-pasted
token is still editable. Nothing else on the card changes.

## Docs

- `docs/integrations/youtube.md`, My broadcasts: rewritten around the button
  (client type, Publish app and why, Save, Connect, the phone step). The
  Playground path moves under a "Pasting a token instead" heading. The
  seven-day paragraph stays, reworded to say the button does not change it.
- `docs/reference/api.md`: the three routes.
- `docs/features/operator-app.md` or the integrations doc that lists field
  types, if one enumerates them: the new type.

## Logging

`[youtube] connect: code issued, waiting at google.com/device (expires in 30
min)`, `[youtube] connect: approved, refresh token stored for <channel>`,
`[youtube] connect: declined in Google`, `[youtube] connect: code expired`,
`[youtube] connect: cancelled`, `[youtube] connect: <Google's
error_description>` for anything else, `[youtube] disconnected, refresh token
cleared`. Never the code, the device code or the token.

## Tests, each proven red

- The state machine with stubbed fetch and clock: start issues a code and
  polls at `interval`; `slow_down` widens the interval by 5 s; `access_denied`
  and `expired_token` end in error with the stated sentences; success writes
  the refresh token through the injected saver, fetches the channel title,
  stores it, and logs; cancel stops the timer; a second start cancels the
  first; nothing polls after a terminal state.
- Routes through the existing `callRoute` harness: 409 with blank client
  fields, pending status shape, DELETE cancel and disconnect, and that the
  device code never appears in any response body.
- Log-injection: the new module joins the request-facing list (the channel
  title comes from Google, not the operator, but it is external data; scrub
  it).
- Renderer: the four row states render; the button is disabled with the hint
  while the saved client fields are blank; polling starts on pending and stops
  on connected.
- Real server on an empty data dir, same-origin `POST …/connect` with a bogus
  client ID against Google's real endpoint: the answer is the `invalid_client`
  sentence, the log line says so, and no token is stored. No LAN host is
  contacted. A full approval cannot be driven without a real Google account and
  is recorded as manual.

## Out of scope

- Detecting whether the consent screen is in Testing. Google does not expose
  it; the docs and the row's help text carry the advice.
- Device flow for any other integration. Planning Center uses a personal
  access token; nothing else here is OAuth.
