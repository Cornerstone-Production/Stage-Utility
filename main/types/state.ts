// state.ts — StageState and the settings that shape it.
//
// The single object every display and panel renders from, and the operator
// settings that feed it.
//
// Split out of stage.ts, which had grown to 1,509 lines. Every name is still
// re-exported from stage.ts, so no import anywhere had to change.

import type { BaptismAutoStart } from "./baptism.js";

export interface StageState {
  serviceTypeId: string | null;
  serviceTypeName: string | null;
  planMode: "auto" | "manual";
  planId: string | null;
  planTitle: string | null;
  planSeriesTitle: string | null;
  /** The plan's own date label from Planning Center ("August 3, 2026"), so the
   *  active plan can be told apart from next week's. */
  planDates: string | null;

  // ── Views/Outputs model (canonical) ──────────────────────────────────
  /** All content definitions. */
  views: View[];
  /** All physical screens and their routing. */
  outputs: Output[];
  /** Resolved slots keyed by View id (for slots-kind Views). Drives both the
   *  kiosk (via the output's routed view) and the settings editor/preview. */
  slotsByView: Record<string, Slot[]>;
  /** Resolved slots for inline mic-slots objects, keyed by the layout object's id
   *  (a custom-layout `slots-grid` with `source: "inline"`). */
  slotsByLayoutObject: Record<string, Slot[]>;
  /** Per-output render descriptor (output id → routed view's kind/ndi/name). */
  resolvedByOutput: Record<string, ResolvedOutput>;

  // ── Compat shim (computed from outputs + views) ──────────────────────

  pcoConfigured: boolean;
  lastRefreshedAt: string | null;
  remoteUrl: string | null;
  /** Raw LAN IP URL (http://<ip>:<port>) for the Companion panel; Companion can't
   *  resolve DNS, so this is shown regardless of publicUrl. */
  lanUrl: string | null;
  showQr: boolean;
  /** Allowlisted service type IDs for auto mode. Empty array = all allowed. */
  allowedServiceTypeIds: string[];
  /** Customizable brand name shown in the sidebar header and on the kiosk. */
  appName: string;
  /** Themeable brand accent (#rrggbb), or null to use the built-in default. */
  accentColor: string | null;
  /** Customizable brand logo as a data URL (PNG/JPG/SVG/WebP), or null. */
  appLogo: string | null;
  /** Recolor a single-color logo to match the theme. */
  appLogoMonochrome: boolean;
  /** Image centered in empty slots on the kiosk (recolored to the kiosk gray). */
  emptySlotLogo: string | null;
  /** Avatar shown for matched people with no PCO photo (recolored like a silhouette);
   *  null = use the built-in person icon. */
  defaultAvatar: string | null;
  /** Show NDI-related controls in settings (off by default; native client only). */
  ndiEnabled: boolean;
  /** Public base URL (DNS) for the connect QR + display links; null = LAN IP. */
  publicUrl: string | null;
  /** Icon tint per display id or tool path (e.g. "display-1", "/baptism"), as
   *  "#rrggbb". One map covers the Displays cards, the Connect tool cards and the
   *  picker tiles, so a color set anywhere shows everywhere that item appears. */
  iconColors?: Record<string, string>;
  /** User-assigned caption colors, keyed by ProdCom channel label. */
  captionChannelColors: Record<string, string>;
  /** Live battery bays from any Shure SBC charger connections. */
  chargerBays: ChargerBayDTO[];
  /** Automatic-update schedule (in-app self-update). */
  autoUpdate: AutoUpdateSettings;
  reconnectSchedule: ReconnectSchedule;
  /** Attendance ramp/taper capture windows (Advanced tab). */
  taperWindow: TaperWindow;
  /** IANA zone the server makes wall-clock decisions in, or null to follow its
   *  own clock. See `hostTimezone` for what that clock currently reads. */
  timezone: string | null;
  /** The zone the SERVER's clock is set to — shown so an operator can see when it
   *  is UTC (the default on most servers) and override it. */
  hostTimezone: string;
  /** Keyword auto-start for the baptism timer (see BaptismAutoStart). */
  baptismAutoStart?: BaptismAutoStart;
  /** Operator dismissed the first-run "Getting started" checklist (machine-wide). */
  onboardingDismissed: boolean;
}

/** One battery bay of a Shure SBC charger (derived from charger-kind devices). */
export interface ChargerBayDTO {
  /** Stable id = the namespaced device channelId (connectionId::bay). */
  id: string;
  /** Charger connection id (the part before "::"). */
  connectionId: string;
  /** 1-based bay number within its charger. */
  bay: number;
  /** 1-based index of this charger among charger connections (for default labels). */
  chargerIndex: number;
  /** The charger connection's user-set name (e.g. "SBC-220-03"), for unambiguous
   *  bay labels that map to the physical unit. Null if not resolvable. */
  connectionName: string | null;
  /** Device-reported battery/bay name, if any. */
  name: string | null;
  /** A battery is docked in the bay. */
  online: boolean;
  battery: number | null;
  charging: boolean | null;
  cycles: number | null;
  health: number | null;
  tempC: number | null;
}

