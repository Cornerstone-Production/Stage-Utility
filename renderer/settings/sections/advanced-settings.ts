// advanced-settings.ts — every setting on Settings > Advanced, in one list.
//
// The registry is the single place a row's name and description are written. The
// row JSX reads its title and description from `settingText`, and the Search tab
// matches against these same entries, so what is searched and what is drawn
// cannot drift. Each rendered row carries `data-setting-id`, and
// advanced-section-ids.test.tsx renders every tab and asserts the ids drawn are
// exactly the ids listed here.
//
// Order is the order rows appear on their card, and cards appear in the order
// their first row does.

export const ADVANCED_TABS = [
  { id: "general", name: "General" },
  { id: "updates", name: "Updates" },
  { id: "schedule", name: "Schedule" },
  { id: "network", name: "Network" },
  { id: "data", name: "Data" },
  { id: "video", name: "Video relay" },
] as const;

export type AdvancedTabId = (typeof ADVANCED_TABS)[number]["id"];

/** The Search tab sits beside the content tabs but holds no settings of its own. */
export const SEARCH_TAB_ID = "search";
export type AdvancedPageTab = AdvancedTabId | typeof SEARCH_TAB_ID;

export const DEFAULT_ADVANCED_TAB: AdvancedTabId = "general";

/** Where a tab lives. */
export function advancedTabPath(tab: AdvancedPageTab): string {
  return `/settings/advanced/${tab}`;
}

/** The tab a URL segment names, or null for anything that is not one. */
export function parseAdvancedTab(segment: string | undefined): AdvancedPageTab | null {
  if (segment === SEARCH_TAB_ID) return SEARCH_TAB_ID;
  return ADVANCED_TABS.find((t) => t.id === segment)?.id ?? null;
}

export interface AdvancedSetting {
  id: string;
  tab: AdvancedTabId;
  /** The card the row sits in. Equal to the tab's name when the tab has one card. */
  card: string;
  name: string;
  description: string;
  /** Words people type that the name and description do not contain. */
  keywords: readonly string[];
}

