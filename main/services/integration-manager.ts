// IntegrationManager — registry for all integrations (PCO, Wireless, Companion).
// Holds descriptors + config + state; persist non-secret via settingsStore,
// secrets via secretsStore; broadcasts "integrations:state-changed".

import { errorMessage } from "./errors.js";
import type { IntegrationDescriptor, IntegrationState } from "../types/integrations.js";
import { scrub } from "./scrub.js";
import type { PeopleCountDTO } from "../types/stage.js";
import { addBroadcastListener, broadcast } from "./broadcaster.js";
import { obsService } from "./obs-service.js";
import { resiService } from "./resi-service.js";
import { youtubeService, configComplete, type YouTubeConfig } from "./youtube-service.js";
import { pvpService } from "./pvp-service.js";
import { reaperService } from "./reaper-service.js";
import { scoresService } from "./scores-service.js";
import { scoresStore } from "./scores-store.js";
import { oscManager } from "./osc-manager.js";
import { rosstalkManager } from "./rosstalk-manager.js";
import { prodcomService } from "./prodcom-service.js";
import { propresenterService, propresenterManager, type PropInstanceConfig } from "./propresenter-service.js";
import { secretsStore } from "./secrets.js";
import {
  DEFAULT_POLL_SECONDS as SENSOURCE_DEFAULT_POLL_SECONDS,
  MIN_POLL_SECONDS as SENSOURCE_MIN_POLL_SECONDS,
  type SenSourceConfig,
  sensourceService,
} from "./sensource-service.js";
import { settingsStore } from "./settings-store.js";
import type { ConnectionManagedId } from "./integration-ids.js";
import type { ConnState } from "./integration-base.js";
import { smaartService } from "./smaart-service.js";
import { stageController } from "./stage-controller.js";
import { type TslFeed, tslService } from "./tsl-service.js";
import { wirelessManager } from "./wireless-manager.js";

// PCO integration descriptor.
const PCO_DESCRIPTOR: IntegrationDescriptor = {
  id: "planning-center",
  kind: "lineup",
  label: "Planning Center",
  description:
    "Pulls your Planning Center service plans into Stage — the live rundown, item order, and pre-service countdown. Connects to Planning Center Online over the internet with a Personal Access Token (App ID + Secret). Create the token at api.planningcenteronline.com and paste both halves below.",
  configSchema: [
    {
      key: "appId",
      label: "App ID",
      type: "text",
      placeholder: "your-app-id",
      help: "Create a Personal Access Token at api.planningcenteronline.com → Developers → Personal Access Tokens. The App ID and Secret are shown there.",
    },
    {
      key: "secret",
      label: "Secret",
      type: "password",
      placeholder: "your-secret",
      help: "The Secret half of your PCO Personal Access Token. Stored encrypted on this machine.",
    },
    {
      key: "refreshIntervalMin",
      label: "Refresh interval",
      type: "select",
      placeholder: "How often to pull the latest plan from PCO.",
      help: "How often Stage Utility re-syncs the plan, team roster, and photos from Planning Center. The live on-air countdown updates continuously regardless of this setting.",
      options: [
        { value: "5", label: "5 minutes" },
        { value: "15", label: "15 minutes" },
        { value: "30", label: "30 minutes" },
        { value: "60", label: "1 hour" },
        { value: "120", label: "2 hours" },
      ],
    },
    {
      key: "countdownTarget",
      label: "Pre-service countdown",
      type: "select",
      default: "plan-start",
      help: "What the countdown counts down to before a service is live. \"Plan start\" matches PCO's green timer (the top of the plan / doors) by counting to the service time minus any pre-service items above a \"service start\"-type header; if no such header exists it uses the service time. \"Service start time\" always counts to the PCO service time.",
      options: [
        { value: "plan-start", label: "Plan start (matches PCO)" },
        { value: "service-time", label: "Service start time" },
      ],
    },
  ],
};

// Wireless integration descriptor — master enable toggle only.
// Per-connection config is managed via wireless:* IPC handlers.
const WIRELESS_DESCRIPTOR: IntegrationDescriptor = {
  id: "wireless",
  kind: "wireless",
  label: "Wireless Gear",
  description:
    "Monitors your wireless mics — RF, audio, and battery/charger status — on stage displays. Connects to receivers over your LAN (Shure and Sennheiser supported). Add one connection per receiver below; each channel can then be placed on a layout.",
  configSchema: [],
};

// Companion integration descriptor. There is nothing for the app to dial — the
// Bitfocus Companion module connects TO this app's HTTP/SSE API. So this carries
// no config; the settings panel (CompanionInfoPanel) shows the URL to point
// Companion at and a live connected-client count instead.
const COMPANION_DESCRIPTOR: IntegrationDescriptor = {
  id: "companion",
  kind: "control",
  label: "Bitfocus Companion",
  description:
    "Lets a Bitfocus Companion (Stream Deck) surface control and read Stage. The Companion module connects to this app, so there's nothing to configure here — and nothing to switch on: just point the module at this server's IP and port, shown below. This row reflects how many Companion clients are connected.",
  inbound: true,
  configSchema: [],
};

// ProPresenter integration — reads live slide/item status from the 7.9+ local
// HTTP API (LAN, no auth). Powers the dashboard display.
const PROPRESENTER_DESCRIPTOR: IntegrationDescriptor = {
  id: "propresenter",
  kind: "control",
  label: "ProPresenter",
  description:
    "Shows the current and next slide, section, and slide thumbnails from ProPresenter. Connects to ProPresenter's local network API over your LAN (7.9+). Enable the API under ProPresenter → Preferences → Network, then add each instance below.",
  configSchema: [
    {
      key: "name",
      label: "Name",
      type: "text",
      placeholder: "Main (e.g. Auditorium 1)",
    },
    {
      key: "host",
      label: "ProPresenter Host",
      type: "text",
      placeholder: "192.168.1.100",
    },
    {
      key: "port",
      label: "API Port",
      type: "number",
      placeholder: "1025",
    },
    {
      key: "pollMs",
      label: "Poll interval (ms)",
      type: "number",
      placeholder: "500 (lower = snappier, more requests)",
    },
  ],
};

/** Parse the ProPresenter `config.instances` array (extra auditoriums) into typed
 *  configs, tolerating loosely-shaped stored JSON. */
function parsePropInstances(raw: unknown): PropInstanceConfig[] {
  if (!Array.isArray(raw)) return [];
  const out: PropInstanceConfig[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    if (typeof o.id !== "string" || !o.id) continue;
    const portNum =
      typeof o.port === "number" ? o.port : typeof o.port === "string" ? parseInt(o.port, 10) : NaN;
    const pollNum =
      typeof o.pollMs === "number" ? o.pollMs : typeof o.pollMs === "string" ? parseInt(o.pollMs, 10) : NaN;
    out.push({
      id: o.id,
      name: typeof o.name === "string" && o.name.trim() ? o.name : o.id,
      host: typeof o.host === "string" ? o.host.trim() : "",
      port: Number.isFinite(portNum) ? portNum : 0,
      pollMs: Number.isFinite(pollNum) ? pollNum : undefined,
      enabled: o.enabled !== false,
    });
  }
  return out;
}

// ProdCom integration — subscribes to the live transcription feed from ProdCom's
// HTTP Application API (default port 24480). Powers the transcription display.
const PRODCOM_DESCRIPTOR: IntegrationDescriptor = {
  id: "prodcom",
  kind: "lineup",
  label: "ProdCom",
  description:
    "Streams live production transcription (captions) onto a stage display. Connects to ProdCom's Application API over your LAN. Enter the host and port below; an API key is optional depending on your ProdCom setup.",
  configSchema: [
    {
      key: "host",
      label: "ProdCom Host",
      type: "text",
      placeholder: "192.168.1.201",
    },
    {
      key: "port",
      label: "API Port",
      type: "number",
      placeholder: "24480",
    },
    {
      key: "apiKey",
      label: "API Key",
      type: "password",
      placeholder: "(only if Require Authentication is on)",
    },
  ],
};

// Smaart integration — connects to Smaart's API (JSON-over-WebSocket, default
// port 26000) for live SPL meter values. Modern API (Smaart 8.3+) only.
const SMAART_DESCRIPTOR: IntegrationDescriptor = {
  id: "smaart",
  kind: "control",
  label: "Smaart (SPL)",
  description:
    "Brings FOH sound-level (SPL) readings from Rational Acoustics Smaart onto stage displays. Connects to Smaart v8's API over your LAN (8.3+, JSON over WebSocket). Turn the API on in Smaart, then enter its host, port, and password below.",
  configSchema: [
    {
      key: "host",
      label: "Smaart Host",
      type: "text",
      placeholder: "192.168.1.50",
    },
    {
      key: "port",
      label: "API Port",
      type: "number",
      placeholder: "26000",
    },
    {
      key: "password",
      label: "API Password",
      type: "password",
      placeholder: "(only if the Smaart API requires authentication)",
    },
  ],
};

