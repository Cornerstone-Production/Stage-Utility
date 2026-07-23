# Bitfocus Companion integration

Lets a Bitfocus Companion module drive and read Stage over its LAN HTTP/SSE API,
for stream-deck-style buttons and feedback.

## How it works

There is nothing for Stage to dial out to — the direction is reversed. The
Companion module (a separate, sideloaded Bitfocus module in its own private repo)
connects **to** this app's existing HTTP/SSE server, so the descriptor carries no
config fields.

The module talks to the same REST endpoints and SSE stream the app's own
displays use (served on port 8788, which always stays up). It marks its event
stream with an `X-Companion-Module` header (or `?client=companion`); the server
tracks those streams in a `companionClients` set and pushes the live count into
the integration manager, so the settings panel can show "N connected".

The in-app "companion" integration is therefore just presence + guidance: it
exposes no dial-out connection and stores no secret. Its master state reflects how
many Companion clients are currently streaming.

## Setup

**In Companion:** add a **Cornerstone Stage Utility** connection and enter this
server's IP and Port (no password — LAN only).

**In Stage:** Settings → Integrations → **Bitfocus Companion**. The panel
(`CompanionInfoPanel`) shows this server's LAN IP and port split out (Companion
takes host + port separately and can't resolve DNS), each copyable, plus a live
connected-client count. There is nothing to enable or test here.

## Files

- `main/services/integration-manager.ts` — `COMPANION_DESCRIPTOR` (no config), `setCompanionClients()`
- `main/services/remote-server.ts` — SSE stream + REST API the module consumes; `companionClients` set keyed off the `X-Companion-Module` header / `?client=companion` marker
- `renderer/components/companion-info-panel.tsx` — IP/port copy fields + connected-client count
