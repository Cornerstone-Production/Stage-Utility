# Stage Monitor — v1 Plan (Extensible: Planning Center + Display + Phone Remote)

## Context

A fullscreen "stage monitor" that runs on a TV behind the wireless-mic/in-ear charger rack. It pulls the upcoming service plan from **Planning Center Online (PCO)** and shows each performer's **channel number, photo, name, and role** in a row of vertical panels (matching the reference photo). Because the display machine has **no keyboard or mouse**, it's fully controllable from a **phone on the same network**.

**Two requirements drive the architecture (asked up front):**

1. **Upgrading/switching wireless gear must be easy** — ideally a settings change, not a code change.
2. **There must be an interface to configure wireless gear and other integrations** — not hardcoded credentials.

So extensibility is a **first-class design goal**, not an afterthought. See the *Extensibility* section.

**Decisions:**

- **Auth:** PCO **Personal Access Token** (App ID + Secret, HTTP Basic) — reliable for an unattended display, no token expiry.
- **v1 scope:** **Core display + remote control + the extensible Integrations layer.** Concrete Shure device drivers (Axient Digital, PSM, SBC220 — TCP) and Bitfocus Companion control land in the next phase because they need live hardware/software on the network to validate. v1 ships the *abstractions and the configuration UI* so those phases are pure additions.
- **No mock data.** v1 shows real PCO people/photos. The per-panel status strip (audio/RF/battery) renders an empty "awaiting device" placeholder — never fabricated numbers — until a wireless provider is connected.

## Extensibility — how gear swaps & new integrations work

This is the heart of the design.

- **One normalized device shape.** All wireless data flows through a single brand-agnostic `DeviceStatus` (rf, battery, frequency, audio level, charging, online…). The display and controller only ever see this shape, so they never care which brand produced it.
- **`DeviceProvider` interface per system.** Each wireless system is a self-contained module implementing `connect / disconnect / listChannels / onStatus`. Providers are kept in `main/providers/wireless/` and registered in a `ProviderRegistry`.
  - **Switching gear = settings change:** Integrations → Wireless Gear → pick provider → enter connection info (IPs/ports) → re-point slot→channel mappings. Display untouched.
  - **Adding an unsupported brand = one new file:** implement `DeviceProvider` for it and register — no changes to the display, controller, IPC, or storage. (Sennheiser, Lectrosonics, RF Venue, etc.)
- **Schema-driven config UI.** Every integration declares a `configSchema` (field key, label, type: text/password/number/select/ip-list, options). The Integrations panel renders a form + connection test + live status from that schema automatically. **Adding a new integration of any kind makes it appear in the UI with zero UI code.**
- **Same pattern for non-wireless integrations.** Planning Center (lineup source) and Companion (control) are described by the same descriptor/schema mechanism, so a future lineup source or control bridge plugs in identically.

## Architecture

One backend source of truth that the phone and the display both read from:

```
 phone (LAN :8788) ──HTTP──┐
                           ├──► StageController ──► broadcast("stage:state-changed") ──► kiosk display
 admin UI (IPC) ───────────┘        │
              ┌─────────────────────┼───────────────────────────┐
       IntegrationManager      SettingsStore/SlotsStore     SlotResolver
       (registry + config)     (+ SecretsStore)             (merge slots+people+device)
         │            │
    LineupProvider  DeviceManager ──► ProviderRegistry ──► DeviceProvider implementations
    (PCO concrete)  (selected provider) │                   (Shure Axient / PSM / ULXD …  ← next phase)
                                        └─► normalized DeviceStatus ─► StageController.applyDeviceStatus()

 FUTURE Companion ──HTTP──► the SAME /api/* endpoints (already Companion-shaped)
```

`StageController` owns current state (service type, active plan, resolved slots incl. device status) and is the **only** broadcaster. Every change — phone, admin UI, or a device provider — funnels through it, so the display always reflects reality in real time.

**Key Glaze decisions (validated against the SDK guide + skills):**

