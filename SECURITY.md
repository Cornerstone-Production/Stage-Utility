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

## Supported versions

Security fixes target the latest release on the `main` branch. Please update to the latest
version before reporting.
