// servicecue-publish.ts — the contract for ServiceCue on the web.
//
// One module, imported by all three parties to the protocol, so none of them can
// drift from the others:
//
//   - the Cloudflare Worker in publish/servicecue/, which receives what a Stage
//     Utility server publishes and serves it to anyone with the link;
//   - the public viewer (renderer/public/), which reads it and draws ServiceCue;
//   - the publisher inside the app, which sends it.
//
// It holds names, patterns and pure functions and nothing else: no Node, no DOM,
// no Workers API, no import. The Worker bundles it and the browser bundles it, and
// the root test suite runs it. docs/reference/servicecue-publishing.md describes
// the protocol these constants define.
//
// Every list below is sorted, one entry per line, so two branches that each add an
// entry merge without a conflict and a test can pin the exact list.

/** The protocol's version: the `v1` in every publish path, and `protocol` in the status answer. */
export const PUBLISH_PROTOCOL_VERSION = 1;

/** Where every authenticated publish request lives. */
export const PUBLISH_BASE_PATH = `/_publish/v${PUBLISH_PROTOCOL_VERSION}`;

// ── Limits ────────────────────────────────────────────────────────────────────

/**
 * The most a publish request may carry. 2 MB, and deliberately a little under the
 * 2,097,152 bytes a Durable Object's SQLite storage allows one row, so a body at
 * the cap is still a body the store can hold alongside its key.
 */
export const PUBLISH_MAX_BODY_BYTES = 2_000_000;

/** The most viewers connected for live frames at once. The next is told to come back. */
export const PUBLISH_MAX_VIEWERS = 500;

/** A publishing token shorter than this is as good as none: the Worker refuses to publish on it. `openssl rand -base64 32` is 44. */
export const PUBLISH_MIN_TOKEN_LENGTH = 32;

/** The longest `version` a heartbeat may carry. */
export const PUBLISH_MAX_VERSION_LENGTH = 64;

/** How many days ahead the public page asks for plans, and so how many `plans-upcoming` publishes. */
export const PUBLISH_UPCOMING_DAYS = 60;

/**
 * How long the church may send nothing before the public page says it has stopped
 * updating: two minutes, so a publisher that beats every 30 seconds has four
 * chances to be heard.
 */
export const PUBLIC_STALE_AFTER_MS = 2 * 60 * 1000;

// ── Ids ───────────────────────────────────────────────────────────────────────

/** Is this a plain object: not null, not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ID = /^\d{1,20}$/;

/** A Planning Center id: digits only. The only shape a service type or plan id has. */
export function isPublishId(value: unknown): value is string {
  return typeof value === "string" && ID.test(value);
}

// ── Docs ──────────────────────────────────────────────────────────────────────

/**
 * Every doc whose key is fixed, with the public GET path it is served at. Sorted
 * by key. A doc is a JSON body the church sends and the Worker returns verbatim as
 * the answer to that path, so the public page asks the same questions it asks a
 * server in the building and gets the same shapes back.
 *
 * `plans-upcoming` carries its query: the page asks for PUBLISH_UPCOMING_DAYS days
 * and nothing else is published, so nothing else is answered.
 */
export const FIXED_DOCS = [
  ["pco-live", "/api/pco/live"],
  ["plans-upcoming", `/api/plans/upcoming?days=${PUBLISH_UPCOMING_DAYS}`],
  ["service-types", "/api/service-types"],
  ["servicecue-config", "/api/servicecue/config"],
  ["servicecue-layouts", "/api/servicecue/layouts"],
  ["servicecue-roles", "/api/servicecue/roles"],
  ["spl-current", "/api/spl/history/current"],
  ["state", "/api/state"],
] as const;

export type FixedDocKey = (typeof FIXED_DOCS)[number][0];

export const FIXED_DOC_KEYS: readonly FixedDocKey[] = FIXED_DOCS.map(([key]) => key);

/** The path a rundown doc is served at; the query carries which one. */
export const RUNDOWN_PATH = "/api/servicecue/rundown";