// OBS Studio integration — connects to OBS's built-in obs-websocket v5 server
// (Tools → WebSocket Server Settings; default port 4455) for live output state
// (e.g. recording) shown by the custom-layout "OBS status" object.
const OBS_DESCRIPTOR: IntegrationDescriptor = {
  id: "obs",
  kind: "control",
  label: "OBS Studio",
  description:
    "Shows whether OBS is recording, streaming, or running its virtual camera, on a stage display. Connects to OBS's built-in obs-websocket server over your LAN. Enable it under OBS → Tools → WebSocket Server Settings, then enter the host, port, and password below.",
  configSchema: [
    {
      key: "host",
      label: "OBS Host",
      type: "text",
      placeholder: "192.168.1.50",
    },
    {
      key: "port",
      label: "WebSocket Port",
      type: "number",
      placeholder: "4455",
    },
    {
      key: "password",
      label: "Server Password",
      type: "password",
      placeholder: "(from OBS → Tools → WebSocket Server Settings)",
    },
  ],
};

// REAPER integration — polls REAPER's built-in Web Interface (Preferences →
// Control/OSC/web → "Web browser interface") for live transport state (e.g.
// recording), shown by the custom-layout "REAPER status" object. No secret: the
// LAN web interface runs without auth in the common setup.
const REAPER_DESCRIPTOR: IntegrationDescriptor = {
  id: "reaper",
  kind: "control",
  label: "REAPER",
  description:
    "Shows whether REAPER is recording, on a stage display. Polls REAPER's built-in Web Interface over your LAN. Turn it on under REAPER → Preferences → Control/OSC/web (Web browser interface), leaving that page's Username:password field blank, then enter the host and port below.",
  configSchema: [
    {
      key: "host",
      label: "REAPER Host",
      type: "text",
      placeholder: "192.168.1.50",
    },
    {
      key: "port",
      label: "Web Interface Port",
      type: "number",
      placeholder: "8080",
    },
  ],
};

// ProVideoPlayer — polls PVP's Network API (Preferences → Network → Network API)
// for the transport state of every layer, shown by the custom-layout
// "ProVideoPlayer layers" object and drivable from automation rules.
//
// PVP has no thumbnail, preview or frame endpoint of any kind, so nothing here
// can ever show a picture of what is on screen — only its name, its state and how
// much of it is left. The description says so, because an operator setting this
// up is entitled to know that before they go looking for a preview.
const PVP_DESCRIPTOR: IntegrationDescriptor = {
  id: "pvp",
  kind: "control",
  label: "ProVideoPlayer",
  description:
    "Shows what ProVideoPlayer has on each layer, and lets automation rules fire cues and clear, hide, mute and fade layers. Polls PVP's Network API over your LAN. Turn it on under ProVideoPlayer → Preferences → Network → Network API, note the port shown there, and enter it below. That port is not the same one PVP serves its API documentation on. If Require Authentication is on, paste the generated token. PVP offers no preview image of any kind, so this reports names, states and times, never a picture.",
  configSchema: [
    { key: "host", label: "ProVideoPlayer Host", type: "text", placeholder: "192.168.1.50" },
    {
      key: "port",
      label: "Network API Port",
      type: "number",
      // What a real PVP install shows under Preferences → Network → Network API.
      // A prefill, not an assumption: initialConfig only uses it when nothing is
      // saved, so an install whose port differs keeps its own. The help stays,
      // because a default that silently disagreed with it would be worse than
      // none — the number below is the Network API port, not the documentation
      // port PVP also advertises.
      default: 50742,
      help: "From Preferences → Network → Network API. Not the documentation port.",
    },
    {
      key: "https",
      label: "Use HTTPS",
      type: "select",
      options: [
        { value: "off", label: "Off" },
        { value: "on", label: "On" },
      ],
      default: "off",
      help: "Match PVP's own 'Use HTTPS Connection' setting. PVP normally uses a self-signed certificate, which this app will not accept.",
    },
    { key: "token", label: "API Token", type: "password", help: "Only if Require Authentication is on in PVP." },
  ],
};

/**
 * Resi — is the encoder streaming, and since when.
 *
 * Account credentials rather than a scoped key because the endpoint that can
 * answer this is Resi's INTERNAL one. Their published Go Live API cannot see a
 * stream it did not start, which rules it out for anyone whose Resi goes live
 * on a schedule. The description says so plainly: an operator handing over a
 * full login deserves to know why, and that it may stop working.
 */
const RESI_DESCRIPTOR: IntegrationDescriptor = {
  id: "resi",
  kind: "control",
  label: "Resi",
  description:
    "Shows whether Resi is streaming, wherever the recording widgets appear. Uses your Resi account sign-in, because Resi's published API can only report on streams it started itself — it cannot see one that began on a Resi schedule. That means this rides an endpoint Resi does not document and could change without notice; if it stops working, nothing else is affected.",
  configSchema: [
    { key: "username", label: "Resi Email", type: "text", placeholder: "you@church.org" },
    { key: "password", label: "Resi Password", type: "password" },
    {
      key: "encoderIds",
      label: "Encoders to watch",
      type: "text",
      placeholder: "leave blank for all",
    },
  ],
};

/**
 * YouTube — two ways to ask, because setup burden should match what is asked.
 *
 * The default reads the channel the way a viewer's client would: an API key and
 * a channel, no consent flow, and it answers the question worth asking when
 * Resi restreams here — is it actually reaching viewers. OAuth is the second
 * mode, for a channel whose broadcasts are private or unlisted, and it costs a
 * consent round-trip and a refresh token to look after.
 */
const YOUTUBE_DESCRIPTOR: IntegrationDescriptor = {
  id: "youtube",
  kind: "control",
  label: "YouTube",
  description:
    "Shows whether you are live on YouTube and for how long, with the real start time YouTube reports. Public channel is the easy setup: make a project at console.cloud.google.com, enable the YouTube Data API v3, create an API key, and paste it below with your channel. Private broadcasts need OAuth instead — the same project, but an OAuth client (Desktop app) authorised once for the youtube.readonly scope, and its refresh token pasted here. If Resi restreams to YouTube, this reports that same broadcast.",
  configSchema: [
    {
      key: "mode",
      label: "How to check",
      type: "select",
      default: "key",
      options: [
        { value: "key", label: "Public channel" },
        { value: "oauth", label: "My broadcasts" },
      ],
      help:
        "Public channel needs an API key and your channel, and sees anything a viewer could — including whether a Resi restream actually arrived. My broadcasts also sees private and unlisted streams, but needs an OAuth client and a refresh token to look after.",
    },
    {
      key: "apiKey",
      label: "API key",
      type: "password",
      showIf: { key: "mode", equals: "key" },
    },
    {
      key: "channel",
      label: "Channel",
      type: "text",
      placeholder: "@yourchurch or UC…",
      showIf: { key: "mode", equals: "key" },
      help: "The channel handle or id. Found in your channel's URL.",
    },
    { key: "clientId", label: "OAuth Client ID", type: "text", showIf: { key: "mode", equals: "oauth" } },
    { key: "clientSecret", label: "OAuth Client Secret", type: "password", showIf: { key: "mode", equals: "oauth" } },
    { key: "refreshToken", label: "Refresh Token", type: "password", showIf: { key: "mode", equals: "oauth" } },
  ],
};

// OSC integration — sends OSC to LAN gear from custom-layout buttons and reflects
// device state back. Targets are managed as a separate list (like wireless), so
// the descriptor itself carries no config fields.
const OSC_DESCRIPTOR: IntegrationDescriptor = {
  id: "osc",
  kind: "control",
  label: "OSC",
  description:
    "Adds layout buttons that send OSC commands to LAN gear (consoles, media servers) and reflect device state back. There's nothing to enter here — manage OSC targets in the list below, then add an OSC button object to a layout.",
  configSchema: [],
};

// RossTalk — outbound command control of Ross gear. Like OSC, targets are a
// separately managed list, so the descriptor carries no config fields.
const ROSSTALK_DESCRIPTOR: IntegrationDescriptor = {
  id: "rosstalk",
  kind: "control",
  label: "RossTalk (Carbonite / Ultrix)",
  description:
    "Sends RossTalk commands to Ross gear — custom controls and switching on a Carbonite, routing and salvos on an Ultrix. Connects over your LAN on TCP 7788. Add one target per device below, then place a RossTalk button on a layout or drive it from an automation rule. Simulate mode logs commands without sending them.",
  configSchema: [],
};

