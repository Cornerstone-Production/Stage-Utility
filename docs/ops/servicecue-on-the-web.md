# ServiceCue on the web

A public address for [ServiceCue](../features/servicecue-and-baptisms.md#on-the-web):
the same pages and the same links, for anyone you give the link to, with no login.
It runs on a free Cloudflare Workers address (`workers.dev`) that you deploy
yourself. Stage Utility sends what ServiceCue shows out to it; nothing on the
internet ever connects to your server, and there is nothing to open on your firewall.
How it works is in [ServiceCue publishing protocol](../reference/servicecue-publishing.md).

## Who can see it

**Anyone with the link, and the link is not a secret.** There is no login.

- Everything ServiceCue shows is public: the service types, the layouts, the plans in
  the plan switcher (from the last 7 days through the next 60 days, so last week's
  rundowns stay public for up to 7 days), the live item, the countdown and the clock, and the whole rundown
  of every plan that is published. **Every note on a published plan is public**, in
  every column: audio and band notes, lighting and video cues, and whatever else is
  written in a plan's item notes. Do not publish a plan whose notes you would not put
  on a poster in the lobby.
- The address is `servicecue.<your-subdomain>.workers.dev`, a name that can be
  guessed. The page tells search engines to leave it out (`noindex`), which asks them
  and hides nothing from a person or a script that finds or guesses the address.
- The Worker holds no Planning Center access, no settings and no network addresses: of
  the app's state it keeps six fields (accent colour, logo, logo recolouring, hour cycle,
  whether Planning Center is connected, time zone) and drops the rest on arrival.