- **LAN HTTP server:** Node built-in `http`, bind `0.0.0.0:8788`, LAN IP via `os.networkInterfaces()`. Track sockets in a `Set` and force-close in `stop()` so the app quits promptly (started after handlers in `app.whenReady`; stopped in the existing `before-quit` hook at `main/index.ts:177`).
- **Secrets:** `safeStorage`-encrypted blob in `userData/secrets.bin` for each integration's secret fields. Non-secret config + state in JSON under `app.getPath("userData")` (two-tier storage model) — never in the repo.
- **Performer photos:** load PCO `photo_thumbnail` URLs through a registered `stage-photo://` custom protocol that fetches once and **disk-caches** under `userData/cache/photos/` — reliable in WKWebView + survives flaky networks. (Scheme registered before window creation; needs a full relaunch to take effect.)
- **Window:** keep the BrowserWindow, then `setFullScreen(true)` for kiosk use (documented override of normal windowed sizing).
- **IPC:** thin `ipcMain.handle("category:method")` → services; live updates via `ipcMain.broadcast`; renderer subscribes with `window.glazeAPI.glaze.ipc.onNotification`; renderer never imports `ipcRenderer`.

## PCO API reference (verified)

- Base `https://api.planningcenteronline.com/services/v2/`; auth `Authorization: Basic base64(appId:secret)`.
- `GET /service_types` — all types.
- `GET /service_types/{id}/plans?filter=future&order=sort_date&per_page=…` — upcoming; auto-select nearest ("next/current").
- `GET /service_types/{id}/plans/{planId}/team_members?include=person,team&per_page=100` — `PlanPerson` with `name`, `photo_thumbnail`, `team_position_name`, `status` (C/U/D), + `person`/`team` relationships.

## File-by-file

**Backend — providers & integration layer (create):**

- `main/types/integrations.ts` — `ConfigField`, `IntegrationDescriptor`, `IntegrationState`, `ConnectionState`.
- `main/types/devices.ts` — normalized `DeviceStatus`, `DeviceProvider` interface, `DeviceChannel`.
- `main/providers/registry.ts` — `ProviderRegistry`: register/lookup wireless providers by id; exposes descriptors for the UI.
- `main/providers/wireless/` — provider modules. **v1:** an inert `NoneProvider` (default) so the system runs with no gear. **Next phase:** `shure-axient.ts`, `shure-psm.ts`, `shure-ulxd.ts` (TCP via `net`, parse ASCII protocol, emit normalized `DeviceStatus`). Stubs/interfaces created in v1 so the registry and UI are real.
- `main/services/device-manager.ts` — instantiates the selected provider from config, subscribes `onStatus` → `StageController.applyDeviceStatus(...)`, tracks connection state.
- `main/services/integration-manager.ts` — registry of all integrations (PCO, Wireless, Companion); holds descriptors + config; `getState/setConfig/setEnabled/test`; persists via stores + secrets; broadcasts `integrations:state-changed`.

**Backend — core services (create under `main/services/`):**

- `data-store.ts` — generic JSON load/save over `userData`.
- `secrets.ts` — `safeStorage`-backed secret get/set per integration; reports `encryptionAvailable`.
- `settings-store.ts` — `settings.json`: selected service type/plan, `planMode`, integration configs (non-secret), display options.
- `slots-store.ts` — `slots.json`: persisted `Slot[]`.
- `pco-service.ts` — Basic-auth PCO client (the concrete `LineupProvider`); `listServiceTypes/listUpcomingPlans/listTeamMembers`; flattens JSON:API to slim DTOs; specific errors (401 → "check App ID/Secret"); ~30s cache.
- `slot-resolver.ts` — pure merge of slots + active plan's team members (fills name/photo) + any device status; always attaches device placeholder.
- `stage-controller.ts` — source of truth; mutating methods end in `broadcast()`; includes `applyDeviceStatus(slotChannel, DeviceStatus)`.
- `remote-server.ts` — `http` server: serves the phone control page + `/api/*` (incl. `/api/integrations*`); permissive CORS; clean shutdown.
- `photo-cache.ts` — fetch+cache PCO photos for the `stage-photo://` handler.

**Backend — modify:**