export const ADVANCED_SETTINGS = [
  {
    id: "timezone",
    tab: "general",
    card: "General",
    name: "Time zone",
    description:
      "The zone the server reads the clock in. It decides which day a service is filed under, the update window and the day-of-week and time-of-day automation conditions. Set this if the server's own zone is not your local zone; servers commonly run UTC.",
    keywords: ["timezone", "tz", "utc", "clock", "chicago", "local time", "date"],
  },
  {
    id: "clock-format",
    tab: "general",
    card: "General",
    name: "Clock format",
    description:
      "How every clock in the app reads: the context bar, service times, the rundown and stage displays. A clock object in a custom layout that has been set to one or the other keeps its own choice.",
    keywords: ["12 hour", "24 hour", "12h", "24h", "am", "pm", "military", "time"],
  },
  {
    id: "context-bar",
    tab: "general",
    card: "General",
    name: "Context bar",
    description:
      "Which readings appear above every page, and where they sit. Right-clicking the bar itself opens the same thing.",
    keywords: ["header", "strip", "readings", "items", "configure", "top bar"],
  },

  {
    id: "update-status",
    tab: "updates",
    card: "Updates",
    name: "Software updates",
    description:
      "The version this server runs, whether a newer release is waiting, and the buttons to check, update and restart. Nothing is applied while a Planning Center service is live without an override.",
    keywords: ["version", "upgrade", "release", "check now", "update now", "restart", "reboot", "changelog", "whats new"],
  },
  {
    id: "update-track",
    tab: "updates",
    card: "Updates",
    name: "Update track",
    description:
      "Which branch this server follows. main is the stable production track; beta gets new features first for testing. Switching reinstalls, rebuilds, and restarts the server.",
    keywords: ["branch", "channel", "beta", "main", "stable", "switch"],
  },
  {
    id: "update-mode",
    tab: "updates",
    card: "Updates",
    name: "Updates",
    description:
      "How updates are applied. Nothing is applied or restarted while a Planning Center service is live, whichever mode you pick.",
    keywords: ["automatic", "auto", "manual", "install", "auto-install", "restart", "schedule"],
  },
  {
    id: "update-window",
    tab: "updates",
    card: "Updates",
    name: "Update window",
    description: "When to apply updates each week. Pick an off-hours time.",
    keywords: ["day", "hour", "time", "weekly", "overnight", "automatic"],
  },
  {
    id: "update-machines",
    tab: "updates",
    card: "Updates",
    name: "Update Mac output helpers and Windows kiosks with this server",
    description:
      "When this server updates, each Mac running the output helper installs the same version on its own. Never during a service, or within the window around one. The helper restarts to finish, which takes its outputs off air for about three seconds. A Windows kiosk takes the new launcher at its next sign-in.",
    keywords: ["helper", "mac", "windows", "kiosk", "sdi", "machines", "auto update", "automatic", "version"],
  },

  {
    id: "reconnect-wake",
    tab: "schedule",
    card: "Reconnects",
    name: "Wake around service times",
    description:
      "Back off reconnects when gear is off for the week, and ramp up before a rehearsal or service. Off = a fixed 2-minute retry. Rehearsal and service windows come from Planning Center.",
    keywords: [
      "reconnect", "retry", "backoff", "schedule", "idle", "lead time", "keep active", "dormant", "sleep",
      "planning center", "pco", "minutes",
    ],
  },
  {
    id: "reconnect-lead",
    tab: "schedule",
    card: "Reconnects",
    name: "Lead time before rehearsal (minutes)",
    description: "Start reconnecting this long before a scheduled rehearsal or service.",
    keywords: ["reconnect", "retry", "wake", "before", "early", "minutes"],
  },
  {
    id: "reconnect-tail",
    tab: "schedule",
    card: "Reconnects",
    name: "Keep active after service ends (minutes)",
    description: "Stay in fast-reconnect mode this long after the service end time.",
    keywords: ["reconnect", "retry", "wake", "tail", "after", "minutes"],
  },
  {
    id: "reconnect-idle",
    tab: "schedule",
    card: "Reconnects",
    name: "Idle retry interval (minutes)",
    description:
      "Longest gap between reconnect attempts when far from any service (the dead-week cadence).",
    keywords: ["reconnect", "retry", "wake", "dormant", "slow", "minutes"],
  },
  {
    id: "taper-pre",
    tab: "schedule",
    card: "Attendance sampling",
    name: "Pre-service ramp (minutes)",
    description:
      "Start sampling attendance this long before the service start, so the graph shows the room filling up. 0 = off.",
    keywords: ["taper", "attendance", "window", "history", "before", "people", "count", "minutes"],
  },
  {
    id: "taper-post",
    tab: "schedule",
    card: "Attendance sampling",
    name: "Post-service taper (minutes)",
    description:
      "Keep sampling this long after the service ends, to capture how fast the room empties. 0 = off. These samples are excluded from the Peak and Lowest figures.",
    keywords: ["taper", "attendance", "window", "history", "after", "people", "count", "minutes", "peak", "lowest"],
  },

  {
    id: "public-address",
    tab: "network",
    card: "Addresses",
    name: "Public address (DNS)",
    description:
      "The address people use to reach this server, e.g. a DNS name behind a reverse proxy. When set, the connect QR code and the display links use it instead of the local IP. Leave blank to use the auto-detected network address.",
    keywords: ["dns", "url", "domain", "hostname", "address", "proxy", "qr", "link", "ip", "public", "external"],
  },
  {
    id: "kiosk-discovery",
    tab: "network",
    card: "Addresses",
    name: "Answer devices looking for a server",
    description:
      "Off by default so a test instance on the same network cannot claim a screen meant for this one. Screens already claimed keep working either way; this only controls whether new ones can find you. Takes effect when the server restarts.",
    keywords: ["kiosk", "discovery", "mdns", "bonjour", "broadcast", "screen", "claim", "find", "pi", "raspberry"],
  },
  {
    id: "kiosk-setup",
    tab: "network",
    card: "Addresses",
    name: "Setting up a screen",
    description:
      "On the machine that will show the display, run this once. It finds this server on its own: there is no address to type, and nothing to change if the server moves.",
    keywords: ["install", "kiosk", "command", "curl", "linux", "macos", "windows", "raspberry", "pi", "script", "display"],
  },
  {
    id: "host-names-enforce",
    tab: "network",
    card: "Host names",
    name: "Refuse names not on the list",
    description:
      "Off: other names are answered and listed below, and this server's IP address always works. On: a request by any other name gets a 403. Turning it on asks you which of the names in use to keep.",
    keywords: ["host", "hostname", "dns rebinding", "security", "403", "refuse", "block", "enforce", "allowlist"],
  },
  {
    id: "host-names-list",
    tab: "network",
    card: "Host names",
    name: "Names this server answers to",
    description:
      "Any IP address, localhost, a name with no dot and names ending .local, .internal or .home.arpa are always answered and need no entry. Add the others here; names waiting to be accepted or dismissed show here too.",
    keywords: ["host", "hostname", "dns", "accept", "dismiss", "waiting", "allowlist", "domain", "add", "remove"],
  },

  {
    id: "auto-backups",
    tab: "data",
    card: "Backups",
    name: "Automatic backups",
    description:
      "Save a copy on a schedule, so a backup exists without anyone remembering to make one. Writes a config snapshot, and optionally the data archive, every few days and keeps the most recent few.",
    keywords: [
      "backup", "schedule", "interval", "days", "keep", "destination", "network share", "nas", "folder",
      "directory", "include recorded services", "back up now",
    ],
  },
  {
    id: "config-snapshot",
    tab: "data",
    card: "Backups",
    name: "Config snapshot",
    description:
      "Save, download, or restore your full configuration: views, custom layouts, integration hosts, ports and names, branding, and display options. Secrets are not included, so the file is safe to store. Upload and restore overwrites the current config and restarts the server. Saved snapshots are named copies kept on this server.",
    keywords: [
      "backup", "restore", "export", "import", "download", "upload", "recall", "saved snapshots", "named",
      "settings", "json", "save current",
    ],
  },
  {
    id: "data-archive",
    tab: "data",
    card: "Records",
    name: "Data archive",
    description:
      "Everything the app has recorded: service history, SPL readings, attendance and baptism timings, plus the raw samples behind them. Use it to move your history onto a rebuilt machine. This is not the config snapshot: that covers how the app is set up, this covers what it recorded.",
    keywords: ["backup", "export", "import", "download", "zip", "history", "recordings", "merge", "replace", "move", "migrate"],
  },
  {
    id: "history-milestones",
    tab: "data",
    card: "Records",
    name: "History milestones",
    description:
      "Dates marked under the Trends chart on History, All services, so a step in attendance has a reason beside it. The chart also marks where a plan's series title changes on its own.",
    keywords: ["trends", "chart", "attendance", "date", "label", "event", "annotation", "service time change"],
  },

  {
    id: "video-relay-ports",
    tab: "video",
    card: "Video relay",
    name: "Relay ports",
    description:
      "The ports the built-in video relay listens on: RTMP, SRT and video to screens on the network, and signalling, HLS, the relay API and RTSP on this machine only. Saving restarts the relay if it is running.",
    keywords: ["port", "ports", "rtsp", "rtmp", "srt", "webrtc", "ice", "udp", "hls", "api", "network", "firewall", "video feeds"],
  },
  {
    id: "video-relay-ffmpeg",
    tab: "video",
    card: "Video relay",
    name: "ffmpeg",
    description:
      "The video relay's audio conversion needs the system's ffmpeg. It is found automatically; set a path only if it is installed somewhere unusual.",
    keywords: ["path", "audio", "aac", "opus", "listen", "convert", "binary", "install", "video feeds"],
  },
] as const satisfies readonly AdvancedSetting[];