// Upper bound on the poll-interval FORM FIELD only. The poller deliberately has
// no ceiling — an operator throttling to stay inside an API quota is allowed any
// interval — so this lives here with the descriptor rather than being exported
// from the service as an invariant the service does not enforce.
const SENSOURCE_MAX_POLL_SECONDS = 3600;

// SenSource Vea people-counter integration — polls the Vea API for live people
// counts (attendance / occupancy), shown by the custom-layout "People counter"
// object. The operator enters an API client id + secret (created in the Vea
// app); a directly-issued long-lived token can be pasted instead. Location/zone
// selection is handled by a dedicated picker (saved as non-secret config).
const SENSOURCE_DESCRIPTOR: IntegrationDescriptor = {
  id: "sensource",
  kind: "control",
  label: "SenSource Vea",
  description:
    "Brings live people counts — attendance and room occupancy — from SenSource Vea onto displays and graphs. Connects to the Vea cloud API with an API client ID + secret (created in Vea → API clients). Pick which zones to count below.",
  configSchema: [
    {
      key: "clientId",
      label: "API Client ID",
      type: "text",
      placeholder: "(from Vea → API clients)",
      help: "Create an API client in the Vea web app (Settings → API clients). It gives you an ID + secret — enter both. Stage Utility handles the token exchange for you.",
    },
    {
      key: "clientSecret",
      label: "API Client Secret",
      type: "password",
      placeholder: "(from Vea → API clients)",
      help: "The Secret half of the Vea API client (created alongside the Client ID in Vea → API clients). Stored encrypted on this machine.",
    },
    {
      key: "apiToken",
      label: "Static token (optional)",
      type: "password",
      placeholder: "(only if your Vea account issues a long-lived token)",
      help: "Leave blank in the normal case — the client ID + secret above are all you need. Only fill this if your Vea account issues a long-lived token you'd rather use directly.",
    },
    {
      key: "pollSeconds",
      label: "Poll interval (s)",
      type: "number",
      placeholder: String(SENSOURCE_DEFAULT_POLL_SECONDS),
      default: SENSOURCE_DEFAULT_POLL_SECONDS,
      min: SENSOURCE_MIN_POLL_SECONDS,
      max: SENSOURCE_MAX_POLL_SECONDS,
      help: "How often Stage asks Vea for the count. Vea's own numbers advance about every 78 seconds, so the interval is the delay Stage adds on top of that: at 15s the count is at worst 15s behind what the Vea dashboard shows. Below 10s buys nothing — the source has not moved. Raise it to cut API calls.",
    },
  ],
};

// Ross MultiViewer (TSL UMD) integration — pushes a people count to a Ross
// multiviewer tile as on-tile text via TSL UMD 3.1 over TCP. Which count drives
// which tile is configured as "feeds" (a custom panel), saved as non-secret
// config; the descriptor schema carries just the switcher host + TSL port.
const ROSS_TSL_DESCRIPTOR: IntegrationDescriptor = {
  id: "ross-tsl",
  kind: "control",
  label: "Ross MultiViewer (TSL UMD)",
  description:
    "Pushes a people count onto a Ross multiviewer tile as on-tile text, over your LAN using TSL UMD. Enter the switcher host and TSL port below, then map a count to a tile's TSL address in the feeds panel.",
  configSchema: [
    {
      key: "host",
      label: "Switcher Host",
      type: "text",
      placeholder: "192.168.1.60",
    },
    {
      key: "port",
      label: "TSL Port",
      type: "number",
      placeholder: "(TSL UMD input port on the Ross)",
    },
  ],
};

// Live scores — follows chosen teams on ESPN's public scoreboard API. No account
// and no key: the endpoints are public and unauthenticated, which is also why
// there is no contract and why the poll runs on a schedule rather than a fixed
// interval. `configSchema` is empty because the only setting is WHICH TEAMS, and
// a searchable multi-league team picker is not expressible as a ConfigField —
// ScoresTeamsPanel renders it instead (see integrations-panel.tsx).
const SCORES_DESCRIPTOR: IntegrationDescriptor = {
  id: "scores",
  kind: "control",
  label: "Live scores",
  description:
    "Follows your teams' live scores from ESPN's public scoreboard and shows them in the context bar, on Home, and on a stage display. No account or key is needed. ESPN does not document or support this API, so it can change without notice, and the app polls on a schedule to stay well inside what a free public endpoint will tolerate.",
  configSchema: [],
};

const DESCRIPTORS: IntegrationDescriptor[] = [
  PCO_DESCRIPTOR,
  WIRELESS_DESCRIPTOR,
  COMPANION_DESCRIPTOR,
  PROPRESENTER_DESCRIPTOR,
  PRODCOM_DESCRIPTOR,
  SMAART_DESCRIPTOR,
  OBS_DESCRIPTOR,
  REAPER_DESCRIPTOR,
  PVP_DESCRIPTOR,
  RESI_DESCRIPTOR,
  YOUTUBE_DESCRIPTOR,
  OSC_DESCRIPTOR,
  ROSSTALK_DESCRIPTOR,
  SENSOURCE_DESCRIPTOR,
  ROSS_TSL_DESCRIPTOR,
  SCORES_DESCRIPTOR,
];

/** Derived from the descriptors rather than listed again, so an integration
 *  cannot be inbound in one place and dialable in another. */
const inboundIds = new Set(DESCRIPTORS.filter((d) => d.inbound).map((d) => d.id));

/**
 * Is this integration on, at load?
 *
 * An INBOUND one always is: the server listens whether or not anything is
 * stored, so honouring a saved false would put the app's own record out of step
 * with what it is actually doing. That false exists on real installs — the row
 * used to carry a switch, and nothing was ever gated on it, so flicking it off
 * left Companion connecting and controlling the app while the app filed it as
 * disabled. It is ignored rather than migrated: there is nothing to migrate to.
 *
 * Exported for the guard, which is the only way to state this without booting
 * the whole manager.
 */
export function enabledFor(
  descriptor: Pick<IntegrationDescriptor, "id" | "inbound">,
  stored: Record<string, boolean> | undefined,
): boolean {
  return descriptor.inbound === true || (stored?.[descriptor.id] ?? false);
}

/** The registered descriptors, for a guard that needs the real ones. */
export const INTEGRATION_DESCRIPTORS: readonly IntegrationDescriptor[] = DESCRIPTORS;

/** How many things the operator has set up outside `state.config`, for the
 *  integrations whose setup does not live there. Gathered by the manager (which
 *  has the stores) and passed in, so the decision itself stays pure. */
export interface OutOfBandSetup {
  wirelessConnections: number;
  oscTargets: number;
  rossTalkTargets: number;
  followedTeams: number;
}

/**
 * Integrations that keep their setup somewhere OTHER than `state.config`, and
 * what "set up" means for each.
 *
 * These declare `configSchema: []`, so `state.config` is `{}` — and
 * `Object.values({}).some(…)`, the fallback every other integration uses, is
 * false forever. Without an entry here an integration is therefore NEVER
 * configured: its card reopens itself on every visit to the page and it never
 * leaves "Not set up". Live scores shipped exactly that way.
 *
 * Each answer is the operator's own list, which is also what the applier already
 * treats as "ready to start" — an OSC row with no targets and a scores row with
 * no teams are equally not set up, and saying so keeps the card open on the
 * panel that would let them finish. `empty-schema-configured.test.ts` fails if a
 * schema-less integration is added without an entry.
 */
const OUT_OF_BAND_CONFIGURED: Record<
  string,
  (setup: OutOfBandSetup) => boolean
> = {
  wireless: (s) => s.wirelessConnections > 0,
  osc: (s) => s.oscTargets > 0,
  rosstalk: (s) => s.rossTalkTargets > 0,
  scores: (s) => s.followedTeams > 0,
};

/** Ids that answer "configured" from their own list rather than from config. */
export const OUT_OF_BAND_CONFIGURED_IDS: readonly string[] = Object.keys(OUT_OF_BAND_CONFIGURED);