// Maps, not records: both are looked up with text a caller chose.
const FIXED_PATH_BY_KEY: ReadonlyMap<string, string> = new Map(FIXED_DOCS);
const FIXED_KEY_BY_PATH: ReadonlyMap<string, FixedDocKey> = new Map(
  FIXED_DOCS.map(([key, path]) => [path.split("?")[0]!, key]),
);
/** The one query a fixed doc answers, "" for the ones that answer none. */
const FIXED_QUERY_BY_KEY: ReadonlyMap<string, string> = new Map(
  FIXED_DOCS.map(([key, path]) => [key, path.includes("?") ? path.slice(path.indexOf("?")) : ""]),
);

const RUNDOWN_KEY = /^rundown-(\d{1,20})(?:-(\d{1,20}))?$/;

/**
 * The doc key of a service type's rundown, or of one plan of it. Null for an id
 * that is not digits, so a key is never built out of something else.
 */
export function rundownKey(serviceTypeId: string, planId?: string | null): string | null {
  if (!isPublishId(serviceTypeId)) return null;
  if (planId === undefined || planId === null) return `rundown-${serviceTypeId}`;
  return isPublishId(planId) ? `rundown-${serviceTypeId}-${planId}` : null;
}

/** Is this a key a doc can be stored under: one of the fixed ones, or a rundown's. */
export function isDocKey(key: unknown): key is string {
  return typeof key === "string" && (FIXED_PATH_BY_KEY.has(key) || RUNDOWN_KEY.test(key));
}

/**
 * The public path (and query) a doc is answered at, or null for a key that names
 * none. What the publisher needs to know which question each doc answers, and
 * what the docs table is written from.
 */
export function docPublicPath(key: string): string | null {
  const fixed = FIXED_PATH_BY_KEY.get(key);
  if (fixed !== undefined) return fixed;
  const m = RUNDOWN_KEY.exec(key);
  if (!m) return null;
  return `${RUNDOWN_PATH}?serviceTypeId=${m[1]}${m[2] ? `&planId=${m[2]}` : ""}`;
}

/**
 * The doc a public GET asks for, or null when it asks for none — which the Worker
 * answers 404.
 *
 * Strict by construction, because the Worker never goes looking for an answer: a
 * fixed path with any query but its own, a rundown query with a parameter it does
 * not know, a repeated one, or an id that is not digits is no doc at all.
 *
 * @param pathname a URL's `pathname`.
 * @param search a URL's `search`: the query with its `?`, or "".
 */
export function docKeyForRequest(pathname: string, search: string): string | null {
  const fixed = FIXED_KEY_BY_PATH.get(pathname);
  if (fixed !== undefined) return search === (FIXED_QUERY_BY_KEY.get(fixed) ?? "") ? fixed : null;
  if (pathname !== RUNDOWN_PATH) return null;

  const params = new URLSearchParams(search);
  const names = [...params.keys()];
  if (new Set(names).size !== names.length || names.some((name) => name !== "serviceTypeId" && name !== "planId")) return null;
  // rundownKey refuses an id that is not digits, and an absent service type is one.
  return rundownKey(params.get("serviceTypeId") ?? "", params.get("planId"));
}

// ── The state the public page may receive ─────────────────────────────────────

/**
 * What the public page reads of the app's state, and nothing more. Each field is
 * here because a ServiceCue page, or the shared code under it, reads it:
 *
 *   accentColor        the Branding accent, which tints the rundown's detail line and badges
 *   appLogo            the header's logo, and the tab icon
 *   appLogoMonochrome  whether that logo is recolored to the theme
 *   hourCycle          12 or 24 hour, for every clock on the page
 *   pcoConfigured      whether Planning Center is connected: the page asks for nothing until it says so
 *   timezone           the zone the header clock reads in
 *
 * The rest of the state is the operator's and stays in the building: the screens
 * and views, every network address, device telemetry, update and automation
 * settings. The Worker drops every other field of a state it is sent.
 */
export interface PublicState {
  accentColor: string | null;
  appLogo: string | null;
  appLogoMonochrome: boolean;
  hourCycle: "12h" | "24h";
  pcoConfigured: boolean;
  timezone: string | null;
}

/** Sorted. Tied to PublicState in both directions: see the two checks below. */
export const PUBLIC_STATE_FIELDS = [
  "accentColor",
  "appLogo",
  "appLogoMonochrome",
  "hourCycle",
  "pcoConfigured",
  "timezone",
] as const satisfies readonly (keyof PublicState)[];

