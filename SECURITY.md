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

- **DNS rebinding is not closed.** A page whose own hostname is made to resolve to this
  server's address is, to the browser, on the same origin as the app: its requests name that
  hostname in both `Origin` and `Host`, so the checks above pass, and so does the cue routes'
  same-origin exemption below. The page can read and write as the app's own pages do, press
  cues and mint a cue token. Nothing in the app refuses a request by the host name it was sent
  to yet. Until it does, treat a browser on the app's network that visits untrusted sites as
  able to reach the app.

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
  cannot forge, short of the DNS rebinding above. `Sec-Fetch-Site` is not required: browsers
  send it only to HTTPS or localhost, and this app is plain HTTP on a LAN address. When it is
  present it must say `same-origin`.

  That exemption is a **browser convenience, not a boundary**: `curl` can type an `Origin` as
  easily as a browser sends one. What it closes is the confused-deputy case — a page on another
  origin cannot forge it — except under DNS rebinding, which it does not close.

  Reads are unchanged and remain open to the LAN: the token *list* (labels, ids and last-use
  times — never a hash), the generated Home Assistant fragment (which refers to the token as
  `!secret`, never by value), `/api/companion/buttons` and `/api/companion/pairs`. Nothing
  there presses anything or reveals a secret.

## Code scanning

CodeQL runs on every pull request. Two of its rules, `js/file-access-to-http` and
`js/http-to-file-access`, flag what this product is for, and the alerts for the
known flows are dismissed with a link to
[Code scanning decisions](docs/reference/code-scanning.md#code-scanning-decisions),
which lists the one fetch function per integration and the origin each is pinned to.

## Supported versions

Security fixes target the latest release on the `main` branch. Please update to the latest
version before reporting.