To stop sharing, delete the Worker (see [Taking it down](#rotating-the-token-and-taking-it-down)).

## What you need

- A free [Cloudflare account](https://dash.cloudflare.com/sign-up). No card.
- Node 24, as the app itself requires, and a checkout of this repository.

## Set it up

1. **Install what builds the page and what deploys it**, from the repository root:

   ```bash
   npm ci --include=dev
   npm --prefix publish/servicecue ci
   ```

2. **Sign in to Cloudflare.** This opens a browser:

   ```bash
   cd publish/servicecue
   npx wrangler login
   ```

3. **Build and deploy** (from the repository root again):

   ```bash
   npm run servicecue:deploy
   ```

   This builds the page from the app's own ServiceCue code and deploys the Worker.
   The first time, Wrangler asks you to pick a `workers.dev` subdomain for your
   account, then prints the address:

   ```
   https://servicecue.<your-subdomain>.workers.dev
   ```

   The page is at `/servicecue` on it. Until step 4 the Worker answers publishers
   with a 503 saying the secret is missing, and the page says the church has not sent
   an update yet.

4. **Set the publishing token.** It is the one thing that lets anyone write to the
   Worker, so make it long and keep it out of the repository:

   ```bash
   openssl rand -base64 32
   cd publish/servicecue
   npx wrangler secret put PUBLISH_TOKEN
   ```

   Paste the token when asked. At least 32 characters, or the Worker treats it as not
   set. Keep a copy: Cloudflare will not show it again, and Stage Utility needs it.

5. **Check it.**

   ```bash
   curl https://servicecue.<your-subdomain>.workers.dev/api/publish/heartbeat
   # {"at":null,"now":1790000000000}

   curl -H "Authorization: Bearer <the token>" \
     https://servicecue.<your-subdomain>.workers.dev/_publish/v1/status
   # {"protocol":1,"docs":[],"assets":[],"lastHeartbeat":null,"viewers":0}
   ```

   `"protocol":1` with your token, and a 401 without it, mean the Worker is running
   and the secret is set.

6. **Turn it on in Stage Utility.** Open the ServiceCue presets page
   (`/servicecue/presets`), find **Public link**, and enter the Worker's address and the
   token from step 4. Switch it on: Stage Utility asks the Worker first, so a wrong
   address or token is said on the card and nothing is switched on. The card then shows
   the link to give out (with **Copy** and a **QR code**) and how long ago the Worker last
   accepted something. The token is kept encrypted on the server, belongs to the address
   it was entered with, and is never shown again or included in a backup.

## What the address is

| | |
|---|---|
| `/servicecue` | the landing page, as a stage tablet sees it, without the **Edit column presets** link |
| `/servicecue/<service type>/<layout>` | a rundown. The same links as the app's: `weekend/audio`, a layout by id, `all-columns`, `?plan=`, `?text=` |
| `/` | sends the visitor on to `/servicecue` |
| anything else | `404`. There is no `/servicecue/presets` and no settings of any kind |

Give people the `/servicecue` link; every rundown they open from it works like the
app's own, and its back arrow returns to it.

## Your own domain

A domain whose DNS is on Cloudflare, in the same account, can stand in for the
`workers.dev` address. A domain bought through Cloudflare already is.

1. Attach it: **Workers & Pages → servicecue → Settings → Domains & Routes → Add →
   Custom Domain**. Cloudflare makes the DNS record and the certificate.
2. Tell later deploys about it, or the next one drops it. Create
   `publish/servicecue/deploy.local.json` (gitignored, so the domain stays out of the
   repository):

   ```json
   { "domain": "servicecue.example.org", "workersDev": false }
   ```

   `workersDev: false` turns the `workers.dev` address off; leave it out to keep both.
3. In the Public link card, change the page address and enter the publishing token
   again in the same save: a token is kept only for the address it was saved with.

## Updating it

A change to ServiceCue reaches the public page when you run `npm run servicecue:deploy`
again. The docs and rundowns the page shows are not part of the deploy: they come from
what Stage Utility sends.

A page someone left open reloads itself, once, soon after a deploy that changed the
page, and keeps the address it was on
([how](../reference/servicecue-publishing.md#reloading-after-a-deploy)).

## When something looks wrong

- **The page says "Not updating".** The church has sent nothing for two minutes: the
  server is off, cannot reach Cloudflare, or has the wrong token. The page keeps the
  rundown it last had and says when that was. A page that cannot reach the Worker at
  all says it too, two minutes after it loaded.
- **See what the Worker holds.** The status request from step 5 lists every stored doc
  and image, the time of the last heartbeat and how many viewers are connected.
- **Read its log.** `npx wrangler tail`, run in `publish/servicecue`, shows lines tagged
  `[servicecue-hub]` when a manifest removes something, when a socket is refused for
  the page being full or one address holding its share, when idle sockets are closed to
  make room, and when a viewer's socket fails; and `[servicecue-worker]` when a request
  fails, or when the page carries no build id (below). The server's side is in the
  app's [log](updates-and-logs.md) as `[publish]` lines, and the **Public link** card
  says why the Worker is not being reached: the token was refused, a Cloudflare rule
  blocked the server, the address is not the page, or the Worker has no secret set or one
  under 32 characters.
- **The card says something on this network is intercepting the connection.** A firewall
  or web filter on the church's network is answering for the Worker with a certificate of
  its own, usually because its filter blocks the address. Ask whoever runs it to allow the
  Worker's host. The `[publish]` log line carries what Node said and its code
  (`SELF_SIGNED_CERT_IN_CHAIN`, `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` and the like).
- **The page says "The church hasn't sent its services yet."** The Worker holds no
  service types: the server reaches it but cannot read Planning Center, so it sends
  layouts and no service types or rundowns. The **Public link** card
  says **Can't read Planning Center** with the reason, and the log has
  `[publish] could not read the service types: …` lines; it logs
  `[publish] Planning Center can be read again` once the reads work. Fix the credentials
  under **Integrations**.
- **A page that shows no rundown** at an address that works for others: the rundown
  for that plan was never published. It says "This service hasn't been sent yet. Check
  back soon." in place of the rundown.
- **Open pages did not reload after a deploy.**
  `curl -s https://servicecue.<your-subdomain>.workers.dev/servicecue` should show a
  `<meta name="servicecue-build" content="…">` line in the head. Without it the Worker
  says, once each time it starts, that the page carries no build id or that no page is
  in the deploy at all: build with `npm run servicecue:build` and deploy again.
- **A visitor is told the page is full, or has too many pages open.** The Worker holds
  500 sockets, and 25 to an address: a building whose devices share one address and
  open more than 25 needs `MAX_VIEWERS_PER_ADDRESS` raised
  ([limits](#what-it-costs-and-what-it-limits)).

## Rotating the token, and taking it down

A leaked token lets someone, from anywhere:

- publish a rundown that is not yours, under your address;
- erase everything the Worker holds with one empty manifest, so the page shows nothing
  until the church sends it again;
- spend your day's allowance on writes and requests, which stops the page for the rest
  of the day;
- fill the Worker's storage with docs and images until it is full;
- host images, up to 2 MB each, at `https://servicecue.<your-subdomain>.workers.dev/branding-images/<name>`,
  on an address that has your name on it;
- read the Stage Utility version your server is running, which the status answer reports.

It reaches no part of your network, your Planning Center account or your settings.

To rotate it, set a new one with the two commands in step 4 and update Stage Utility;
the old one stops working at once, and the **Public link** card shows it as the problem until the new one is entered under **Cloudflare connection**. Do it when someone who had it leaves, and whenever it
may have been seen.

To take the Worker down, Wrangler asks before it deletes:

```bash
cd publish/servicecue
npx wrangler delete
```

## Running it on your own machine

```bash
echo 'PUBLISH_TOKEN=<a token of 32 characters or more>' > publish/servicecue/.dev.vars
npm run servicecue:dev
```

This builds the page and runs the Worker locally (`http://localhost:8787/servicecue`),
with its own empty storage. `.dev.vars` is ignored by git. To publish to it, start Stage
Utility with `STAGE_UTILITY_PUBLISH_ALLOW_LOCAL=1` in its environment, and give the
**Public link** card `http://localhost:8787` and that token. Without the variable the card
refuses every address that is not `https://`, so a production server can never be pointed
at a port on its own machine.

## What it costs, and what it limits

It stays on Cloudflare's free plan. The plan's daily allowances reset at 00:00 UTC
(see Cloudflare's Workers and Durable Objects pricing and limits pages for the current
numbers; they are these today):

| | Per day |
|---|---|
| Worker requests | 100,000 |
| Durable Object requests | 100,000 |
| Durable Object duration | 13,000 GB-s |
| Rows the object reads | 5 million |
| Rows the object writes | 100,000 |
| Storage | 5 GB |

What counts:

- The page's scripts, styles, fonts and icons are answered by Cloudflare's static asset
  service, which does not charge for them. Every other request is a Worker request, and
  each that reads or writes a doc is an object request as well.
- A WebSocket is one request when it opens. What the Worker sends down it is free, and
  so is the `ping` the page sends every 30 seconds, which the runtime answers itself.
- Two requests are not the page's: the church's server sends a heartbeat every 30
  seconds (2,880 requests and 2,880 writes a day) and a request for each frame or doc it
  publishes.

What one open tab costs (each is a Worker request and an object request):

| | Requests |
|---|---|
| opening the page | about 17: the document, the eight or nine reads it makes, the clock, the socket, and a second read of what it shows once the socket is up |
| each time its socket reconnects (a phone waking, a deploy) | about 7: the clock, the socket, and a read of what it shows |
| each change to a doc it shows | 1 |
| every minute it stays open with the socket up | 0 |

A tab opened once, kept open all day, reconnecting ten times and seeing thirty changes
costs about 120 requests. Forty such tabs are about 4,700, and the church's own about
3,000 more: some 8% of the allowance. Beside the church's own, the free plan carries
about eight hundred such tab-days a day.

A tab that cannot open its socket reads the Worker's heartbeat every minute and its
docs every 10 minutes, about 2,000 requests a day for as long as it stays open.

A flood that used the allowance up would stop the public page until 00:00 UTC (the
files it loads from Cloudflare's static service are not counted, so they keep loading)
and nothing else: your server never depends on it.

The Worker holds at most 500 sockets, 25 to an address, closes ones that have stopped
pinging when it needs the room, accepts bodies up to 2 MB, and closes a socket that
sends anything but a keep-alive. `MAX_VIEWERS`, `MAX_VIEWERS_PER_ADDRESS` and
`VIEWER_IDLE_MS` (milliseconds) can be set under `vars` in `publish/servicecue/wrangler.jsonc`
to change those; the defaults are 500, 25 and 90000.

## What the deploy tells Cloudflare

- **Nothing about who you are is in the repository.** `wrangler.jsonc` has no account
  id and no address; `wrangler login` decides the account, and the name `servicecue`
  decides the first part of the address.
- **Wrangler is told not to send your package list.** It sends the names of a
  project's npm dependencies with every deploy unless asked not to, and
  `wrangler.jsonc` sets `dependencies_instrumentation` off. Wrangler's own usage
  metrics are separate: `npx wrangler telemetry disable` turns them off.
- **Preview URLs are off.** Each is another public address for a version you uploaded;
  only the one address above exists.
- **The compatibility date is the newest the pinned Wrangler's local runtime accepts.**
  `wrangler dev` will not start on a date its runtime does not know, so the date moves
  when Wrangler does.
