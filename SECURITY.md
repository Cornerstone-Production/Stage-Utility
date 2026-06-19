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

- **Secrets at rest.** Integration credentials (e.g. Planning Center) are encrypted with
  AES-256-GCM using a key generated on first run and stored **outside the repository** in
  the data directory (`$STAGE_UTILITY_DATA` or `~/.stage-utility`), with file mode `0600`.
  Back up and protect that directory — anyone with the key file and the encrypted store can
  decrypt the secrets.
- **Network exposure.** The app serves an unauthenticated LAN control panel on its port
  (default `8788`). Run it on a trusted network and restrict the port with your firewall;
  do not expose it directly to the public internet.

## Supported versions

Security fixes target the latest release on the `main` branch. Please update to the latest
version before reporting.
