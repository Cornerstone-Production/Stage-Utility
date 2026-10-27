# ServiceCue publishing protocol

How a Stage Utility server puts [ServiceCue](../features/servicecue-and-baptisms.md#on-the-web)
on a public address without anything on the internet ever connecting to it. The
server only sends. A small Cloudflare Worker receives what it sends and serves it,
and a visitor only ever talks to the Worker.

```
Stage Utility server  --PUT/POST over HTTPS, with a token-->  Worker  <--GET and WebSocket--  visitor
(reads Planning Center)                                       (holds the last of everything)
```

The Worker is in [`publish/servicecue/`](../../publish/servicecue/README.md); the page
it serves is built from the same ServiceCue code the app runs. Setting one up, what it
costs and who can see it are in [ServiceCue on the web](../ops/servicecue-on-the-web.md).

Everything the protocol names (doc keys, channels, the state fields the page may
receive, the limits) is one module,
[`main/types/servicecue-publish.ts`](../../main/types/servicecue-publish.ts), imported
by the Worker, the public page and the publisher alike. This page describes it; the
module is the authority. Protocol version: **1**, the `v1` in every publisher path and
the `protocol` in the status answer.

## Authentication

Every request under `/_publish/` carries `Authorization: Bearer <token>`, where the
token is the Worker secret `PUBLISH_TOKEN`.

| Case | Answer |
|---|---|
| Token missing or wrong | `401`, `WWW-Authenticate: Bearer` |
| No `PUBLISH_TOKEN`, one that is not a string, or one shorter than 32 characters | `503` naming the secret, to every request, a correct-looking token included |

The token is checked before the path and the method, so a caller without one learns
nothing about which paths exist, and it is compared in constant time (a comparison of
SHA-256 digests). Nothing else on the Worker takes a token: the public side is open.
Failures answer `{"error": "…"}`.

## What the publisher sends

| Method | Path | Body | Answers |
|---|---|---|---|
| `PUT` | `/_publish/v1/doc/<key>` | JSON | `204`. `400` for a body that is not JSON or not what the doc must be, `404` for a key that is not one below, `413` for a doc over the size limit once stored |
| `DELETE` | `/_publish/v1/doc/<key>` | | `204` |
| `POST` | `/_publish/v1/frame` | `{"channel": "…", "data": …}` | `204`. `400` for a channel that is not one below, a frame with no `data`, or data that is not what the channel carries; `413` as for a doc |
| `PUT` | `/_publish/v1/asset/<name>` | image bytes, with a `Content-Type` | `204`. `400` for an empty body, `404` for a name that cannot be an asset's, `415` for any type but the five below |
| `POST` | `/_publish/v1/heartbeat` | `{"at": <ms>, "version": "…"}` | `204`. `400` for anything else |
| `PUT` | `/_publish/v1/manifest` | `{"docs": […], "assets": […]}` | `200 {"removedDocs": […], "removedAssets": […]}`. `400` if any entry is not a key or a name |
| `GET` | `/_publish/v1/status` | | `200 {protocol, docs, assets, lastHeartbeat, viewers, build}` |

The status answer's fields:

| Field | Meaning |
|---|---|
| `protocol` | The protocol version this Worker speaks |
| `docs`, `assets` | Every stored doc key and asset name, sorted |
| `lastHeartbeat` | `{at, sentAt, version}` of the latest heartbeat, or `null` before the first |
| `viewers` | Viewers connected to the live socket now |
| `build` | The build id of the page this Worker serves (see [Reloading after a deploy](#reloading-after-a-deploy)), or `null` when the deploy has no document or one with no id. A publisher reads a Worker that sends no `build` as `null` too |

A known path with another method is `405` with an `Allow` header; any other path under
`/_publish/` is `404`. A request body over **2,000,000 bytes** is `413`, counted as it
arrives rather than from `Content-Length`, which can be absent or wrong.

### Docs

A doc is a JSON body the Worker returns, exactly as sent, as the answer to one public
path. The public page asks the same questions it asks a server in the building and gets
the same shapes back. The keys, sorted:

| Key | Answered at |
|---|---|
| `pco-live` | `/api/pco/live` |
| `plans-upcoming` | `/api/plans/upcoming?days=60` |
| `rundown-<typeId>` | `/api/servicecue/rundown?serviceTypeId=<typeId>` |
| `rundown-<typeId>-<planId>` | `/api/servicecue/rundown?serviceTypeId=<typeId>&planId=<planId>` |
| `service-types` | `/api/service-types` |
| `servicecue-config` | `/api/servicecue/config` |
| `servicecue-layouts` | `/api/servicecue/layouts` |
| `servicecue-roles` | `/api/servicecue/roles` |
| `spl-current` | `/api/spl/history/current` |
| `state` | `/api/state` |

`<typeId>` and `<planId>` are Planning Center ids: 1 to 20 digits, nothing else.
`plans-upcoming` is answered for exactly that query and no other.

Three docs are also frames (below), and are checked on arrival: `pco-live` and
`spl-current` are an object or `null` (`spl-current` is `null` while nothing is
recording), and `state` is cut down to the fields below. Whatever a doc or frame is
stored as, in the form it is stored (JSON is written again, and a number like `1e20`
comes back longer), is also held to the 2,000,000-byte limit: a body under it that
grows over it is refused with a `413`.

### The state the page may receive

The Worker drops every field of the app's state but these, so it never holds the rest:
screens and views, every network address, device telemetry, update and automation
settings. A field that is there and not valid is refused with a `400` naming it.

| Field | Why the page reads it | Valid when |
|---|---|---|
| `accentColor` | the Branding accent, which tints the rundown's detail line and badges | `#rrggbb`, or `null` |
| `appLogo` | the header's logo, and the tab icon | `/branding-images/<an asset name>`, or `null` |
| `appLogoMonochrome` | whether that logo is recolored to the theme | `true` or `false` |
| `hourCycle` | 12 or 24 hour, for every clock on the page | `"12h"` or `"24h"` |
| `pcoConfigured` | whether Planning Center is connected; the page asks for nothing until it says so | `true` or `false` |
| `timezone` | the zone the header clock reads in | a time zone the runtime's `Intl` knows, or `null` |

The custom tab icon (`appIcon192`) is not here: its image is served by a route the
Worker does not have, so the tab follows the logo.

### Frames

A frame is a change on a live channel, and is a write of the doc its channel is stored
as: the Worker stores its data as that doc, so a read straight after a frame is never
older than it, and sends it to every open viewer.

| Channel | `data` | Stored as |
|---|---|---|
| `pco:live` | the live position, or `null` | `pco-live` |
| `spl:history` | the SPL recording, or `null` | `spl-current` |
| `stage:state-changed` | the state, an object, cut down as above | `state` |

Those three are the whole list. `publish:heartbeat` and `publish:docs` are the Worker's
own channels and cannot be sent to. Writing one of the three docs with `PUT` is a frame
too: viewers are sent it.

A viewer that joins is replayed the stored docs of these channels, in this order, as
frames.

### Assets

An image is stored by name and served at `/branding-images/<name>`, the path the app
serves its own branding images at, so a state whose `appLogo` is
`/branding-images/<name>` resolves on the public host unchanged. A name is 1 to 100 of
letters, digits, `.`, `_` and `-`, and not only dots. The type is one of `image/png`,
`image/jpeg`, `image/webp`, `image/gif` and `image/svg+xml`.

### Heartbeat

Send one every 30 seconds or so while publishing. The Worker records it on **its own
clock**, tells every viewer, and keeps the publisher's `at` and `version` for the status
answer only. A viewer is told when the church was last heard from and which build of the
page the Worker is serving, never what version the church runs, and a church server
whose own clock is wrong cannot decide whether the page is stale.

### Manifest

Everything stored and not named is deleted, docs and assets alike: a rundown for a plan
that has gone, an image no longer in use. One bad entry refuses the whole manifest and
deletes nothing. At most 5,000 of each.

## What a visitor gets

Everything below is open: no token, `GET` and `HEAD` only except the socket, which is
`GET`. Another method on a path that exists is `405` with `Allow`.

| Path | Answers |
|---|---|
| `/servicecue`, `/servicecue/<service type>/<layout>` | the page. Each segment is a slug or an id (letters, digits, `_`, `-`), as the app's own links are; one trailing slash is allowed |
| the doc paths above | the doc, `404 {"error": …}` if it was never sent |
| `/branding-images/<name>` | the asset, with its type and `X-Content-Type-Options: nosniff` |
| `/api/publish/heartbeat` | `{"at": <ms or null>, "now": <ms>}`: when the church was last heard from, and the edge's clock |
| `/api/live` | the WebSocket below |

The files the build writes beside the page (`/assets/*.js`, `*.css`, `*.woff` and
`*.woff2`, `/favicon.svg`, `/apple-touch-icon.png`, the three `/icon-*.png` and
`/manifest.webmanifest`) are answered by the static asset service, not the Worker, so
they are not requests the Worker is charged for. `wrangler.jsonc` names each by file
type, and the build writes the `_headers` file the asset service reads: the base
headers below, and `immutable` caching for `/assets/*`.

`/` is a `302` to `/servicecue`, with no query carried, so a domain of its own opens
on the landing page.

**Everything else is a `404`**: `/servicecue/presets`, `/servicecue/manage`, a
deeper path, any file name not in the build. The Worker answers only paths it names;
nothing falls back to a near one. The page's own file is never served at its own name.
A path is judged as the URL parser leaves it: `..` and `%2e%2e` segments and a backslash
are resolved before the Worker runs, so what is judged is the path they come to; an
encoded slash (`%2f`), an encoded backslash and an empty segment (`//`) arrive as sent
and match nothing.

### The live socket

`GET /api/live` with `Upgrade: websocket`. Without it the answer is `426`; with an
`Origin` that is not the Worker's own host, `403` (another site's page cannot spend
this deploy's allowance). A socket is held while it is wanted:

- one address (`CF-Connecting-IP`) may hold **25** sockets; the next is `429` with
  `Retry-After: 30`, whoever the others are;
- the Worker holds **500** in all; when it is full, sockets that have not pinged for
  90 seconds (the page pings every 30) are closed with `1001` to make room, and if none
  is idle the next is `503` with `Retry-After: 30`.

Every message the Worker sends is `{"channel": "…", "data": …}`:

- On connect, the stored docs of the frame channels as frames, in the order `pco:live`,
  `spl:history`, `stage:state-changed`, each with `"replay": true`, then
  `publish:heartbeat` with `data` `{"at": <ms or null>, "now": <ms>, "build": "<id>"}`
  and `"replay": true`. `at` is when the last heartbeat arrived, null before the first;
  `now` is the edge's clock as the replay is sent, so a viewer can age `at` with no
  clock of its own; `build` is the id of the page the Worker serves, left out when that
  page carries none. A replayed frame is the last one kept, however old.
- After that, every frame the church sends; every heartbeat as `{"at": <ms>, "build":
  "<id>"}` (`at` is the edge's clock as it arrives); and `publish:docs`, below.

`publish:docs` is `{"keys": ["<doc key>", …]}`: the docs whose stored text just changed
or that were removed (by a `DELETE` or a manifest). A doc published again unchanged is
not announced, and a doc that is also a frame is sent as its frame. A change to more
than 50 docs names the first 50 and adds `"all": true`.

A viewer sends nothing the Worker acts on. `ping` is answered `pong` by the runtime
without waking the object; any other message closes the socket with `1008`, so a client
that sends as fast as it can wakes the object once. A close a viewer sends is answered
with its own code where one can be sent (1000 to 1003, 1007 to 1014, 3000 to 4999) and
with `1000` where not.

### Response headers

On every response the Worker sends, the `101` handshake aside: `X-Robots-Tag: noindex`,
`X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
`Strict-Transport-Security: max-age=15552000; includeSubDomains`.

A request over plain `http` gets a `301` to the same path and query over `https`,
except under `/_publish/`, which is a `403 {"error": "Publishing needs https"}` without
the token being checked. `localhost`, `127.0.0.1` and `[::1]` are served over `http` as
they are, for `wrangler dev`. A zone with **Always Use HTTPS** on redirects before the
Worker sees the request; this is the same rule kept by the Worker itself.

On the page, a policy that allows no inline script:

```
default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline';
connect-src 'self' wss://<host>; frame-ancestors 'none'; base-uri 'none'
```

`connect-src 'self'` covers the page's own socket in Chrome and in current Safari;
older Safari releases did not count `wss:` as the page's own origin, so the socket's
address is named as well: the same host, nothing wider (`ws://` when served over plain
HTTP, as `wrangler dev` does). On an SVG asset:
`Content-Security-Policy: sandbox; default-src 'none'; style-src 'unsafe-inline'`, so
one opened as a page of its own is only a picture.

Caching: the page is revalidated; `/assets/*` is `immutable` (its names carry a hash)
and the icons and manifest are revalidated; docs, the heartbeat and every refusal are
`no-store`; an asset is kept for a day.

## What the page does

The page reads the docs above, opens one socket and takes its frames through the same
dispatch the app's own transports end in. It writes nothing: no channel report, no log
line, no request other than a `GET`; the only thing it sends is `ping`, every 30
seconds, and a socket that says nothing for 75 seconds is replaced. A closed socket is
reopened after 1 second, then 2, 4, 8, 16 and no more than 30, each spread by a quarter
either way so that viewers a deploy dropped do not all return in the same second.

**Keeping docs current.** The page does not read on a timer while it has a socket. It
reads a doc when `publish:docs` names it, and every doc after each connect and
reconnect (a change made while it was away is not replayed). While it has no socket it
reads again every 10 minutes. The building's own page still reads every minute.

A doc that is also a frame is named on `publish:docs` only when it is removed, so a viewer
treats that as the live position or the SPL recording becoming `null` (nothing live,
nothing recording) and reads the state again. A page that was told to forget a rundown does
not go on showing the last live item.

**The clock.** It sets its clock once per connection from `/api/publish/heartbeat`, over
a request whose round trip is measured, and renders every countdown against it.

**"Not updating".** When the church has not been heard from for two minutes the page
puts a bar across the top: *Not updating. The last update from the church was at
10:42 AM. The live item may have moved on.* The time is in the app's time zone and hour
cycle. It is decided on the page's own monotonic clock, by when things arrived: a
heartbeat or a frame sent live counts when it arrives; a heartbeat replayed on connect,
and the answer of `/api/publish/heartbeat`, count as old as the edge's own `now` minus
`at` says; a frame replayed on connect counts for nothing. The church's clock and the
visitor's decide nothing, so a church whose clock is wrong cannot make the page stale or
fresh.

While the socket is not open the page reads `/api/publish/heartbeat` a few seconds after
loading and every minute after, so a page that cannot connect still learns the church
has gone quiet. With nothing ever heard, the bar reads *The church has not sent an
update yet.* two minutes after the page began. The bar takes a row of its own above the
page, and goes away by itself when updates resume.

### Reloading after a deploy

A visitor may leave the page open for hours, across a deploy. The build stamps
`servicecue.html` with an id, `<meta name="servicecue-build" content="…">` in its head:
12 lower-case hex digits, the SHA-256 of the document as the build wrote it. The
document names its script and style by names that carry their own content hash, so it
is a different document whenever either is. (An icon or a manifest that changes alone
is not a new build.)

The Worker reads the id out of the document it serves and gives it to the status answer
(`build`), and puts it on the heartbeat it
replays on connect and on every one it sends after. When a page hears an id that is not
its own it reloads, on the address it is on, so `?plan=`, `?text=` and `?from=` are
still there. A socket a deploy dropped reconnects, and the replay is the first thing it
hears; a socket that survived hears it in the next heartbeat.

It reloads once per build. The id it reloaded for is kept in the tab's `sessionStorage`
before the reload, and read back to be sure it stayed, and an offer of that same id is
not acted on again: a document served stale after the reload leaves the page where it
is, with a line on its console, and not in a loop. The next different build gets its
reload. A tab that cannot keep the note (no storage, or storage that throws or forgets)
is never reloaded, and neither is a page whose document carries no id, as with the dev
server.

## Deploying the page

The server also puts the page itself on Cloudflare, through Cloudflare's API with an API
token the operator enters ([how and when](../ops/servicecue-on-the-web.md#keeping-it-up-to-date)).
What it deploys is `build/servicecue/`, which every build prepares: `worker.js`, the
built `public/` and `deploy.json`. The status answer's `build` is what it compares with
`deploy.json`'s, by id and never by version.

The requests are `wrangler deploy`'s, made with `fetch` from `main/services/servicecue-cloudflare.ts`:

1. `GET /user/tokens/verify`, or `GET /accounts/:id/tokens/verify` for a token made under the account.
2. `POST /accounts/:id/workers/scripts/:name/assets-upload-session` with the manifest: each file by its path and
   its hash (32 hex digits of the BLAKE3 hash of its base64 text and extension, as wrangler computes it) and size.
   `_headers` is not a file: its text is in `deploy.json`'s `assets`, and goes in the assets config.
   The answer lists the hashes Cloudflare does not hold, in buckets.
3. `POST /accounts/:id/workers/assets/upload?base64=true` once per bucket, with the session's token. The last
   answer carries the completion token; with nothing to upload, the session's token is it.
4. `PUT /accounts/:id/workers/scripts/:name?excludeScript=true&bindings_inherit=strict`, multipart, after a
   `GET .../settings` that confirms the Worker exists (the PUT would create one): `metadata` and
   the module. The metadata is `main_module`, `bindings`, `compatibility_date` (and `compatibility_flags` when
   there are some), `code_update_strategy`, `exports`, `keep_bindings`, `annotations` and
   `assets: {jwt, config}`, all read from `deploy.json` but the strategy and the annotations. `keep_bindings`
   is what keeps `PUBLISH_TOKEN`. The annotations are `workers/tag` (the build id) and `workers/message`
   (`Stage Utility <running version>`).
   `npm run servicecue:deploy` sends the same two (`--message` and `--tag`), so a deploy by hand is read back
   the same way.

The version recorded in the message is what the next server reads back, from the deployment's
version annotations, for the no-downgrade rule. The deployer's own status is in
[the API](api.md) as `deploy` on the publish answer.

## Storage and limits

One Durable Object, SQLite-backed (the only kind the free plan allows), named `main`,
holds the docs and assets in tables and the last heartbeat in its key-value storage.
Its viewers' sockets use the WebSocket Hibernation API, so a deploy with viewers
connected and a church that is quiet costs nothing while it waits.

| | |
|---|---|
| Request body | 2,000,000 bytes (a doc or frame as stored too) |
| Connected viewers | 500, and 25 to an address |
| Ids | 1 to 20 digits |
| Asset names | 1 to 100 of `A-Za-z0-9._-`, not only dots |
| Manifest | at most 5,000 docs and 5,000 assets |
| `version` in a heartbeat | 1 to 64 characters |
| Publishing token | at least 32 characters |
| `plans-upcoming` | 60 days |

`MAX_VIEWERS`, `MAX_VIEWERS_PER_ADDRESS` and `VIEWER_IDLE_MS` change the first two limits
and the 90 seconds. Set them as variables on the Worker in the Cloudflare dashboard, or as
`vars` in `wrangler.jsonc` for a deploy made by hand. `wrangler.jsonc` sets `keep_vars`, so
a variable on the Worker survives every deploy, the server's own included, unless
`wrangler.jsonc` names the same one. A deploy behind one address with more than 25 devices
raises the second.

A publisher should send a frame when something changed and a heartbeat every 30
seconds. Stage Utility's own does, and how it paces the rest, retries and what it logs
is in [On the web](../features/servicecue-and-baptisms.md#on-the-web). What each costs against the free plan is in
[ServiceCue on the web](../ops/servicecue-on-the-web.md#what-it-costs-and-what-it-limits).