/**
 * Fold a request body into the config to persist and the secrets to store.
 *
 * EXPORTED, and the only copy. This lived inline in `setConfig`, and the test
 * that guarded it reimplemented the loop — so deleting the guard below left the
 * suite green, which was demonstrated before this was extracted. `setConfig`
 * cannot be driven from a unit test (it needs `init()`, which starts the
 * reconnect timers, and it ends by dialling the integration), so the choice was
 * a copy in the test or one function both use. This is the latter.
 *
 * The key comes off an HTTP body, and `out[key] = value` is a property write
 * with a caller-chosen name. `JSON.parse` keeps "__proto__" as an own
 * enumerable key, `Object.entries` yields it, and plain assignment then sets the
 * object's PROTOTYPE rather than a field on it. CodeQL calls this
 * js/remote-property-injection and rates it high.
 *
 * Two defences, deliberately both:
 *   - the reserved names are skipped, so they never reach an assignment;
 *   - the target has a NULL prototype, so even an assignment that slipped past
 *     would create an ordinary own key and could not reach any prototype.
 * The second costs one word and does not depend on the list above staying
 * complete.
 *
 * Skipped rather than rejected: an integration has a fixed set of fields and
 * none is called this, so a body carrying one is junk or an attempt, and
 * neither deserves a 500.
 */
export function foldConfigEntries(
  entries: Record<string, unknown>,
  secretKeys: readonly string[],
  id = "?",
): { config: Record<string, unknown>; secrets: Record<string, string> } {
  const config: Record<string, unknown> = Object.create(null);
  const secrets: Record<string, string> = Object.create(null);
  for (const [key, value] of Object.entries(entries)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      console.warn(`[integration-manager] ignoring reserved config key on ${id}: ${key}`);
      continue;
    }
    if (secretKeys.includes(key)) {
      // Only update the secret if the caller provided a real value (not the mask).
      if (value !== "••••" && value !== "") secrets[key] = String(value);
    } else {
      config[key] = value;
    }
  }
  return { config, secrets };
}

/**
 * Has the operator set this integration up? Independent of the live connection,
 * so the UI can tell "not set up" apart from "set up but currently down".
 *
 * Exported for the guard, which is the only way to state this without booting
 * the whole manager.
 */
export function configuredFor(
  state: Pick<IntegrationState, "id" | "config">,
  setup: OutOfBandSetup,
  inbound: boolean,
): boolean {
  if (inbound) return true; // the other end dials us — nothing to set up
  const outOfBand = OUT_OF_BAND_CONFIGURED[state.id];
  if (outOfBand) return outOfBand(setup);
  // YouTube asks for one of two sets of fields depending on how it is set to
  // check, so "any value present" would call it configured the moment the mode
  // select alone was saved — and the page would stop listing the one thing
  // still needed. The masked secrets read as present here, which is right:
  // a mask means a secret is stored.
  if (state.id === "youtube") {
    const c = state.config;
    return configComplete({
      mode: c.mode === "oauth" ? "oauth" : "key",
      apiKey: String(c.apiKey ?? ""),
      channel: String(c.channel ?? ""),
      clientId: String(c.clientId ?? ""),
      clientSecret: String(c.clientSecret ?? ""),
      refreshToken: String(c.refreshToken ?? ""),
    });
  }
  return Object.values(state.config).some((v) => v !== "" && v != null);
}

// Keys that are secrets for each integration id.
const SECRET_KEYS: Record<string, string[]> = {
  "planning-center": ["secret"],
  wireless: [],
  companion: [],
  propresenter: [],
  prodcom: ["apiKey"],
  smaart: ["password"],
  obs: ["password"],
  pvp: ["token"],
  reaper: [],
  // No account, no key. ESPN's scoreboard endpoints are public and unauthenticated.
  scores: [],
  resi: ["password"],
  youtube: ["apiKey", "clientSecret", "refreshToken"],
  sensource: ["clientSecret", "apiToken"],
  "ross-tsl": [],
};

class IntegrationManager {
  private states = new Map<string, IntegrationState>();

  // ── Init ──────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    console.log("[integration-manager] init");
    propresenterManager.init();
    const settings = await settingsStore.load();

    for (const descriptor of DESCRIPTORS) {
      // Tolerate a settings.json missing this key entirely. DataStore does not
      // deep-merge on load (deliberately — it keeps migrations honest), so an older
      // config snapshot restored over a newer build can arrive without keys added
      // since. Crashing init over it takes every display down.
      const savedConfig = settings.integrationConfigs?.[descriptor.id] ?? {};
      const enabled = enabledFor(descriptor, settings.integrationEnabled);
      const secrets = await secretsStore.getSecrets(descriptor.id);

      // Merge saved non-secret config with any secret keys (masked).
      const maskedConfig: Record<string, unknown> = { ...savedConfig };
      for (const key of SECRET_KEYS[descriptor.id] ?? []) {
        maskedConfig[key] = secrets[key] ? "••••" : "";
      }

      this.states.set(descriptor.id, {
        id: descriptor.id,
        enabled,
        connection: "disconnected",
        message: null,
        config: maskedConfig,
      });
    }

    // Apply PCO credentials to stage controller if already configured. This
    // leaves the badge on "connecting" and kicks the real check off in the
    // background — startup must not block on a round-trip to PCO over the
    // internet (a slow or down link would delay every display coming up).
    await this.applyPcoCredentials();
    void this.verifyPcoCredentials();

    // Start auto-refresh with the persisted interval (defaults to 60 min).
    stageController.startAutoRefresh(this.getPcoRefreshIntervalMs());

    // Initialize wireless connections manager (loads persisted connections,
    // connects enabled real-driver ones).
    await wirelessManager.init();
    // Reflect initial summary state in the master wireless IntegrationState.
    this.refreshWirelessSummary();

    // Start the ProPresenter poller if it's enabled + configured.
    this.applyPropresenter();
    // Start the ProdCom transcript stream if enabled + configured.
    void this.applyProdcom();
    // Start the Smaart SPL connection if enabled + configured.
    await this.applySmaart();
    // Start the OBS connection if enabled + configured.
    await this.applyObs();
    // Start the REAPER web-interface poller if enabled + configured.
    await this.applyReaper();
    // Start the ProVideoPlayer poller if enabled + configured.
    await this.applyPvp();
    // Start the ESPN scores poller if enabled + at least one team is followed.
    await this.applyScores();
    await this.applyResi();
    await this.applyYouTube();
    // Start the OSC manager (UDP send + feedback listener; per-target enable).
    await oscManager.init();
    this.refreshOscSummary();

    await rosstalkManager.init();
    this.refreshRossTalkSummary();
    // Start the SenSource Vea poller if it's enabled + has credentials.
    await this.applySensource();
    // Forward live people counts to the Ross TSL sender (it ignores them when
    // disconnected), then start it if enabled + configured.
    addBroadcastListener((channel, payload) => {
      if (channel === "people:count") tslService.onPeopleCount(payload as PeopleCountDTO);
      // Keep each master row in step with the list that IS its setup. Both halves
      // matter: the summary is the badge ("2 of 3 target(s)"), which only init
      // and the master toggle used to refresh, and the broadcast is what carries
      // `configured` — which now follows the list length, so adding the first
      // receiver or target has to reach the page that is showing "Not set up".
      // Unconditional rather than change-gated: adding a target that is switched
      // off moves `configured` without moving the badge at all.
      if (channel === "wireless:connections-changed") {
        this.refreshWirelessSummary();
        this.broadcastStates();
      }
      if (channel === "osc:targets-changed") {
        this.refreshOscSummary();
        this.broadcastStates();
      }
      if (channel === "rosstalk:targets-changed") {
        this.refreshRossTalkSummary();
        this.broadcastStates();
      }
    });
    await this.applyRossTsl();

    // Last, so the engine's seeding sees a settled system. Its own seeding guard
    // means these first snapshots cannot fire anything regardless.
    const { automationEngine } = await import("./automation-engine.js");
    await automationEngine.init();

