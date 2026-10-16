// world.mjs — the invented world every screenshot is made from.
//
// Nobody in here exists. Names, service types, songs and addresses are made up,
// and every address is in 192.168.1.x (the placeholder range
// scripts/check-public-hygiene.mjs allows). The fake Planning Center answers from
// this, and the seed step writes history records that line up with it, so a
// service page in History names the same plans the rest of the app shows.
//
// Everything that depends on the date is derived from one anchor, the run's
// `now`, so a run in March and a run in October make the same picture.

export const ORG_TIME_ZONE = "America/Chicago";

/** The three service types. Ids are PCO-shaped (digits only). */
export const SERVICE_TYPES = [
  { id: "1001001", name: "Weekend", key: "weekend" },
  { id: "1001002", name: "The Gathering", key: "gathering" },
  { id: "1001003", name: "Youth Night", key: "youth" },
];

export const PEOPLE = [
  { id: "4001", name: "Alex Rivera" },
  { id: "4002", name: "Jordan Lee" },
  { id: "4003", name: "Sam Okafor" },
  { id: "4004", name: "Taylor Brooks" },
  { id: "4005", name: "Morgan Chen" },
  { id: "4006", name: "Riley Patel" },
  { id: "4007", name: "Casey Nguyen" },
  { id: "4008", name: "Drew Alvarez" },
  { id: "4009", name: "Jamie Park" },
  { id: "4010", name: "Quinn Murphy" },
  { id: "4011", name: "Avery Kim" },
  { id: "4012", name: "Skyler Adams" },
];

export const TEAMS = [
  { id: "5001", name: "Vocals", positions: ["Worship Leader", "Vocals", "Vocals (BGVs)"] },
  { id: "5002", name: "Band", positions: ["Electric Guitar", "Acoustic Guitar", "Bass", "Drums", "Keys"] },
  { id: "5003", name: "Audio", positions: ["A1", "A2", "Monitors"] },
  { id: "5004", name: "Video", positions: ["Video Director", "Camera 1", "Camera 2", "ProPresenter"] },
  { id: "5005", name: "Hosts", positions: ["Host"] },
];

/** Who is on a Weekend plan: [person, team, position, note]. */
export const WEEKEND_ROSTER = [
  ["Alex Rivera", "Vocals", "Worship Leader", "1"],
  ["Casey Nguyen", "Vocals", "Vocals", "2"],
  ["Drew Alvarez", "Vocals", "Vocals (BGVs)", "3"],
  ["Jordan Lee", "Band", "Electric Guitar", ""],
  ["Riley Patel", "Band", "Acoustic Guitar", ""],
  ["Taylor Brooks", "Band", "Bass", ""],
  ["Sam Okafor", "Band", "Drums", ""],
  ["Morgan Chen", "Band", "Keys", ""],
  ["Jamie Park", "Audio", "A1", ""],
  ["Quinn Murphy", "Video", "ProPresenter", ""],
  ["Avery Kim", "Video", "Camera 1", ""],
  ["Skyler Adams", "Hosts", "Host", "Lav"],
];

export const ROSTERS = {
  weekend: WEEKEND_ROSTER,
  gathering: WEEKEND_ROSTER.filter((r) => !["Drew Alvarez", "Avery Kim", "Morgan Chen"].includes(r[0])),
  youth: WEEKEND_ROSTER.filter((r) =>
    ["Alex Rivera", "Jordan Lee", "Sam Okafor", "Taylor Brooks", "Jamie Park", "Skyler Adams"].includes(r[0]),
  ),
};

export const ITEM_NOTE_CATEGORIES = ["Audio", "Band", "Video", "Lights"];