// A field added to PublicState and not to the list would be silently never sent,
// and a field named in the list but not the interface will not compile above. Each
// is a compile error rather than a test, so the list cannot fall out of step.
const _everyFieldIsListed: Exclude<keyof PublicState, (typeof PUBLIC_STATE_FIELDS)[number]> extends never
  ? true
  : never = true;
void _everyFieldIsListed;

/**
 * `state` cut down to the public fields, or null when it is not an object.
 *
 * Walks OUR list and reads each from the input, rather than walking the input and
 * deleting what is not allowed: a field nobody thought of is then dropped by
 * default, and a key like `__proto__` is never visited.
 */
export function filterPublicState(state: unknown): Partial<PublicState> | null {
  if (typeof state !== "object" || state === null || Array.isArray(state)) return null;
  const out: Record<string, unknown> = {};
  for (const field of PUBLIC_STATE_FIELDS) {
    if (Object.hasOwn(state, field)) out[field] = (state as Record<string, unknown>)[field];
  }
  return out as Partial<PublicState>;
}

// ── Live channels ─────────────────────────────────────────────────────────────

/**
 * The channels the church may send a frame on. A frame is a change the Worker
 * keeps the latest of and hands to every open viewer, so a rundown moves on the
 * second rather than on the page's next read. Sorted.
 */
export const FRAME_CHANNELS = ["pco:live", "spl:history", "stage:state-changed"] as const;

export type FrameChannel = (typeof FRAME_CHANNELS)[number];

/** The channel the Worker itself broadcasts on when a heartbeat arrives. Never sent TO it. */
export const HEARTBEAT_CHANNEL = "publish:heartbeat";

/** The channel the Worker broadcasts on when a doc's content changes. Never sent TO it. */
export const DOCS_CHANNEL = "publish:docs";

/** Every channel a viewer can receive: the frame channels and the Worker's own two. Sorted. */
export const LIVE_CHANNELS = ["pco:live", "publish:docs", "publish:heartbeat", "spl:history", "stage:state-changed"] as const;

export function isFrameChannel(channel: unknown): channel is FrameChannel {
  return typeof channel === "string" && (FRAME_CHANNELS as readonly string[]).includes(channel);
}

/**
 * The doc each frame channel is stored as: a frame IS a write of its doc, and a viewer
 * that joins is replayed the docs, in this order, as frames. So a snapshot read after a
 * frame can never be older than it. Sorted by channel.
 */
export const FRAME_DOCS: ReadonlyMap<FrameChannel, FixedDocKey> = new Map<FrameChannel, FixedDocKey>([
  ["pco:live", "pco-live"],
  ["spl:history", "spl-current"],
  ["stage:state-changed", "state"],
]);

/**
 * The heartbeat as a viewer gets it, on `publish:heartbeat`. `at` is the EDGE's clock
 * when the heartbeat arrived, never the publisher's, so a church server whose own clock
 * is wrong cannot decide whether the page is stale; null in the one replayed on connect
 * when none has ever arrived. `now` is the edge's clock when the replay was sent, so a
 * page can age `at` without a clock of its own; it is on the replay only, because a live
 * heartbeat is `at` itself. `build` is the id of the page this deployment serves (see
 * VIEWER_BUILD_META), absent when that page carries none.
 */
export interface HeartbeatFrameData {
  at: number | null;
  now?: number;
  build?: string;
}

/**
 * What a viewer is told on `publish:docs`: the doc keys whose content changed (or went).
 * `all` says to treat every doc as changed: sent when too many to list changed at once,
 * and by the page's own transport after a reconnect, when it may have missed some.
 */
export interface DocsFrameData {
  keys: string[];
  all?: true;
}

/** The answer of `GET /api/publish/heartbeat`. `now` is the edge's clock, for the page to set its own by. */
export interface HeartbeatAnswer {
  at: number | null;
  now: number;
}

/** The latest heartbeat the Worker holds. `at` is the edge's clock when it arrived, `sentAt` the publisher's own. */
export interface LastHeartbeat {
  at: number;
  sentAt: number;
  version: string;
}

/** The answer of `GET /_publish/v1/status`. */
export interface PublishStatus {
  protocol: typeof PUBLISH_PROTOCOL_VERSION;
  /** Every stored doc key, sorted. */
  docs: string[];
  /** Every stored asset name, sorted. */
  assets: string[];
  /** The latest heartbeat, or null before the first. */
  lastHeartbeat: LastHeartbeat | null;
  /** Viewers connected to the live socket right now. */
  viewers: number;
  /**
   * The build id of the page this Worker serves (the id in its document, as `viewerBuildTag`
   * stamps it), or null when the document is missing or carries none. A Worker from before
   * this field answers without it, and the publisher reads that as null as well.
   */
  build: string | null;
}