- `main/index.ts` — instantiate singletons + registry; register `stage-photo` protocol before window creation; `setFullScreen(true)`; `controller.init()` then `remoteServer.start()` + `deviceManager.start()`; stop both in `before-quit`.
- `main/handlers/index.ts` — register stage + integrations handlers (pattern at `main/handlers/index.ts:18`).
- `main/handlers/stage.ts`, `main/handlers/integrations.ts` (create) — thin delegating handlers.
- `main/types/stage.ts` (create) — `Slot`, `SlotDevice`, `StageState`, DTOs.
- `main/windows/settings-window.ts` — repurpose into the desktop "admin" window (mirrors the phone controls).

**Frontend — `renderer/`:**

- `main/stage-view.tsx` (create) — kiosk display: hydrate via `stage:getState`, live-update via `onNotification`, render the panel row; QR + LAN URL hint; empty/not-configured/error states.
- `components/slot-panel.tsx` (create) — vertical panel: channel number top, photo (`stage-photo://`) or solid color for static slots, name overlaid near bottom, `<StatusStrip>` at bottom.
- `components/status-strip.tsx` (create) — audio meter + frequency + battery; dim "awaiting device" placeholder in v1, real values when a provider feeds it.
- `components/qr-hint.tsx` (create) — QR + URL for the phone control page.
- `components/integrations-panel.tsx` (create) — renders the Integrations list + schema-driven config forms (shared shape with the phone page); connect/test/status per integration.
- `main/router.tsx` / `main/root-view.tsx` — route `/` to `StageView`; strip chrome, force dark background for kiosk.
- `settings/settings-view.tsx` — desktop admin: hosts `<IntegrationsPanel>` + service-type/plan picker + slot editor (with optional device-channel binding). Built only with `@glaze/core/components`.
- `renderer/styles.css` — add `@source "./components/**/*.{ts,tsx}";` for Tailwind scanning.
- `renderer/types.d.ts` — renderer mirror of DTO/state/integration types for typed `invoke<T>()`.