/** The Weekend rundown. `t` is item_type; notes are per category. */
export const RUNDOWN = [
  { t: "header", title: "PRE-SERVICE", len: 0 },
  { t: "item", title: "Walk-in Playlist", len: 600, notes: { Audio: "Fade out at the countdown", Video: "Loop the bumper" } },
  { t: "media", title: "Countdown Video", len: 300, notes: { Video: "Roll at 8:55", Lights: "House to half" } },
  { t: "header", title: "SERVICE START", len: 0 },
  { t: "song", title: "Open Up the Sky", len: 300, key: "G", bpm: 78, meter: "4/4", arr: "Radio Version", notes: { Audio: "Reverb on lead vocal", Band: "Build from the bridge", Lights: "Blue wash" } },
  { t: "song", title: "Hold Fast", len: 270, key: "D", bpm: 72, meter: "6/8", arr: "Default", notes: { Band: "Acoustic only on verse 1", Lights: "Warm amber" } },
  { t: "item", title: "Welcome and Announcements", len: 240, notes: { Audio: "Host lav on, band down", Video: "Announcement slides" } },
  { t: "song", title: "Better Together", len: 285, key: "A", bpm: 96, meter: "4/4", arr: "Live", notes: { Band: "Keys pad through the tag", Lights: "Full wash" } },
  { t: "header", title: "MESSAGE", len: 0 },
  { t: "item", title: "Message: Rooted, Part 3", len: 1800, notes: { Audio: "Pastor on headset", Video: "Lower third at start" } },
  { t: "song", title: "Still the Same", len: 255, key: "E", bpm: 68, meter: "4/4", arr: "Default", notes: { Band: "Piano and acoustic", Lights: "Slow fade to blue" } },
  { t: "item", title: "Benediction", len: 90, notes: { Audio: "Host lav on" } },
  { t: "header", title: "SERVICE END", len: 0 },
  { t: "item", title: "Stream Buffer", len: 120 },
];

/** Index in RUNDOWN of the item that is live in live mode ("Hold Fast"). */
export const LIVE_ITEM_INDEX = 5;

const DAY = 86_400_000;

/**
 * Local date parts in the org time zone for an instant. Intl rather than the
 * host clock: the same reason the app does it (a UTC box rolls its date at 19:00
 * in Chicago).
 */
export function zonedParts(date, timeZone = ORG_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value ?? "";
  return {
    year: +get("year"),
    month: +get("month"),
    day: +get("day"),
    hour: +get("hour"),
    minute: +get("minute"),
    weekday: get("weekday"),
  };
}