export type AdvancedSettingId = (typeof ADVANCED_SETTINGS)[number]["id"];

type CardKeyOf<S> = S extends { tab: infer T extends string; card: infer C extends string } ? `${T}/${C}` : never;
/** `<tab id>/<card name>`: names one card, and keys the card bodies so a card without one fails to compile. */
export type AdvancedCardKey = CardKeyOf<(typeof ADVANCED_SETTINGS)[number]>;

export function cardKey(s: { tab: AdvancedTabId; card: string }): AdvancedCardKey {
  return `${s.tab}/${s.card}` as AdvancedCardKey;
}

export interface AdvancedCard {
  key: AdvancedCardKey;
  tab: AdvancedTabId;
  name: string;
}

/** Every card, in page order. */
export const ADVANCED_CARDS: readonly AdvancedCard[] = (() => {
  const seen = new Map<AdvancedCardKey, AdvancedCard>();
  for (const s of ADVANCED_SETTINGS) {
    const key = cardKey(s);
    if (!seen.has(key)) seen.set(key, { key, tab: s.tab, name: s.card });
  }
  return [...seen.values()];
})();

/**
 * The cards holding `hits`, best hit first. Equal ranks keep tab order, then the
 * order cards have in the registry. Rows inside a card are not reordered: they
 * keep the card's own order.
 */
export function cardsByBestHit(hits: readonly { setting: { tab: AdvancedTabId; card: string }; rank: number }[]): AdvancedCard[] {
  const best = new Map<AdvancedCardKey, number>();
  for (const h of hits) {
    const key = cardKey(h.setting);
    best.set(key, Math.min(best.get(key) ?? Infinity, h.rank));
  }
  const tabAt = (tab: AdvancedTabId) => ADVANCED_TABS.findIndex((t) => t.id === tab);
  return ADVANCED_CARDS.filter((c) => best.has(c.key)).sort(
    (a, b) =>
      best.get(a.key)! - best.get(b.key)! ||
      tabAt(a.tab) - tabAt(b.tab) ||
      ADVANCED_CARDS.indexOf(a) - ADVANCED_CARDS.indexOf(b),
  );
}

export function tabName(tab: AdvancedTabId): string {
  return ADVANCED_TABS.find((t) => t.id === tab)?.name ?? tab;
}

const BY_ID: ReadonlyMap<string, AdvancedSetting> = new Map(ADVANCED_SETTINGS.map((s) => [s.id, s]));

/** The words a row draws as its title and its description. */
export function settingText(id: AdvancedSettingId): { name: string; description: string } {
  const s = BY_ID.get(id);
  if (!s) throw new Error(`advanced-settings: no setting "${id}"`);
  return { name: s.name, description: s.description };
}