/** What the Durable Object knows of the status: the Worker adds `build`, which it reads from the page it serves. */
export type HubStatus = Omit<PublishStatus, "build">;

// ── Assets ────────────────────────────────────────────────────────────────────

const ASSET_NAME = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * Is this a name an asset can be stored under. The Worker keeps assets by name and
 * never reads a file system, so a dot-only name cannot escape anywhere; it is
 * refused because a URL ending in `..` is not one a browser will ever send.
 */
export function isAssetName(name: unknown): name is string {
  return typeof name === "string" && ASSET_NAME.test(name) && !/^\.+$/.test(name);
}

/** Where an asset is served: the same path the app serves its own branding images at. */
export const ASSET_PATH_PREFIX = "/branding-images/";

/** The image types an asset may be. Sorted. */
export const ASSET_CONTENT_TYPES = ["image/gif", "image/jpeg", "image/png", "image/svg+xml", "image/webp"] as const;

export type AssetContentType = (typeof ASSET_CONTENT_TYPES)[number];

/** The asset type a `Content-Type` header names, parameters ignored, or null when it is not one. */
export function assetContentType(header: string | null): AssetContentType | null {
  const type = (header ?? "").split(";")[0]!.trim().toLowerCase();
  return (ASSET_CONTENT_TYPES as readonly string[]).includes(type) ? (type as AssetContentType) : null;
}

// ── Where the public side answers ─────────────────────────────────────────────

/** The viewer's socket. */
export const LIVE_PATH = "/api/live";

/** Where a viewer reads the last heartbeat and the edge's clock. */
export const HEARTBEAT_PATH = "/api/publish/heartbeat";

/** The viewer's document, served at `/servicecue` and under it. Never at its own name. */
export const VIEWER_HTML = "/servicecue.html";

/** The files the viewer build writes beside its document, each served at its own path. Sorted. */
export const PUBLIC_STATIC_FILES = [
  "/apple-touch-icon.png",
  "/favicon.svg",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable-512.png",
  "/manifest.webmanifest",
] as const;

/** The folder the viewer build writes its hashed scripts, styles and fonts to. */
export const STATIC_ASSET_PREFIX = "/assets/";

// ── The page's build ──────────────────────────────────────────────────────────
//
// A volunteer may keep the page open for hours across a deploy, and the page that is
// open is the old build. The build stamps its document with an id, the Worker reads
// that id back out of the document it serves and sends it on the heartbeat, and a page
// whose own id is different reloads itself once. The writer (the build), the reader
// (the Worker) and the page all go through the two functions below, so none of them
// can mean a different tag.

/** The name of the `<meta>` in servicecue.html that carries the build id. */
export const VIEWER_BUILD_META = "servicecue-build";

const BUILD_ID = /^[0-9a-f]{12}$/;

/** Is this a build id: 12 lower-case hex digits, which is what a build writes and nothing a visitor can make up that means anything. */
export function isViewerBuildId(value: unknown): value is string {
  return typeof value === "string" && BUILD_ID.test(value);
}

/** The tag a build writes into the document. */
export function viewerBuildTag(id: string): string {
  if (!isViewerBuildId(id)) throw new Error(`${JSON.stringify(id)} is not a build id`);
  return `<meta name="${VIEWER_BUILD_META}" content="${id}" />`;
}

/**
 * The build id a viewer document carries, or null when it carries none. Comments are
 * set aside first: the document has a long one at its head, and a tag named in a
 * comment is not the document's.
 */
export function viewerBuildFromHtml(html: string): string | null {
  // Until nothing changes: one pass can leave a comment that removing another formed.
  let bare = html;
  for (let before = ""; before !== bare; ) {
    before = bare;
    bare = bare.replace(/<!--[\s\S]*?-->/g, "");
  }
  const m = new RegExp(`<meta\\s+name="${VIEWER_BUILD_META}"\\s+content="([^"]*)"\\s*/?>`).exec(bare);
  return m !== null && isViewerBuildId(m[1]) ? m[1] : null;
}