/** The instant at which the org's wall clock reads y-m-d h:min. */
export function zonedInstant(y, m, d, h, min, timeZone = ORG_TIME_ZONE) {
  const want = Date.UTC(y, m - 1, d, h, min);
  let guess = want;
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(new Date(guess), timeZone);
    guess += want - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  }
  return new Date(guess);
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** The next date (org zone) on or after `now` that falls on `weekday`. */
function nextWeekday(now, weekday) {
  const here = zonedParts(now);
  const ahead = (WEEKDAYS.indexOf(weekday) - WEEKDAYS.indexOf(here.weekday) + 7) % 7;
  const t = new Date(Date.UTC(here.year, here.month - 1, here.day) + ahead * DAY);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/** Service-time pattern per service type. */
const SCHEDULE = {
  weekend: { weekday: "Sun", times: [[9, 0], [11, 0]] },
  gathering: { weekday: "Wed", times: [[19, 0]] },
  youth: { weekday: "Fri", times: [[19, 0]] },
};

const SERIES = ["Rooted", "Open Hands", "Common Ground", "Steady"];

/**
 * The plan `week` weeks from the next occurrence (0 = the upcoming one, -1 = the
 * one before it, 1 = the one after). Ids are stable and PCO-shaped (digits only).
 */
export function planFor(typeKey, week, now) {
  const type = SERVICE_TYPES.find((t) => t.key === typeKey);
  const sched = SCHEDULE[typeKey];
  const base = nextWeekday(now, sched.weekday);
  const day = new Date(Date.UTC(base.y, base.m - 1, base.d) + week * 7 * DAY);
  const y = day.getUTCFullYear();
  const m = day.getUTCMonth() + 1;
  const d = day.getUTCDate();
  const tag = `${type.id.slice(-1)}${week < 0 ? "0" : "1"}${String(Math.abs(week)).padStart(3, "0")}`;
  const times = sched.times.map(([h, min], i) => {
    const startsAt = zonedInstant(y, m, d, h, min);
    return { id: `7${tag}${i}`, startsAt, endsAt: new Date(startsAt.getTime() + 75 * 60_000) };
  });
  const rehearsal = zonedInstant(y, m, d - (sched.weekday === "Sun" ? 3 : 1), 19, 0);
  const block = Math.floor((week + 24) / 4);
  const series = SERIES[block % SERIES.length];
  const part = ((week + 24) % 4) + 1;
  const dates = new Intl.DateTimeFormat("en-US", { timeZone: ORG_TIME_ZONE, month: "short", day: "numeric", year: "numeric" }).format(
    times[0].startsAt,
  );
  return { id: `2${tag}`, typeId: type.id, typeKey, week, title: `${series}, Part ${part}`, series, dates, times, rehearsal, y, m, d };
}

/** The id of the Weekend plan that is under way in live mode. */
export const LIVE_PLAN_ID = "2900001";

/**
 * The Weekend service as it looks while it is on: the upcoming Sunday's plan, but
 * dated today, its first service started 14 minutes ago and its second to come.
 *
 * A plan of its own rather than the Sunday one moved: Planning Center's plan times
 * are cached for 15 minutes, so moving a plan the app has already read would leave
 * its clock showing Sunday. The capture step switches the app onto this plan when
 * it goes live.
 */
export function liveWeekendPlan(now) {
  const plan = planFor("weekend", 0, now);
  const first = new Date(now.getTime() - 14 * 60_000);
  const second = new Date(now.getTime() + 106 * 60_000);
  const dates = new Intl.DateTimeFormat("en-US", { timeZone: ORG_TIME_ZONE, month: "short", day: "numeric", year: "numeric" }).format(first);
  return {
    ...plan,
    id: LIVE_PLAN_ID,
    week: 0,
    dates,
    times: [
      { id: "7900010", startsAt: first, endsAt: new Date(first.getTime() + 75 * 60_000) },
      { id: "7900011", startsAt: second, endsAt: new Date(second.getTime() + 75 * 60_000) },
    ],
  };
}

/** Plans of a type, oldest first. */
export function plansFor(typeKey, now, back = 14, ahead = 3) {
  const out = [];
  for (let w = -back; w <= ahead; w++) out.push(planFor(typeKey, w, now));
  return out;
}

// ── Addresses (all placeholders) ───────────────────────────────────────────────

/** What the app believes the machine's LAN address is. */
export const SERVER_LAN_IP = "192.168.1.20";

/** Wireless receivers. The address the app dials is remapped by the preload to
 *  the fake Shure server, so nothing leaves the machine. */
export const WIRELESS_RECEIVERS = [
  { name: "Stage Rack A", host: "192.168.1.41", provider: "shure-ulxd", channels: 4 },
  { name: "Stage Rack B", host: "192.168.1.42", provider: "shure-ulxd", channels: 4 },
];

/**
 * Telemetry per receiver channel. `bars` is BATT_BARS (255 = no transmitter),
 * `charge` percent, `mins` runtime left, `rf` dBm, `audio` 0..1, `freq` kHz.
 */
export const WIRELESS_CHANNELS = {
  "192.168.1.41": [
    { name: "Worship Lead", bars: 5, charge: 92, mins: 540, rf: -52, audio: 0.6, freq: 518350, quality: 5 },
    { name: "Vocal 2", bars: 5, charge: 78, mins: 455, rf: -58, audio: 0.45, freq: 520125, quality: 5 },
    { name: "Vocal 3", bars: 4, charge: 41, mins: 240, rf: -66, audio: 0.3, freq: 521800, quality: 4 },
    { name: "Host", bars: 5, charge: 100, mins: 600, rf: -49, audio: 0.0, freq: 523400, quality: 5, muted: true },
  ],
  "192.168.1.42": [
    { name: "Pastor", bars: 5, charge: 88, mins: 520, rf: -55, audio: 0.0, freq: 525050, quality: 5 },
    { name: "Acoustic Vox", bars: 2, charge: 19, mins: 110, rf: -74, audio: 0.2, freq: 526700, quality: 3 },
    { name: "Drum Talkback", bars: 5, charge: 95, mins: 570, rf: -60, audio: 0.1, freq: 528350, quality: 5 },
    { name: "Spare", bars: 255, charge: 255, mins: 65535, rf: -128, audio: 0, freq: 530000, quality: 255 },
  ],
};

/** Unclaimed kiosk devices, as announced on the discovery port. `ip` is the source
 *  address the server believes they came from (supplied by the preload, because a
 *  datagram sent from this machine arrives from loopback). */
export const FAKE_DEVICES = [
  { id: "demo-pi-0001", macs: ["02:00:00:aa:bb:01"], hostname: "lobby-pi", os: "Linux (Raspberry Pi 5)", mode: "1920x1080", ip: "192.168.1.61" },
  { id: "demo-pi-0002", macs: ["02:00:00:aa:bb:02"], hostname: "overflow-pi", os: "Linux (Raspberry Pi 4)", mode: "1920x1080", ip: "192.168.1.62" },
];