/** Scheduled auto-update config. When enabled, the server applies an available
 *  update during the weekly window (skipping while a PCO service is live). */
/**
 * How updates are applied.
 *   manual       — operator checks, applies and restarts by hand
 *   auto-install — apply automatically in the window, but WAIT for an operator
 *                  to restart (the new build sits ready; nothing interrupts)
 *   auto-full    — apply and restart in the window (the original behavior)
 */
export type UpdateMode = "manual" | "auto-install" | "auto-full";

export interface AutoUpdateSettings {
  mode: UpdateMode;
  /** @deprecated Pre-mode boolean, read once to migrate. true -> auto-full. */
  enabled?: boolean;
  /** Day of week 0–6 (Sun–Sat), or null for any day. */
  dayOfWeek: number | null;
  /** Hour of day 0–23 (local time) the update window opens. */
  hour: number;
}

/** Minutes to keep sampling attendance/occupancy around a service so the graphs
 *  show the room filling before and emptying after (Advanced tab). 0 = off. */
export interface TaperWindow {
  /** Sample the arrival ramp this many minutes before the service start. */
  preMin: number;
  /** Keep sampling the emptying room this many minutes after the service ends. */
  postMin: number;
}

/** Tunables for time-aware integration reconnects (Advanced tab). */
export interface ReconnectSchedule {
  /** When on, reconnect cadence follows PCO rehearsal/service times. */
  enabled: boolean;
  /** Ramp up this many minutes before a rehearsal/service start. */
  leadMin: number;
  /** Stay active this many minutes after a service ends. */
  tailMin: number;
  /** Max minutes between retries when far from any service. */
  dormantMin: number;
}

/** In-app update status (git-based), surfaced in the Advanced tab. */
export interface UpdateStatus {
  /** False when this isn't a git checkout (or git is unavailable) — update via CLI. */
  isGitRepo: boolean;
  /**
   * Whether in-app updates work here at all.
   *
   * NOT the same as `isGitRepo`. A Homebrew or tarball install is not a
   * checkout and updates perfectly well through its own strategy; gating the UI
   * on `isGitRepo` told those installs to update from the command line while a
   * working updater sat behind the message. When false, `updateBlockedReason`
   * says why.
   */
  canUpdate?: boolean;
  /** Why in-app updates are unavailable, when `canUpdate` is false. */
  updateBlockedReason?: string | null;
  branch: string | null;
  /**
   * Where `branch` came from. A packaged install has no branch to read, so the
   * track is derived — from the Homebrew formula, or inferred from whether the
   * version is a prerelease. Surfaced so the UI need not present a derived
   * answer as though it were read from a checkout, and so a wrong one is
   * visible rather than silent.
   */
  trackSource?: "git" | "formula" | "recorded" | "version" | "unknown";
  /** Selectable update tracks (git branches) the operator can switch between. */
  tracks: string[];
  /** App version from package.json. */
  version: string;
  /** Short SHA + ISO commit date of the running checkout. */
  currentSha: string | null;
  currentDate: string | null;
  /** Commits between here and the release we should be running. */
  behind: number;
  /** The release tag this checkout is on, or null when it predates every tag. */
  currentTag?: string | null;
  /** The newest release tag on this track — what an update would move to. */
  targetTag?: string | null;
  /** How many releases newer than `currentTag` exist on this track. */
  releasesBehind?: number;
  /** Commits on the branch past `targetTag`: merged but not yet released,
   *  because CI is still running or has failed. Surfaced so a track stalled on a
   *  red build reads as "waiting to be released" rather than "updates broken". */
  unreleasedCommits?: number;
  /** False when the track has no tags and the updater is following the tip. */
  tagBased?: boolean;
  /**
   * A release that exists but cannot be installed here YET — the archives are
   * still uploading, or the Homebrew tap has not been regenerated.
   *
   * The packaged counterpart of `unreleasedCommits`. Without it that window
   * reads as "up to date", which is indistinguishable from a release build that
   * failed and is never coming.
   */
  awaitingPackage?: string | null;
  /** How many of those an operator would notice — see summarizeChangelog. The
   *  release workflow's own version bump trails every merge, so this is 0 far more
   *  often than `behind` is, and it is what the "update available" banner reads. */
  behindUserFacing?: number;
  latestSha: string | null;
  latestDate: string | null;
  /** Commit subjects between current and latest (newest first), capped. */
  changelog: string[];
  lastCheckedAt: string | null;
  /** "idle" normally; "checking" during a fetch; "updating" while the script runs. */
  phase: "idle" | "checking" | "updating";
  /** Sub-phase while `phase==="updating"`, for the progress bar. Null otherwise. */
  step: "pull" | "install" | "build" | "restarting" | null;
  /** A build has been installed but the process is still running the old code —
   *  set by an auto-install update that deferred its restart. */
  restartPending: boolean;
  /** Outcome of the most recent apply (read from the updater's result file). */
  lastResult: { ok: boolean; finishedAt: string; log: string | null } | null;
  /** Non-null when the last check failed (e.g. no network). */
  error: string | null;
}
