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
4. Harden the zone, in the domain's own settings:
   - **SSL/TLS → Edge Certificates**: **Always Use HTTPS** on, **HSTS** on (6 months,
     subdomains included, preload off), **Minimum TLS Version** 1.2. The Worker
     redirects plain `http` and sends HSTS on its own as well, so the page stays on
     `https` if a setting is turned off.
   - **DNS → Settings**: **DNSSEC** on.
   - **Domain Registration**: **Auto-renew** on. A lapsed domain can be bought by
     anyone, and the link and QR codes already handed out would open their page.
   - Two-factor sign-in on every account with access: whoever can sign in can deploy
     any page to this address.

## Updating it

A change to ServiceCue reaches the public page in one of two ways: the server that
publishes to it updates it once it has a Cloudflare API token
([Keeping it up to date](#keeping-it-up-to-date)), or you run `npm run servicecue:deploy`
again. The docs and rundowns the page shows are not part of a deploy: they come from
what Stage Utility sends.

### Keeping it up to date

The server the page is linked to (the one holding its address and its publishing token)
can put each new build of the page on Cloudflare itself, from the copy every build
carries ([below](#the-copy-every-build-prepares)). It does so once it has a Cloudflare
account ID and an API token for the page's Worker, and stops when the token is cleared.
There is no other switch. The first Worker and its domain stay a manual, one-time job:
the server only ever updates a Worker that exists.

**Make the token.** Cloudflare's [Workers roles](https://developers.cloudflare.com/workers/authorization/workers/)
apply to API tokens as they do to members: "API tokens use the same Workers roles and
scopes", and "per-Worker roles apply only to the Workers you select". Create a token with
the **Editor** Workers role on the `servicecue` Worker only. Editor "can read, update,
deploy, and rename existing Workers" and "cannot create or delete Workers"; scoped to one
Worker it reaches no other Worker, no DNS, domain or zone setting, and nothing else on the
account. Creating a Worker needs the **Admin** role, which the server never needs: the
Worker is made once, by hand, before the token (a role cannot be given on a Worker that
does not exist yet). Prefer a token owned by the church's account over one owned by a
person.

**Find the account ID.** It is the 32-character id in the address of any page of the
Cloudflare dashboard (`dash.cloudflare.com/<account id>/...`), and on the **Workers &
Pages** overview, on the right.

**Give them to the server.** On the ServiceCue presets page (`/servicecue/presets`), switch
the **Public link** card on first (the credentials are saved for the page's address), open
**Cloudflare connection** and find **Keep the page up to date**:

1. Paste the account ID into **Cloudflare account ID**.
2. Paste the token into **API token**, and leave the field. Both are saved together, and
   the status line below them says where the page stands. The field shows dots from then
   on, and the token is never shown again.

There is no switch: pasting a token turns updating on, and clearing the field turns it
off, after the card asks to be sure (the token is deleted from the server, and turning updating
on again needs a new token from Cloudflare). A token pasted with no account ID (or the reverse) is not saved until the other is
filled in. To replace a token, paste the new one over the dots. The same two writes are
`POST /api/servicecue/publish/deploy-credentials` ([API](../reference/api.md)), for a
script or `curl`.

The token is stored encrypted beside the publishing token and is never sent back or
included in a backup. Changing the page's address drops both. Revoking the token in
Cloudflare is enough to stop it too: the next attempt is refused, the card and the log say
so, and nothing more is tried until the token is changed.

**What the server does, and when.** Each time it reads the page's status (when
publishing starts, then every few minutes) it compares the build the page serves with
the build it carries. When they differ:

| If | The server |
|---|---|
| a service is live in Planning Center | waits, looking again every 30 seconds, and deploys when it ends. It never deploys through a live service, as recording never stops for one |
| the live state is not known: the server has just started and not yet read Planning Center, or Planning Center cannot be reached | waits the same way, counting unknown as live. Only an explicit "Update the page now" goes ahead of it |
| the page was deployed from a **newer** version than this server runs, or from this server's own version by **another build** | leaves it |
| otherwise | deploys, and logs the files uploaded and the files Cloudflare already held |

**The no-downgrade rule.** The page records the version of the server that deployed it,
in the Worker version's message (`Stage Utility 1.28.0`). A server never replaces a page
deployed from a newer version than the one it is running, so a development machine
pointed at the same page cannot roll it back. The comparison is semver (a prerelease is
older than its release) and is against the version the server is **running**, not the
`version` in `deploy.json`, which is only the version the folder was last made at. A page
with no recorded version (one deployed with plain `wrangler deploy`, or before this
existed) is deployed over. The same version from another build is left alone too: two servers at one
version would otherwise take the page back from each other every few minutes. A page
deployed with `npm run servicecue:deploy` carries the same record (its version's message is
`Stage Utility <version>` and its tag the build id), so a hand deploy is not mistaken for
an old page. The one way to replace a page that is left alone is the explicit request
below, with a confirmation.

**Update the page now** is the button under the status line, and `POST /api/servicecue/publish/deploy`.
When the page was left alone because it is newer, or another build of this server's version,
the card asks first, naming both versions, and **Replace the page** sends the request again
with `confirmDowngrade`. A request made within a minute of a deploy says "Try again in N s", a page
already on this build says "Already up to date", and a deploy that went ahead while Planning
Center had not said whether a service is live says so. The button waits while an update is under way.
The route deploys when the
page is older or another build; answers `200` with `already: "current"` and uploads nothing
when the page is already this build; refuses with `409` and `code: "newer"` or
`"other-build"` when the page was left alone, unless the body says
`{"confirmDowngrade": true}`; refuses with `409` and `code: "service-live"` while a
service is live, always; goes ahead when the live state is merely unknown (just after a
restart, or with Planning Center unreachable), and then the answer carries
`serviceState: "unknown"`; and answers `429` with a `Retry-After` when it has deployed in
the last minute.

**If the page still does not change.** A deploy that goes through while the page keeps
serving the old build can mean the Worker the token and account name is not the one the
page address points at. The server gives the page two minutes to catch up. After that, a
second status read that still shows another build, with Cloudflare holding this server's
build, is reported in the log and on the card (`deployed build X to Worker 'servicecue',
but the page still serves Y: is that Worker the page?`), and nothing more is deployed on
its own. A read with no build says nothing either way, and if Cloudflare holds another
server's build instead, that is the newer or other-build case, not this. The hold lifts
when a status read shows the page serving this build, when the credentials change, or on
a successful "Update the page now".

**If an update fails.** The page keeps what it had: Cloudflare swaps a Worker's version
all at once. The server records Cloudflare's error code and words, and tries again after
a minute, then two, doubling to at most once an hour. A `401` or `403` is not tried again
until the token changes. The status line says what failed, in Cloudflare's own
words, that the page is unchanged, and when it tries again; for a refused token it says to
make a new one and paste it. The same status is the `deploy` the `GET
/api/servicecue/publish` answer carries ([API](../reference/api.md)).

**The status line** on the card says one of (a failed update, or a build with no copy of the page, opens **Cloudflare connection** by itself):

| It says | Meaning |
|---|---|
| Up to date: build X (version), deployed *time* | the page is the build this server carries; the time is in the app's time zone |
| Updating the page… N files to upload, M already on Cloudflare | a deploy is under way |
| Waiting for the service to end, then updating to build X (version) | a service is live in Planning Center; the page is left alone until it ends |
| Waiting to hear whether a service is live, then updating | the live state is not known yet (the server has just started, or Planning Center cannot be reached); Update the page now goes ahead when the state is merely unknown, never through a live service |
| Couldn't update the page: *reason*. The page is unchanged. | the last attempt, or a read of what is deployed, failed |
| The page runs build X (version), newer than this server's Y | the page is left alone (no-downgrade rule) |
| The page runs build X of this server's own version, deployed by another server | the page is left alone |
| This server's build has no copy of the page | the reason is in the log |
| Updating is on. The page's build has not been read yet. | a token is set, and publishing has not reached the page yet |
| Not updating: with no API token, the page stays on the build it has… | no token is set |

**Try one by hand.** `npm run servicecue:deploy-try` runs the server's own deployer once,
printing each step, against a Worker you name. Try it on a scratch Worker first.

1. Make the scratch Worker once, by hand, with an Admin login: `npx wrangler login` in
   `publish/servicecue`, then a deploy under another name (`npx wrangler deploy --name
   scratch` after `npm run servicecue:build`), or create one in the dashboard. The
   script never creates a Worker: a Worker that is not there is an error.
2. Make a token with the Editor role on **that scratch Worker** (see above), not on
   `servicecue`.
3. Run it:

```bash
CLOUDFLARE_ACCOUNT_ID=<id> CLOUDFLARE_API_TOKEN=<token> \
  npm run servicecue:deploy-try -- --script scratch --check
```

`--check` verifies the token and reads what the Worker holds and sends nothing. Without
it the deploy is made, and the script reads back the version and build it recorded. The
real Worker's name is refused unless `--production` is added. "The Worker does not exist
on this account" is a 404. A token scoped to other Workers gets a 403 instead, for a
missing Worker as well, so "this token has no access to the Worker" means either it does
not exist or the token is not given Editor on it.

### The copy every build prepares

Every build of Stage Utility, a release archive included, also prepares the public page
for upload, in `build/servicecue/`:

| File | What it is |
|---|---|
| `worker.js` | The Worker as one module, the same one `wrangler deploy` uploads |
| `public/` | The built page: every file the asset service serves |
| `deploy.json` | The Worker's name, the build id of the page, the app's version, the Worker's compatibility date and flags, its asset rules, its bindings and variables, its Durable Object `exports`, and `keep_bindings`, each read from `wrangler.jsonc` and the build |

The page's `_headers` file is not in `public/`. Wrangler does not upload it as an asset:
it reads it as configuration and sends its text in the assets config. `deploy.json` does
the same, in `assets._headers` beside `run_worker_first`, so `assets` is the config an
upload sends as it stands and `public/` is the list of files to upload. `keep_bindings`
(`secret_text`, `secret_key`) is what keeps the publishing token across an upload that
does not name it, as it does for `wrangler deploy`.

`npm run servicecue:bundle` makes the same folder on its own. It needs nothing but what
`npm ci --include=dev` installs: not wrangler, not a login. It does not touch
`publish/servicecue/public/` or change what `npm run servicecue:deploy` does.

A build that cannot make the folder says so in the update log and carries on, so an
update is never stopped by it:

```
[servicecue-bundle] FAILED, so this server cannot update the public ServiceCue page from this build (the app is unaffected): <reason>
```

It removes whatever it had written, so a folder that is there is a finished one, and
leaves `build/servicecue.failed` beside it: the commit it failed on, then the reason.
A build that succeeds removes the marker. An update on a checkout with no bundle rebuilds,
unless the marker names the commit the update starts from and nothing the build reads
changed, in which case it does not retry; the marker then moves to the new commit. An
update that changes the Worker, its config, the page's document or the shared contract
rebuilds, and so does a change to anything the interface is built from. `version` in
`deploy.json` is the version the folder was made at: a release that changes none of those
leaves the folder, and its version, as they were.

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
- **The page is behind the server's build.** The server's side is the `[servicecue-deploy]`
  lines in the app's [log](updates-and-logs.md): each decision once (deploying and why,
  the page already current, skipped as the page is newer, waiting for a live service, no
  token, no copy of the page in this build), the files uploaded and the files already
  held, the build deployed, and every failure with Cloudflare's code and words. A refused
  token reads `HTTP 401` or `403` and `Not trying again until the token changes`.
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

A Cloudflare API token for [keeping the page up to date](#keeping-it-up-to-date) is a
different secret. Held by someone else, it lets them put their own page on this address
for as long as it works, which the publishing token cannot do. Delete it in Cloudflare
when it may have been seen or the person who made it leaves, and clear it from the
server by clearing the **API token** field under **Keep the page up to date** (or by sending
`{"token": ""}` to `/api/servicecue/publish/deploy-credentials`).

To rotate the publishing token, set a new one with the two commands in step 4 and update Stage Utility;
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