    console.log("[integration-manager] init complete", {
      integrations: Array.from(this.states.keys()),
    });
  }

  // ── Public API ─────────────────────────────────────────────────────────

  getDescriptors(): IntegrationDescriptor[] {
    return DESCRIPTORS;
  }

  getStates(): IntegrationState[] {
    // Read the out-of-band lists ONCE, not per integration: each read copies its
    // whole list, and this runs on every broadcast.
    const setup = this.outOfBandSetup();
    return Array.from(this.states.values()).map((s) => ({
      ...s,
      configured: configuredFor(s, setup, inboundIds.has(s.id)),
      ...(inboundIds.has(s.id) ? { inbound: true as const } : null),
    }));
  }

  /** The sizes of the operator's own lists, for the integrations whose setup does
   *  not live in `state.config`. All four are in-memory caches loaded at init, so
   *  no I/O happens here. */
  private outOfBandSetup(): OutOfBandSetup {
    return {
      wirelessConnections: wirelessManager.listConnections().length,
      oscTargets: oscManager.listTargets().length,
      rossTalkTargets: rosstalkManager.listTargets().length,
      followedTeams: scoresStore.get().favourites.length,
    };
  }

  /** Live count of connected Companion-module clients (pushed from remote-server
   *  as SSE streams marked with the X-Companion-Module header connect/close). */
  private companionClients = 0;
  setCompanionClients(count: number): void {
    this.companionClients = count;
    this.setConnectionState(
      "companion",
      count > 0 ? "connected" : "disconnected",
      count > 0 ? `${count} Companion client(s) connected` : null,
    );
    this.broadcastStates();
  }

  /**
   * Re-apply one integration's connection after its config or its enabled flag
   * changed.
   *
   * A map rather than a ladder because there were TWO ladders -- one in
   * setConfig, one in setEnabled -- listing the same integrations in the
   * same order. Adding Resi and YouTube meant remembering both, and an
   * integration added to only one would save its config and never reconnect, or
   * reconnect on a toggle and not on a save. Neither failure says which half was
   * missed.
   *
   * planning-center and wireless are NOT here: they do different work in each
   * caller, so they stay written out where that difference is visible.
   *
   * Typed as Record<ConnectionManagedId, …>, so leaving one out is a compile
   * error rather than an integration that saves and never reconnects. See
   * CONNECTION_MANAGED_IDS for why the other five are absent.
   */
  /**
   * Wire one service's connection reporting, then start or stop it to match the
   * integration's enabled + configured state.
   *
   * Nine appliers were this same body: attach a listener that forwards to
   * setConnectionState and broadcasts, read `enabled`, read the config, then
   * either announce "connecting" and configure, or stop and report disconnected.
   * The pairing is the part worth having once -- an applier that stopped a
   * service without reporting it disconnected leaves the UI showing a live badge
   * for a service that is not running.
   *
   * `plan` is called whether or not the integration is enabled, matching what the
   * appliers did: reading config has no side effects, and keeping the order
   * means this is a pure extraction.
   */
  private async applyService(
    id: ConnectionManagedId,
    service: {
      setConnectionListener(cb: (state: ConnState, message: string | null) => void): void;
      stop(): void;
    },
    plan: () => { connecting: string; start: () => void } | null
      | Promise<{ connecting: string; start: () => void } | null>,
  ): Promise<void> {
    service.setConnectionListener((state, message) => {
      this.setConnectionState(id, state, message);
      this.broadcastStates();
    });

    const enabled = this.states.get(id)?.enabled ?? false;
    const ready = await plan();
    if (enabled && ready) {
      this.setConnectionState(id, "connecting", ready.connecting);
      ready.start();
    } else {
      service.stop();
      this.setConnectionState(id, "disconnected", null);
    }
  }

  private async applyIntegration(id: string): Promise<void> {
    const appliers: Record<ConnectionManagedId, () => void | Promise<void>> = {
      propresenter: () => this.applyPropresenter(),
      prodcom: () => this.applyProdcom(),
      smaart: () => this.applySmaart(),
      obs: () => this.applyObs(),
      pvp: () => this.applyPvp(),
      reaper: () => this.applyReaper(),
      scores: () => this.applyScores(),
      resi: () => this.applyResi(),
      youtube: () => this.applyYouTube(),
      sensource: () => this.applySensource(),
      "ross-tsl": () => this.applyRossTsl(),
    };
    await appliers[id as ConnectionManagedId]?.();
  }

  async setConfig(
    id: string,
    config: Record<string, unknown>,
  ): Promise<IntegrationState> {
    console.log(`[integration-manager] setConfig ${id}`, Object.keys(config));
    const state = this.states.get(id);
    if (!state) throw new Error(`Unknown integration: ${id}`);

    const secretKeys = SECRET_KEYS[id] ?? [];
    const { config: nonSecretConfig, secrets: newSecrets } = foldConfigEntries(config, secretKeys, id);

    // Persist non-secret config.
    //
    // patch, not load-mutate-save. Saving the whole object writes back every
    // field as it was read, so anything written in between is undone -- and one
    // of those fields is idFloors, the high-water mark that stops a deleted view
    // or display id being handed out again. Creating a view while this saved
    // would have rolled the floor back to before it existed.
    const settings = await settingsStore.load();
    // Built once and used for BOTH the write and the mask below. The masked
    // config used to be read back off the object this mutated in place, so
    // dropping the mutation without this would leave the state holding the
    // PREVIOUS config -- which is credentials saved and the integration never
    // started.
    const merged = { ...(settings.integrationConfigs?.[id] ?? {}), ...nonSecretConfig };
    await settingsStore.patch({
      integrationConfigs: { ...settings.integrationConfigs, [id]: merged },
    });

    // Persist secrets (merge with existing so unchanged ones survive).
    if (Object.keys(newSecrets).length > 0) {
      const existing = await secretsStore.getSecrets(id);
      await secretsStore.setSecrets(id, { ...existing, ...newSecrets });
    }

    // Rebuild masked config for state.
    const allSecrets = await secretsStore.getSecrets(id);
    const maskedConfig: Record<string, unknown> = { ...merged };
    for (const key of secretKeys) {
      maskedConfig[key] = allSecrets[key] ? "••••" : "";
    }

    this.states.set(id, { ...state, config: maskedConfig });

    // Side-effects for specific integrations.
    if (id === "planning-center") {
      await this.applyPcoCredentials();
      // Restart auto-refresh with the (possibly updated) interval.
      stageController.startAutoRefresh(this.getPcoRefreshIntervalMs());
      // Validate against PCO and, if it accepts, load the lineup so the kiosk
      // updates immediately. A failure reports an error status but never fails
      // the save — the credentials are already persisted either way.
      //
      // Deliberately NOT awaited. The credentials are already on disk by the time
      // we get here, so everything below is catch-up work for other surfaces, not
      // part of saving. Awaiting it made the save's HTTP response wait on a full
      // PCO lineup fetch — service types, plans, items, team positions — which on
      // a cold cache outruns the renderer's 15s request timeout. The browser then
      // aborted a save that had ALREADY SUCCEEDED, the settings form never got the
      // state back to re-seed from, and "Unsaved changes" stayed on screen telling
      // the operator to save credentials that were sitting safely in secrets.bin.
      // Saving one thing must not be able to fail on how long a different thing
      // takes.
      void this.verifyPcoCredentials()
        .then((ok) => (ok ? stageController.refresh() : undefined))
        .catch((err) => {
          console.error("[integration-manager] post-save PCO refresh failed", err);
        });
    }

    await this.applyIntegration(id);

    this.broadcastStates();
    return this.states.get(id)!;
  }

  async setEnabled(id: string, enabled: boolean): Promise<IntegrationState> {
    console.log(`[integration-manager] setEnabled ${scrub(id)} → ${scrub(enabled)}`);
    const state = this.states.get(id);
    if (!state) throw new Error(`Unknown integration: ${id}`);

    this.states.set(id, { ...state, enabled });

    // patch, for the reason spelled out in the config save above: a whole-object
    // save undoes anything written between the read and the write, id floors
    // included.
    const settings = await settingsStore.load();
    await settingsStore.patch({
      integrationEnabled: { ...settings.integrationEnabled, [id]: enabled },
    });

    if (id === "wireless") {
      // Master toggle: re-apply connections without reloading from disk.
      await wirelessManager.reapply();
      this.refreshWirelessSummary();
    }

    if (id === "planning-center" && !enabled) {
      stageController.setPcoCredentials(null, null);
      this.setConnectionState("planning-center", "disconnected", null);
    }

    await this.applyIntegration(id);

    this.broadcastStates();
    return this.states.get(id)!;
  }

  async test(id: string): Promise<{ ok: boolean; message?: string }> {
    console.log(`[integration-manager] test ${id}`);
    const state = this.states.get(id);
    if (!state) throw new Error(`Unknown integration: ${id}`);

    try {
      if (id === "planning-center") {
        const appId = await this.getPcoAppId();
        const secret = await this.getPcoSecret();
        if (!appId || !secret) {
          return { ok: false, message: "App ID and Secret are required" };
        }
        // Test by listing service types — minimal request.
        const { pcoService } = await import("./pco-service.js");
        const types = await pcoService.listServiceTypes(appId, secret);
        const msg = `Connected — found ${types.length} service type(s)`;
        this.setConnectionState("planning-center", "connected", msg);
        this.broadcastStates();
        return { ok: true, message: msg };
      }

      if (id === "wireless") {
        const connections = wirelessManager.listConnections();
        const connected = connections.filter((c) => c.connection === "connected").length;
        return {
          ok: true,
          message: `${connected} of ${connections.length} connection(s) connected`,
        };
      }

      if (id === "companion") {
        const n = this.companionClients;
        // Companion can't resolve DNS — report the raw LAN IP URL.
        const url = stageController.getState().lanUrl ?? stageController.getState().remoteUrl;
        const msg =
          n > 0
            ? `${n} Companion client(s) connected`
            : `Ready — point Companion at ${url ?? "this server's LAN address"}`;
        this.setConnectionState("companion", n > 0 ? "connected" : "disconnected", msg);
        this.broadcastStates();
        return { ok: true, message: msg };
      }

      if (id === "propresenter") {
        const { host, port } = this.getPropresenterTarget();
        if (!host || !port) {
          return { ok: false, message: "Host and Port are required" };
        }
        const result = await propresenterService.test(host, port);
        this.setConnectionState(
          "propresenter",
          result.ok ? "connected" : "error",
          result.message ?? null,
        );
        this.broadcastStates();
        return result;
      }

      if (id === "prodcom") {
        const { host, port } = this.getProdcomTarget();
        if (!host || !port) {
          return { ok: false, message: "Host and Port are required" };
        }
        const secrets = await secretsStore.getSecrets("prodcom");
        const result = await prodcomService.test(host, port, secrets.apiKey ?? null);
        this.setConnectionState("prodcom", result.ok ? "connected" : "error", result.message ?? null);
        this.broadcastStates();
        return result;
      }

      if (id === "smaart") {
        const { host, port } = this.getSmaartTarget();
        if (!host || !port) {
          return { ok: false, message: "Host and Port are required" };
        }
        const secrets = await secretsStore.getSecrets("smaart");
        const result = await smaartService.test(host, port, secrets.password ?? null);
        this.setConnectionState("smaart", result.ok ? "connected" : "error", result.message ?? null);
        this.broadcastStates();
        return result;
      }

      if (id === "obs") {
        const { host, port } = this.getObsTarget();
        if (!host || !port) {
          return { ok: false, message: "Host and Port are required" };
        }
        const secrets = await secretsStore.getSecrets("obs");
        const result = await obsService.test(host, port, secrets.password ?? null);
        this.setConnectionState("obs", result.ok ? "connected" : "error", result.message ?? null);
        this.broadcastStates();
        return result;
      }

      if (id === "reaper") {
        const { host, port } = this.getReaperTarget();
        if (!host || !port) {
          return { ok: false, message: "Host and Port are required" };
        }
        const result = await reaperService.test(host, port);
        this.setConnectionState("reaper", result.ok ? "connected" : "error", result.message ?? null);
        this.broadcastStates();
        return result;
      }

      if (id === "pvp") {
        const { host, port, https } = this.getPvpTarget();
        if (!host || !port) {
          return {
            ok: false,
            message: "Host and Port are required. The port is the one in PVP's Preferences → Network → Network API.",
          };
        }
        const secrets = await secretsStore.getSecrets("pvp");
        const result = await pvpService.test(host, port, https, secrets.token ?? null);
        this.setConnectionState("pvp", result.ok ? "connected" : "error", result.message ?? null);
        this.broadcastStates();
        return result;
      }

      if (id === "scores") {
        const result = await scoresService.test();
        this.setConnectionState("scores", result.ok ? "connected" : "error", result.message ?? null);
        this.broadcastStates();
        return result;
      }

      if (id === "resi") {
        const { username, password } = await this.getResiConfig();
        if (!username || !password) {
          return { ok: false, message: "Resi email and password are required" };
        }
        const result = await resiService.test(username, password);
        this.setConnectionState("resi", result.ok ? "connected" : "error", result.message ?? null);
        this.broadcastStates();
        return result;
      }

      if (id === "youtube") {
        const result = await youtubeService.test(await this.getYouTubeConfig());
        this.setConnectionState("youtube", result.ok ? "connected" : "error", result.message ?? null);
        this.broadcastStates();
        return result;
      }

      if (id === "sensource") {
        const cfg = await this.getSensourceConfig();
        if (!cfg.apiToken && (!cfg.clientId || !cfg.clientSecret)) {
          return { ok: false, message: "Client ID and Secret (or a static token) are required" };
        }
        const result = await sensourceService.test(cfg);
        this.setConnectionState("sensource", result.ok ? "connected" : "error", result.message ?? null);
        this.broadcastStates();
        return result;
      }

      if (id === "ross-tsl") {
        const { host, port } = this.getRossTslConfig();
        if (!host || !port) {
          return { ok: false, message: "Switcher Host and TSL Port are required" };
        }
        const result = await tslService.test(host, port);
        this.setConnectionState("ross-tsl", result.ok ? "connected" : "error", result.message ?? null);
        this.broadcastStates();
        return result;
      }

      return { ok: false, message: `No test available for integration: ${id}` };
    } catch (err) {
      const msg = errorMessage(err);
      this.setConnectionState(id, "error", msg);
      this.broadcastStates();
      return { ok: false, message: msg };
    }
  }

  // ── Internals ─────────────────────────────────────────────────────────

  private setConnectionState(
    id: string,
    connection: IntegrationState["connection"],
    message: string | null,
  ): void {
    const state = this.states.get(id);
    if (state) {
      this.states.set(id, { ...state, connection, message });
    }
  }

  private getPcoRefreshIntervalMs(): number {
    const state = this.states.get("planning-center");
    const raw = state?.config["refreshIntervalMin"];
    const min = typeof raw === "string" ? parseInt(raw, 10) : typeof raw === "number" ? raw : NaN;
    return Number.isFinite(min) && min > 0 ? min * 60 * 1000 : 60 * 60 * 1000;
  }

  private getPropresenterTarget(): { host: string | null; port: number | null; pollMs: number | null } {
    const cfg = this.states.get("propresenter")?.config ?? {};
    const host = typeof cfg.host === "string" && cfg.host.trim() ? cfg.host.trim() : null;
    const rawPort = cfg.port;
    const port =
      typeof rawPort === "number"
        ? rawPort
        : typeof rawPort === "string" && rawPort.trim()
          ? parseInt(rawPort, 10)
          : NaN;
    const rawPoll = cfg.pollMs;
    const pollMs =
      typeof rawPoll === "number"
        ? rawPoll
        : typeof rawPoll === "string" && rawPoll.trim()
          ? parseInt(rawPoll, 10)
          : NaN;
    return {
      host,
      port: Number.isFinite(port) && port > 0 ? port : null,
      pollMs: Number.isFinite(pollMs) && pollMs > 0 ? pollMs : null,
    };
  }

  /** Start/stop the ProPresenter poller to match enabled + configured state. */
  private applyPropresenter(): void {
    // Reflect live reachability on the Integrations card badge. Idempotent —
    // setting the same listener again just overwrites it.
    propresenterService.setConnectionListener((state, message) => {
      this.setConnectionState("propresenter", state, message);
      this.broadcastStates();
    });

    const enabled = this.states.get("propresenter")?.enabled ?? false;
    const { host, port, pollMs } = this.getPropresenterTarget();
    if (enabled && host && port) {
      // configure() starts polling; the listener flips this to connected/error
      // on the first tick.
      this.setConnectionState("propresenter", "connecting", `Polling ${host}:${port}`);
      propresenterService.configure(host, port, pollMs ?? undefined);
    } else {
      propresenterService.stop();
      this.setConnectionState("propresenter", "disconnected", null);
    }

    // Extra ProPresenter instances (additional auditoriums) — only while enabled.
    const cfg = this.states.get("propresenter")?.config ?? {};
    const defaultName = typeof cfg.name === "string" ? cfg.name : null;
    propresenterManager.apply(defaultName, enabled ? parsePropInstances(cfg.instances) : []);
  }

  private getProdcomTarget(): { host: string | null; port: number | null } {
    const cfg = this.states.get("prodcom")?.config ?? {};
    const host = typeof cfg.host === "string" && cfg.host.trim() ? cfg.host.trim() : null;
    const rawPort = cfg.port;
    const port =
      typeof rawPort === "number"
        ? rawPort
        : typeof rawPort === "string" && rawPort.trim()
          ? parseInt(rawPort, 10)
          : NaN;
    return { host, port: Number.isFinite(port) && port > 0 ? port : null };
  }

  /** Start/stop the ProdCom transcript stream to match enabled + configured state. */
  private async applyProdcom(): Promise<void> {
    prodcomService.setConnectionListener((state, message) => {
      this.setConnectionState("prodcom", state, message);
      this.broadcastStates();
    });

    const enabled = this.states.get("prodcom")?.enabled ?? false;
    const { host, port } = this.getProdcomTarget();
    if (enabled && host && port) {
      const secrets = await secretsStore.getSecrets("prodcom");
      this.setConnectionState("prodcom", "connecting", `Connecting ${host}:${port}`);
      prodcomService.configure(host, port, secrets.apiKey ?? null);
    } else {
      prodcomService.stop();
      this.setConnectionState("prodcom", "disconnected", null);
    }
  }

  private getSmaartTarget(): { host: string | null; port: number | null } {
    const cfg = this.states.get("smaart")?.config ?? {};
    const host = typeof cfg.host === "string" && cfg.host.trim() ? cfg.host.trim() : null;
    const rawPort = cfg.port;
    const port =
      typeof rawPort === "number"
        ? rawPort
        : typeof rawPort === "string" && rawPort.trim()
          ? parseInt(rawPort, 10)
          : NaN;
    // Default to Smaart's standard API port when only a host is given.
    return { host, port: Number.isFinite(port) && port > 0 ? port : host ? 26000 : null };
  }

  /** Start/stop the Smaart SPL connection to match enabled + configured state. */
  private async applySmaart(): Promise<void> {
    smaartService.setConnectionListener((state, message) => {
      this.setConnectionState("smaart", state, message);
      this.broadcastStates();
    });

    const enabled = this.states.get("smaart")?.enabled ?? false;
    const { host, port } = this.getSmaartTarget();
    if (enabled && host && port) {
      const secrets = await secretsStore.getSecrets("smaart");
      this.setConnectionState("smaart", "connecting", `Connecting ${host}:${port}`);
      smaartService.configure(host, port, secrets.password ?? null);
    } else {
      smaartService.stop();
      this.setConnectionState("smaart", "disconnected", null);
    }
  }

  /**
   * A host/port target off an integration's config, defaulting the port.
   *
   * OBS and REAPER had a copy each, identical but for the default port and the
   * id they read. Two copies of a parse is two chances for one to stop accepting
   * a port typed as a string, which is what the settings form sends.
   */
  private hostPort(
    id: ConnectionManagedId,
    defaultPort: number | null,
  ): { host: string | null; port: number | null } {
    const cfg = this.states.get(id)?.config ?? {};
    const host = typeof cfg.host === "string" && cfg.host.trim() ? cfg.host.trim() : null;
    const rawPort = cfg.port;
    const port =
      typeof rawPort === "number"
        ? rawPort
        : typeof rawPort === "string" && rawPort.trim()
          ? parseInt(rawPort, 10)
          : NaN;
    // Only default the port when a host was given AND there is a default worth
    // giving: no host is "not configured", and an integration whose port has no
    // conventional value (PVP's is whatever its Preferences pane shows) must not
    // be reported as configured on the strength of a guess.
    return {
      host,
      port: Number.isFinite(port) && port > 0 ? port : host && defaultPort != null ? defaultPort : null,
    };
  }

  /** obs-websocket's standard port. */
  private getObsTarget() {
    return this.hostPort("obs", 4455);
  }

  /** REAPER's suggested web-interface port. */
  private getReaperTarget() {
    return this.hostPort("reaper", 8080);
  }

  /** PVP's Network API port is whatever its Preferences pane shows. The setup
   *  form PREFILLS 50742 (the descriptor's `default`), which is what a real
   *  install shows — but a prefill is a suggestion the operator saves, and this
   *  is the dialling path. Assuming a port here would let "configured" point at
   *  one nothing is listening on, so a stored value is still required. */
  private getPvpTarget() {
    const { host, port } = this.hostPort("pvp", null);
    return { host, port, https: this.states.get("pvp")?.config.https === "on" };
  }

  /** Start/stop the ProVideoPlayer poll to match enabled + configured state. */
  private async applyPvp(): Promise<void> {
    await this.applyService("pvp", pvpService, async () => {
      const { host, port, https } = this.getPvpTarget();
      if (!host || !port) return null;
      // The state map holds secrets MASKED, so anything that dials has to read
      // the real value back out of the secrets store.
      const secrets = await secretsStore.getSecrets("pvp");
      return {
        connecting: `Connecting ${host}:${port}`,
        start: () => pvpService.configure(host, port, https, secrets.token ?? null),
      };
    });
  }

  /** Start/stop the REAPER web-interface poll to match enabled + configured state. */
  private async applyReaper(): Promise<void> {
    await this.applyService("reaper", reaperService, () => {
      const { host, port } = this.getReaperTarget();
      return host && port
        ? { connecting: `Connecting ${host}:${port}`, start: () => reaperService.configure(host, port) }
        : null;
    });
  }

  /**
   * Re-apply the scores poll after the followed teams changed.
   *
   * Public because the favourites live in their own store rather than in
   * `integrationConfigs`, so saving them does not go through setConfig. It must
   * still go through the applier and not straight to `configure()`: the applier
   * is what honours the integration's ENABLED flag, and calling configure()
   * directly would start polling ESPN for an operator who had deliberately
   * switched the integration off.
   */
  async refreshScores(): Promise<void> {
    await this.applyScores();
    // The followed-teams list IS scores' setup, so `configured` just changed and
    // the panel is holding a cached copy. applyService only broadcasts when the
    // service's own connection listener fires, which it does not when scores is
    // switched off — the case where the card is sitting in "Not set up".
    this.broadcastStates();
  }

  /**
   * Start/stop the ESPN scores poll to match enabled + configured state.
   *
   * "Configured" here means at least one followed team, so the store is loaded
   * first — an empty favourites list must read as not-configured rather than as
   * a poller with nothing to ask about.
   */
  private async applyScores(): Promise<void> {
    await scoresStore.init();
    await this.applyService("scores", scoresService, () => {
      const favourites = scoresStore.get().favourites;
      return favourites.length > 0
        ? {
            connecting: `Following ${favourites.length} team(s)`,
            start: () => scoresService.configure(favourites),
          }
        : null;
    });
  }

  /** Start/stop the Resi encoder-status poll to match enabled + configured state. */
  private async applyResi(): Promise<void> {
    await this.applyService("resi", resiService, async () => {
      const { username, password, encoderIds } = await this.getResiConfig();
      return username && password
        ? { connecting: "Signing in to Resi", start: () => resiService.configure(username, password, encoderIds) }
        : null;
    });
  }

  /** Start/stop the YouTube poll to match enabled + configured state. */
  private async applyYouTube(): Promise<void> {
    await this.applyService("youtube", youtubeService, async () => {
      const cfg = await this.getYouTubeConfig();
      return configComplete(cfg)
        ? { connecting: "Connecting to YouTube", start: () => youtubeService.configure(cfg) }
        : null;
    });
  }

  /** Start/stop the OBS connection to match enabled + configured state. */
  private async applyObs(): Promise<void> {
    await this.applyService("obs", obsService, async () => {
      const { host, port } = this.getObsTarget();
      if (!host || !port) return null;
      const secrets = await secretsStore.getSecrets("obs");
      return {
        connecting: `Connecting ${host}:${port}`,
        start: () => obsService.configure(host, port, secrets.password ?? null),
      };
    });
  }

  /** Resolve the SenSource config from non-secret state + the secrets store. */
  /**
   * Resi's credentials, with the real password.
   *
   * The state map holds secrets MASKED — `password` there is literally "••••" —
   * so anything that talks to Resi must merge in secretsStore. Reading the state
   * value shipped once and could not fail a stub, because a stub accepts any
   * password; the real API answers 401.
   */
  private async getResiConfig(): Promise<{ username: string; password: string; encoderIds: string[] }> {
    const cfg = this.states.get("resi")?.config ?? {};
    const secrets = await secretsStore.getSecrets("resi");
    return {
      username: String(cfg.username ?? "").trim(),
      password: secrets.password ?? "",
      // Comma or whitespace separated, because it is a text field an operator
      // pastes ids into, not a picker.
      encoderIds: String(cfg.encoderIds ?? "").split(/[\s,]+/).filter(Boolean),
    };
  }

  /** YouTube's config, with the real key and OAuth secrets. Same masking rule as
   *  Resi above. */
  private async getYouTubeConfig(): Promise<YouTubeConfig> {
    const cfg = this.states.get("youtube")?.config ?? {};
    const secrets = await secretsStore.getSecrets("youtube");
    const mode = cfg.mode === "oauth" ? "oauth" : "key";
    return {
      mode,
      apiKey: secrets.apiKey ?? "",
      channel: String(cfg.channel ?? "").trim(),
      clientId: String(cfg.clientId ?? "").trim(),
      clientSecret: secrets.clientSecret ?? "",
      refreshToken: secrets.refreshToken ?? "",
    };
  }

  private async getSensourceConfig(): Promise<SenSourceConfig> {
    const cfg = this.states.get("sensource")?.config ?? {};
    const secrets = await secretsStore.getSecrets("sensource");
    const rawPoll = cfg.pollSeconds;
    const pollSeconds =
      typeof rawPoll === "number"
        ? rawPoll
        : typeof rawPoll === "string" && rawPoll.trim()
          ? parseInt(rawPoll, 10)
          : NaN;
    return {
      clientId: typeof cfg.clientId === "string" && cfg.clientId.trim() ? cfg.clientId.trim() : null,
      clientSecret: secrets.clientSecret || null,
      apiToken: secrets.apiToken || null,
      pollSeconds: Number.isFinite(pollSeconds) && pollSeconds > 0 ? pollSeconds : SENSOURCE_DEFAULT_POLL_SECONDS,
      locationId:
        typeof cfg.locationId === "string" && cfg.locationId.trim() ? cfg.locationId.trim() : null,
      zoneIds: Array.isArray(cfg.zoneIds) ? cfg.zoneIds.filter((z): z is string => typeof z === "string") : [],
    };
  }

  /** List Vea locations for the settings picker (uses the saved credentials). */
  async getSensourceLocations(): Promise<{ locationId: string; name: string }[]> {
    const cfg = await this.getSensourceConfig();
    if (!cfg.apiToken && (!cfg.clientId || !cfg.clientSecret)) {
      throw new Error("Enter and save SenSource credentials first");
    }
    return sensourceService.listLocationsWith(cfg);
  }

  /** List Vea zones for the settings picker — the reliable scoping mechanism
   *  (the API has no working server-side location/zone filter). */
  async getSensourceZones(): Promise<{ zoneId: string; name: string; locationId: string | null }[]> {
    const cfg = await this.getSensourceConfig();
    if (!cfg.apiToken && (!cfg.clientId || !cfg.clientSecret)) {
      throw new Error("Enter and save SenSource credentials first");
    }
    return sensourceService.listZonesWith(cfg);
  }

  /** Start/stop the SenSource poller to match enabled + credentialed state. */
  private async applySensource(): Promise<void> {
    sensourceService.setConnectionListener((state, message) => {
      this.setConnectionState("sensource", state, message);
      this.broadcastStates();
    });

    const enabled = this.states.get("sensource")?.enabled ?? false;
    const cfg = await this.getSensourceConfig();
    const hasCreds = !!cfg.apiToken || (!!cfg.clientId && !!cfg.clientSecret);
    if (enabled && hasCreds) {
      this.setConnectionState("sensource", "connecting", "Authenticating with SenSource Vea");
      sensourceService.configure(cfg);
    } else {
      sensourceService.stop();
      this.setConnectionState("sensource", "disconnected", null);
    }
  }

  /** Resolve the Ross TSL config (host/port + the feed→display-index mappings). */
  private getRossTslConfig(): { host: string | null; port: number | null; feeds: TslFeed[] } {
    const cfg = this.states.get("ross-tsl")?.config ?? {};
    const host = typeof cfg.host === "string" && cfg.host.trim() ? cfg.host.trim() : null;
    const rawPort = cfg.port;
    const port =
      typeof rawPort === "number"
        ? rawPort
        : typeof rawPort === "string" && rawPort.trim()
          ? parseInt(rawPort, 10)
          : NaN;
    const feeds = Array.isArray(cfg.feeds) ? (cfg.feeds as TslFeed[]) : [];
    return { host, port: Number.isFinite(port) && port > 0 ? port : null, feeds };
  }

  /** Start/stop the Ross TSL sender to match enabled + configured state. */
  private async applyRossTsl(): Promise<void> {
    tslService.setConnectionListener((state, message) => {
      this.setConnectionState("ross-tsl", state, message);
      this.broadcastStates();
    });

    const enabled = this.states.get("ross-tsl")?.enabled ?? false;
    const { host, port, feeds } = this.getRossTslConfig();
    if (enabled && host && port) {
      this.setConnectionState("ross-tsl", "connecting", `Connecting ${host}:${port}`);
      tslService.configure(host, port, feeds);
    } else {
      tslService.stop();
      this.setConnectionState("ross-tsl", "disconnected", null);
    }
  }

  private async getPcoAppId(): Promise<string | null> {
    const settings = await settingsStore.load();
    return String(settings.integrationConfigs?.["planning-center"]?.appId ?? "") || null;
  }

  private async getPcoSecret(): Promise<string | null> {
    const secrets = await secretsStore.getSecrets("planning-center");
    return secrets.secret || null;
  }

  private async applyPcoCredentials(): Promise<void> {
    const appId = await this.getPcoAppId();
    const secret = await this.getPcoSecret();
    const settings = await settingsStore.load();
    const target = settings.integrationConfigs?.["planning-center"]?.countdownTarget === "service-time" ? "service-time" : "plan-start";
    stageController.setPcoCredentials(appId, secret, target);

    if (!appId || !secret) {
      this.setConnectionState("planning-center", "disconnected", null);
      return;
    }
    // Credentials being PRESENT is not the same as them being VALID. This used to
    // report "connected" on any non-empty pair, so a revoked or mistyped token
    // showed a green badge while every refresh failed with "PCO auth failed" —
    // the panel and the app disagreed and the panel was the convincing one.
    // Ask PCO instead. Unlike the other integrations there is no socket whose
    // success speaks for itself: PCO is stateless HTTPS, so a request IS the check.
    this.setConnectionState("planning-center", "connecting", "Checking credentials…");
  }

  /**
   * Ask PCO whether the stored credentials actually work and report the truth.
   * Never throws — a failure is a reported state, not an exception, so it can be
   * called at startup without risking init.
   *
   * @returns true when PCO accepted the credentials.
   */
  private async verifyPcoCredentials(): Promise<boolean> {
    const appId = await this.getPcoAppId();
    const secret = await this.getPcoSecret();
    if (!appId || !secret) {
      this.setConnectionState("planning-center", "disconnected", null);
      this.broadcastStates();
      return false;
    }
    try {
      const { pcoService } = await import("./pco-service.js");
      const types = await pcoService.listServiceTypes(appId, secret);
      this.setConnectionState("planning-center", "connected", `Connected — ${types.length} service type(s)`);
      this.broadcastStates();
      // The poller stands down on an auth failure, and start() is otherwise
      // called only at boot — so without this, fixing the credentials would
      // leave the countdown dead until someone restarted the server.
      // Idempotent: start() is a no-op when it is already running.
      void import("./live-poller.js")
        .then((m) => m.livePoller.start())
        .catch((err) => console.error("[integration-manager] could not restart the live poller:", err));
      return true;
    } catch (err) {
      const msg = errorMessage(err);
      console.warn(`[integration-manager] PCO credential check failed: ${msg}`);
      this.setConnectionState("planning-center", "error", msg);
      this.broadcastStates();
      return false;
    }
  }

  /**
   * Refresh the master wireless IntegrationState to reflect an aggregated
   * summary of all connections managed by WirelessManager.
   */
  private refreshWirelessSummary(): void {
    const connections = wirelessManager.listConnections();
    const connected = connections.filter((c) => c.connection === "connected").length;
    if (connected > 0) {
      this.setConnectionState(
        "wireless",
        "connected",
        `${connected} of ${connections.length} connection(s) connected`,
      );
    } else {
      this.setConnectionState("wireless", "disconnected", null);
    }
  }

  /**
   * Reflect the RossTalk targets on the master "rosstalk" row. Unlike OSC this is
   * TCP, so "connected" here means a socket is genuinely open — and the message
   * carries simulate mode, because a connected badge would otherwise imply commands
   * are reaching the device when they are being swallowed.
   */
  refreshRossTalkSummary(): void {
    const targets = rosstalkManager.listTargets();
    const enabled = targets.filter((t) => t.enabled);
    const connected = enabled.filter((t) => t.connection === "connected").length;
    const sim = rosstalkManager.getSimulate() ? " — simulate mode" : "";
    if (enabled.length === 0) {
      this.setConnectionState("rosstalk", "disconnected", targets.length ? `${targets.length} target(s)` : null);
    } else if (connected > 0) {
      this.setConnectionState("rosstalk", "connected", `${connected} of ${enabled.length} target(s)${sim}`);
    } else {
      this.setConnectionState("rosstalk", "error", `0 of ${enabled.length} target(s) reachable${sim}`);
    }
  }

  /** Reflect an aggregated summary of OSC targets on the master "osc" state. */
  refreshOscSummary(): void {
    const targets = oscManager.listTargets();
    const enabled = targets.filter((t) => t.enabled).length;
    if (enabled > 0) {
      this.setConnectionState("osc", "connected", `${enabled} target(s) active`);
    } else {
      this.setConnectionState("osc", "disconnected", targets.length ? `${targets.length} target(s)` : null);
    }
  }

  private broadcastStates(): void {
    broadcast("integrations:state-changed", this.getStates());
  }
}

export const integrationManager = new IntegrationManager();