**Phone control surface — `public/control.html` (+ `control.js`):** dependency-free, the **primary** setup/control surface. Tabs: **Now** (service type, plan, next/refresh, auto/manual), **Slots** (assign each slot's channel + PCO link or static label + future device-channel binding), **Integrations** (the schema-driven config UI — set PCO credentials, choose/configure wireless provider, configure Companion, test + status). Calls `/api/*`, polls `/api/state`.

## Contracts

**HTTP (`:8788`, JSON + CORS, Companion-compatible):** existing — `GET /`, `GET /api/state`, `GET /api/service-types`, `GET /api/plans?serviceTypeId=`, `POST /api/service-type`, `POST /api/plan`, `POST /api/plan/next`, `POST /api/plan/mode`, `POST /api/refresh`, `POST /api/slots`, `GET /api/health`. **New integrations:** `GET /api/integrations`, `POST /api/integrations/{id}/config`, `POST /api/integrations/{id}/enabled`, `POST /api/integrations/{id}/test`, `GET /api/integrations/wireless/channels`.

**IPC invoke:** `stage:getState/listServiceTypes/listPlans/setServiceType/setPlan/selectNextPlan/setPlanMode/setSlots/refresh/getRemoteUrl`; `integrations:list/setConfig/setEnabled/test`; `wireless:listChannels`.
**IPC broadcast:** `stage:state-changed` → full `StageState`; `integrations:state-changed` → integration states. (Photo bytes go over `stage-photo://`, never IPC.)

## Data model

```ts
// integrations
interface ConfigField { key: string; label: string; type: "text"|"password"|"number"|"select"|"ip-list"; options?: {value:string;label:string}[]; placeholder?: string; }
interface IntegrationDescriptor { id: string; kind: "lineup"|"wireless"|"control"; label: string; configSchema: ConfigField[]; }
interface IntegrationState { id: string; enabled: boolean; connection: "disconnected"|"connecting"|"connected"|"error"; message: string|null; config: Record<string, unknown>; /* secrets masked */ }

// normalized device status — brand-agnostic; what every provider emits and the UI renders
interface DeviceStatus { channelId: string; name: string|null; deviceType: "receiver"|"iem"|"charger"|string; online: boolean; rfBars: number|null; rfLevelDbm: number|null; battery: number|null; charging: boolean|null; frequencyLabel: string|null; audioLevel: number|null; updatedAt: string; }
interface DeviceProvider { readonly id: string; readonly label: string; readonly configSchema: ConfigField[]; connect(cfg: Record<string, unknown>): Promise<void>; disconnect(): Promise<void>; listChannels(): Promise<{id:string;label:string}[]>; onStatus(cb:(s:DeviceStatus)=>void): void; getConnectionState(): IntegrationState["connection"]; }

// slots
type SlotLink = { kind:"pco"; matchBy:"person"; personId:string } | { kind:"pco"; matchBy:"position"; teamPositionName:string } | { kind:"static"; label:string; color:string };
interface SlotDevice { status:"none"|"ok"|"warn"|"error"; rf:number|null; battery:number|null; freq:string|null; audioLevel:number|null; }
interface Slot { id:string; channel:string; order:number; link:SlotLink; deviceBinding?: { providerId:string; channelId:string }|null; displayName?:string|null; photoUrl?:string|null; device:SlotDevice; }

interface StageState { serviceTypeId:string|null; serviceTypeName:string|null; planMode:"auto"|"manual"; planId:string|null; planTitle:string|null; slots:Slot[]; pcoConfigured:boolean; lastRefreshedAt:string|null; remoteUrl:string|null; }
```

Persisted under `userData`: `secrets.bin` (encrypted per-integration secrets), `settings.json` (selections + non-secret integration config), `slots.json`, `cache/photos/`.

## Dependencies

Node built-ins (`http`, `net`, `os`, `crypto`, global `fetch`). Add one runtime dep: **`qrcode`** (pure-JS) for the on-screen QR. No SQLite, no HTTP framework.

## Phasing (what's v1 vs next)

- **v1 (this build):** PCO lineup + photos, fullscreen display, phone remote, persistence, **the full provider/integration abstraction + schema-driven Integrations UI**. Planning Center and Remote/Companion-endpoints are live and configurable now; Wireless Gear appears as a configurable integration whose default is `NoneProvider`.
- **Next phase (needs your hardware):** implement `shure-axient.ts` / `shure-psm.ts` (+ SBC220 charger status) as `DeviceProvider`s — they emit normalized `DeviceStatus`, so `status-strip.tsx` lights up with real RF/battery/frequency and slot device-bindings activate, **with no changes to the UI, controller, IPC, or storage**.
- **Companion:** point its Generic HTTP buttons at the existing `/api/*` endpoints; a `?token=` auth hook is pre-marked.

## Verification

1. **Static:** `npm run type-check && npm run lint` — IPC/DTO shapes line up across `main/types`, handlers, `renderer/types.d.ts`; no forbidden imports.
2. **Build + launch** (full relaunch so `stage-photo` registers). Logs: server "listening on 0.0.0.0:8788", protocol registered, `StageController.init` complete, PCO auth result.
3. **Integrations UI:** open the Integrations panel (phone + desktop) → it lists Planning Center, Wireless Gear, Companion from the registry; PCO shows a generated App ID/Secret form with "Test connection"; Wireless Gear shows a provider dropdown (None / Axient Digital / PSM / ULX-D) with connection fields. Confirm config persists and status reflects connect/test.
4. **PCO:** with real credentials, pick a service type → plans populate; Auto selects nearest upcoming; Manual sticks.
5. **Display:** configure ~7–8 slots (some PCO-linked 01–06, some static "Backup"/"Announcements" + color). Kiosk shows the vertical-panel row — photos via `stage-photo://` (confirm `userData/cache/photos/` fills), names overlaid, channel numbers with leading zeros, status strips showing the dim placeholder (no fake numbers).
6. **Real-time:** change plan/reorder slots from the admin window → kiosk updates instantly (broadcast).
7. **Phone remote:** scan QR / open `http://<lan-ip>:8788` → change service type / Next plan / Refresh / edit integrations → kiosk + integration state reflect it; `GET /api/health` → `{ ok: true }`.
8. **Quit** promptly (sockets force-closed). DOM-inspect to confirm panel count = slot count; screenshot only to sanity-check the dark TV aesthetic + photo fill.
