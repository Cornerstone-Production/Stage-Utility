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

- **Cross-origin writes are blocked.** A firewall does not help against the browser case: any
  web page an operator visits can issue requests to the appliance *from inside the LAN*, and
  DNS rebinding makes that reachable from the public internet. State-changing requests
  (`POST`/`PUT`/`PATCH`/`DELETE`) are therefore rejected with `403` unless they are
  same-origin, which closes off a drive-by page triggering an update, a track switch, or a
  restart mid-service.

  Requests carrying **no** `Origin` header are allowed — that is every non-browser client
  (the Companion module, `curl`, scripts), none of which a hostile web page can impersonate.
  Origins are matched on hostname only, so the friendly port `80`, port `8788`, and the Vite
  dev proxy on `3000` all interoperate. `GET` is unchanged and remains open to the LAN.

  This is defence against the *browser*, not against a peer on the network: anyone who can
  reach the port directly can still call the API. Firewall the port regardless.

- **Cue tokens, and what they are not.** Calling a cue (`POST /api/cues/<name>`) presses a
  real button on real gear on behalf of a caller that is not a browser — a voice assistant, a
  script — so it is the one route that requires a credential. Callers present
  `Authorization: Bearer su_…`; a request without a valid token is refused `401` before
  anything is dispatched.

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
  cannot forge. `Sec-Fetch-Site` is not required: browsers send it only to HTTPS or localhost,
  and this app is plain HTTP on a LAN address. When it is present it must say `same-origin`.

  That exemption is a **browser convenience, not a boundary**: `curl` can type an `Origin` as
  easily as a browser sends one. What it closes is the confused-deputy case — a page on another
  origin cannot forge it.

  Reads are unchanged and remain open to the LAN: the token *list* (labels, ids and last-use
  times — never a hash), the generated Home Assistant fragment (which refers to the token as
  `!secret`, never by value), `/api/companion/buttons` and `/api/companion/pairs`. Nothing
  there presses anything or reveals a secret.

## Supported versions

Security fixes target the latest release on the `main` branch. Please update to the latest
version before reporting.
