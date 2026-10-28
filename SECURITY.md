# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Report vulnerabilities privately through GitHub's
[**Private vulnerability reporting**](https://github.com/Cornerstone-Production/Stage-Utility/security/advisories/new)
(Security → Advisories → "Report a vulnerability"). We aim to acknowledge reports
within a few days and will coordinate a fix and disclosure timeline with you.

When reporting, please include:

- A description of the issue and its impact.
- Steps to reproduce (a proof of concept if possible).
- Affected version / commit and your environment.

## Scope & notes

- **Secrets at rest.** Integration credentials (Planning Center, ProdCom, Smaart, OBS) are
  encrypted with AES-256-GCM and stored in `secrets.bin`. The 32-byte key is generated on
  first run and, **by default, stored next to the encrypted store** in the data directory
  (`$STAGE_UTILITY_DATA` or `~/.stage-utility`, file mode `0600`).

  Keeping the key beside the ciphertext is deliberate: the app runs as an unattended service
  that auto-starts (e.g. on a Raspberry Pi) with no operator present to type a passphrase, so
  the process must be able to decrypt on its own. Whatever holds the key therefore lives in
  the same trust domain as the service user.

  **What this protects against:** plaintext credentials in config files, accidental commits,
  and config-snapshot exports (secrets are excluded from export/import). Encryption-at-rest is
  *not* a defense against an attacker who already has filesystem read access as the service
  user — anyone with both the key and `secrets.bin` can decrypt. That case is not solvable by
  app-level crypto for an unattended service; see OS-level hardening below.

  **Keeping the key out of a backed-up/synced data dir.** If you back up or sync the data
  directory, the key would travel with the encrypted store and the encryption buys nothing.
  To avoid that, point the key somewhere outside the data dir with one of:
  - `STAGE_UTILITY_KEY_FILE=/absolute/path/to/key` — key file at a path you control (created
    at mode `0600` on first run if absent).
  - `STAGE_UTILITY_KEY=<base64-or-hex>` — a raw 32-byte key supplied directly (e.g. via a
    systemd unit's `Environment=`, a secrets manager, or a Docker secret); no key file is
    written. Generate one with `openssl rand -base64 32`.

- **A credential goes only where it was entered for.** ProdCom's API key, the OBS, Smaart
  and ProVideoPlayer passwords, a Spectera base station's API password and a pulled camera's
  password are sent to an address the operator typed. A save, an import or a config restore
  that changes that address clears the stored credential unless the same change supplies it
  again, and logs that it did. Without that, any settings write, which anyone on the LAN can
  make, could point an integration at another machine and collect the credential on the next
  connect.

  Camera passwords can still be read back, by design: the video feeds export with passwords
  (`GET /api/video/export?passwords=1`), which is how feeds move between servers, answers any
  client that is not a browser on another origin. Against a peer on the LAN this protects the
  integration and wireless credentials, which nothing reads back.

- **A restore can do no more than the settings pages.** A config snapshot can be posted
  by anything on the LAN, and it writes each config file whole. So every file in a restore
  goes through the checks its settings routes apply on a save, and every image in it must have
  the content-hash name and size an upload gives it (a branding image must also be the type
  its name says; a layout upload has never checked that, so neither does a restore of one).
  One failure refuses the whole restore with nothing
  written, cleared or paused. A restore never writes `secrets.bin` or the key, and drops a
  credential it finds inside a config file. What a save checks against the outside world
  (Planning Center, files already on the machine) a restore cannot, and those gaps are listed
  in [Restoring a config snapshot](docs/ops/reliability.md#restoring-a-config-snapshot).

- **OS-level hardening (recommended for appliances).** For a headless install, the defenses
  that actually matter are at the OS layer, not the app: run the service as a dedicated
  unprivileged user; enable full-disk / SD-card encryption (the real protection against a
  stolen or imaged Pi SD card); and keep the port firewalled to the LAN.
- **Network exposure.** The app serves an unauthenticated LAN control panel on its port
  (default `8788`). Run it on a trusted network and restrict the port with your firewall;
  do not expose it directly to the public internet.

- **Other origins can neither read nor write.** A firewall does not help against the browser
  case: any web page an operator visits can send requests to the appliance *from inside the
  LAN*. No response carries an `Access-Control-*` header, so a page on another origin cannot
  read what the app answers, and the browser refuses a cross-site preflight before the request
  it asked about is sent. A state-changing request (`POST`/`PUT`/`PATCH`/`DELETE`) that skips
  the preflight is rejected with `403` unless it is same-origin, which closes off a drive-by
  page triggering an update, a track switch, or a restart mid-service.

  Requests carrying **no** `Origin` header are allowed — that is every non-browser client
  (the Companion module, `curl`, scripts), none of which a hostile web page can impersonate.
  Origins are matched on hostname only, so the friendly port `80`, port `8788`, and the Vite
  dev proxy on `3000` all interoperate. Reads stay open to anything that reaches the port
  directly.

  This is defence against the *browser*, not against a peer on the network: anyone who can
  reach the port directly can still call the API. Firewall the port regardless.

- **Uploaded images run nothing.** Layout and branding images may be SVG, and an SVG opened
  directly is a document that can run script as the app. Every stored image is served with a
  `Content-Security-Policy` that sandboxes it and allows no script, and every response carries
  `X-Content-Type-Options: nosniff`. The app's own pages send no `Content-Security-Policy` and
  no `frame-ancestors`: the Home Assistant integration frames the app in its sidebar from Home
  Assistant's own origin, so refusing to be framed would break it. A page on another origin can
  therefore still frame the app and try to trick a click.

- **DNS rebinding is closed only once refusal is on.** A page whose own hostname is made to
  resolve to this server's address is, to the browser, on the same origin as the app: its
  requests name that hostname in both `Origin` and `Host`, so the checks above pass, and so
  does the cue routes' same-origin exemption below. The one thing that differs is the name in
  `Host`, so the server checks it on every request, before anything else runs.

  Always answered: no `Host` at all, any IP address, `localhost` and names under `.localhost`,
  a name with no dot, names under `.local`, `.internal` and `.home.arpa`, this machine's own
  name and the **Public address**. No website can get a browser to reach the server under any
  of those. Any other name is answered only if it is on the list in **Settings → Advanced →
  Host names**.

  **Refusal is off by default.** While it is off, a name not on the list is still answered,
  logged once on a `[security]` line and listed on that card to accept or dismiss, and the
  sidebar's Advanced entry counts the names waiting. With **Refuse names not on the list** on,
  such a request gets a `403`, reads and writes alike, and an event stream opened by such a
  name is closed. The first time it is turned on it accepts the names plainly in use: seen in
  the last 30 days, over at least a day, and not dismissed. A page can make a browser send any
  name once, so a name seen in one burst is left waiting, and so is every name refused later:
  turning refusal off and on again accepts nothing. The list itself changes only by a request
  whose name is already answered, so a page cannot list its own name for later. The same holds for
  the other routes that can set an answered name: the **Public address**, a config import and a
  snapshot recall. Until refusal
  is on, treat a browser on the app's network that visits untrusted sites as able to reach the
  app.

- **Cue tokens, and what they are not.** Calling a cue (`POST /api/cues/<name>`) presses a
  real button on real gear, usually on behalf of a caller that is not a browser — a voice
  assistant, a script — so it is the one route that requires a credential. Callers present
  `Authorization: Bearer su_…`; a request without a valid token is refused `401` before
  anything is dispatched.

  The exception is a **same-origin browser write**, matching `POST /api/action/invoke` and
  the cue-token writes below: a cue button on a console is an operator standing at the
  console, and the page firing it is on this app's own origin. It grants nothing new — a
  browser on this origin can already press the same gear through `/api/action/invoke`, and
  can edit the cue itself, since the rule routes are ungated like every other setting. Such
  a call is recorded in the activity log as `console` rather than as a token label.

  Tokens are 32 bytes of CSPRNG output, shown **once** at mint. Only a SHA-256 of the token
  is stored, inside the existing AES-256-GCM `secrets.bin`, so reading that file does not
  yield a token that can be replayed. A lost token is replaced, not recovered. Each token
  carries a label and is revoked on its own.

  **The token is not a perimeter.** It identifies the caller in the activity log, and it
  keeps the *call* route shut to anything that has not been handed one. It is not a boundary
  around the app, because anyone with write access over the LAN can change any setting —
  including the cue rules themselves and the token list — exactly as they always could. The
  rule routes are ungated like every other settings route; adding a token to those would
  break the app's own settings page and still not close anything, since the caller could
  mint a token first.

  **The perimeter is the network.** Do not expose this app beyond the LAN or a private
  overlay such as Tailscale. The same applies to Companion, whose own HTTP API is
  unauthenticated: restrict its port with an ACL on the switch (an Aruba ACL on Companion's
  port is what this deployment uses).

  There is **no rate limit and no lockout** on bad tokens: an attacker who can reach the port
  may guess as fast as the network allows. A 32-byte random token makes that hopeless, and a
  peer who can reach the port has easier routes in regardless — but nothing here slows one
  down.

  Cue tokens are for **setup and teardown, not for cues during a service**. A cue carries the
  "no service is live" condition, which fails closed: it refuses while a service is running
  or about to start, and when Planning Center cannot be read at all.

  The same token is required by `POST /api/action/invoke` and by the cue-token *writes*
  (mint, revoke), by `import-pairs` and by `buttons/refresh`, **unless the request is a
  same-origin browser write** — which means an `Origin` naming this server, which a page on
  this app's own origin sends on every `POST` and `DELETE` and a page on any other origin
  cannot forge, short of the DNS rebinding above while refusal is off. `Sec-Fetch-Site` is not required: browsers
  send it only to HTTPS or localhost, and this app is plain HTTP on a LAN address. When it is
  present it must say `same-origin`.

  That exemption is a **browser convenience, not a boundary**: `curl` can type an `Origin` as
  easily as a browser sends one. What it closes is the confused-deputy case — a page on another
  origin cannot forge it. Under DNS rebinding it is the host-name check above, not this
  exemption, that refuses the page.

  Reads are unchanged and remain open to the LAN: the token *list* (labels, ids and last-use
  times — never a hash), the generated Home Assistant fragment (which refers to the token as
  `!secret`, never by value), `/api/companion/buttons` and `/api/companion/pairs`. Nothing
  there presses anything or reveals a secret.

- **Machine updates are signed by the release, not vouched for by the server.** A Mac
  running the output helper and a Windows kiosk each update themselves from the server:
  the helper's zip, and the kiosk's launcher. The server's word is checked twice. The
  SHA-256 it names proves the download is whole. The release's signature, made in CI
  with a private key held only as the `RELEASE_SIGNING_KEY` Actions secret (RSA-3072,
  PKCS#1 v1.5, SHA-256), proves it is what the release published. The updater checks the
  signature against the public key its installer wrote beside it, in a folder only root
  or an administrator can write, and never against one fetched at update time; a
  missing or invalid signature is refused and reported. So something that answers in
  the server's place on the LAN, or a compromised server, can still say *when* a
  machine updates, but cannot hand it a payload of its own.

  The first install is the exception: the installer and the key it installs come from
  the server, over plain HTTP, so `curl ... | sudo sh` and `irm ... | iex` trust that
  server as they always have, and so does any reinstall. An updater installed before
  signing existed checks the SHA-256 only, until its installer is run again. See
  [Signed updates](docs/kiosk-devices.md#signed-updates) and
  [The release signing key](docs/ops/distribution.md#the-release-signing-key), which
  covers rotation.

## Code scanning

CodeQL runs on every pull request. Two of its rules, `js/file-access-to-http` and
`js/http-to-file-access`, flag what this product is for, and the alerts for the
known flows are dismissed with a link to
[Code scanning decisions](docs/reference/code-scanning.md#code-scanning-decisions),
which lists the one fetch function per integration and the origin each is pinned to.

## Supported versions

Security fixes target the latest release on the `main` branch. Please update to the latest
version before reporting.
