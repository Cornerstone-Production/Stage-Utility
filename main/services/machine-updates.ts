// machine-updates.ts — the machines that show screens follow this server's version.
//
// Two kinds of machine install software of their own beside the browser page this
// server sends them, and both fall behind when the server updates:
//
//   - a Mac running the output helper, StageUtilityOutput.app, whose version is the
//     server's package.json version it shipped with;
//   - a Windows kiosk, whose launcher script (kiosk-windows.ps1) decides how it
//     finds this server.
//
// Each runs a small updater of its own (a root LaunchDaemon on the Mac, a SYSTEM
// scheduled task on Windows) that asks GET /api/machine-updates/check every few
// minutes. THIS module answers it, so every rule about WHEN lives on the server, in
// one place, and in the app's time zone: the machine's own clock and zone never
// decide anything. The updater does what the answer says and reports what it did on
// its next check.
//
// RUNTIME, deliberately. What a machine last said is a reading, not the operator's
// work: in memory, aged out when the machine stops asking, gone on restart. What a
// machine must remember across a restart (a version that failed, so it is not tried
// again every five minutes) it remembers itself, and says so in every check.
//
// The check is not authenticated. A Mac's updater runs as root and could read an
// output's token, but its device ids are derived in Swift (DeviceIdentity) and a
// shell script cannot reproduce them; the Windows task has the kiosk's token but no
// helper outputs. So a report is what a machine on the network SAYS: it is bounded,
// scrubbed, and drives nothing but a line of text and a log line. The decision it
// gets back is public information (this server's version, and whether it would
// update), and downloading still needs the published checksum to match.

import { scrub } from "./scrub.js";
import { clockOf } from "./app-timezone.js";

export const UPDATE_PLATFORMS = ["macos", "windows"] as const;
export type UpdatePlatform = (typeof UPDATE_PLATFORMS)[number];

/**
 * What the updater on a machine last did, in its own words. Kept by the machine,
 * in its status file, and sent with every check until something else happens.
 *
 *   idle           nothing to report
 *   updated        `target` is now installed
 *   failed         `target` could not be installed, or did not start; what is
 *                  installed is still `have`, and `detail` says why
 *   no-session     an update is due but nobody is logged in at the Mac, so the new
 *                  helper could not be started and checked
 *   not-running    an update is due but the helper was quit at the Mac, and an
 *                  update does not start it again behind someone's back
 *   local-network  `target` is installed and running, but macOS refuses it Local
 *                  Network access, so someone at the Mac has to answer the prompt
 */
export const MACHINE_STATES = ["idle", "updated", "failed", "no-session", "not-running", "local-network"] as const;
export type MachineState = (typeof MACHINE_STATES)[number];

/** Why a machine is told not to update now. */
export type WaitReason =
  /** Already on this server's version. */
  | "current"
  /** The operator turned automatic updates off, and nobody asked for this one. */
  | "off"
  /** This version failed on this machine before; it waits for Try again. */
  | "failed"
  /** Planning Center reports a service live. */
  | "live"
  /** Within the window around a rehearsal or service (service-window.ts). */
  | "window";

export type Decision = { update: true } | { update: false; why: WaitReason; until?: number };

/** One machine as Screens shows it. Everything a person reads about its updates. */
export interface MachineUpdate {
  /** The machine's own device id: a Mac's `device-id`, a Windows kiosk's. A helper
   *  output's device id is this plus `.<output key>`. */
  machine: string;
  platform: UpdatePlatform;
  host?: string;
  /** What is installed: the helper's version, or the launcher's SHA-256. */
  have: string;
  /** What this server has. */
  want: string;
  state: MachineState;
  /** The version (or launcher digest) the state is about. */
  target?: string;
  detail?: string;
  checkedAt: number;
  /** The answer it was given. */
  update: boolean;
  /** A sentence for a person, from `describe`. */
  reason: string;
  /** Why it was told to wait, when it was. Update now or Try again changes the
   *  answer for `off`, `failed` and `window`, never for `live`. */
  waitingOn?: WaitReason;
  /** When a `window` wait ends. */
  waitUntil?: number;
}

/** How long a machine that stops asking is still listed. Its updater asks every
 *  five minutes; three missed checks is a machine that is off, or an updater that
 *  is broken, and either way what it last said is no longer what it is doing. */
export const REPORT_TTL_MS = 20 * 60_000;
/** The most machines remembered. The check is open, and a sender on the network
 *  must not be able to grow this without limit. A site has tens of these. */
export const MAX_MACHINES = 256;
const MAX_TEXT = 200;
const MAX_VERSION = 64;

export interface CheckInput {
  machine: string;
  platform: UpdatePlatform;
  host?: string;
  arch?: string;
  have: string;
  state: MachineState;
  target?: string;
  detail?: string;
}

/** A check's query string, read strictly: anything malformed is a 400, so a broken
 *  updater is told so rather than silently answered as if it had said nothing. */
export function parseCheck(q: URLSearchParams): CheckInput | { error: string } {
  const text = (name: string, max: number): string | undefined => {
    const v = q.get(name);
    if (v === null || v === "") return undefined;
    return v.length <= max ? v : undefined;
  };
  const machine = text("machine", 128);
  if (!machine || !/^[A-Za-z0-9._-]+$/.test(machine)) return { error: "machine (the device id) is required" };
  const platform = q.get("platform");
  if (!UPDATE_PLATFORMS.includes(platform as UpdatePlatform)) return { error: "platform must be macos or windows" };
  const have = text("have", MAX_VERSION);
  if (!have) return { error: "have (what is installed) is required" };
  const state = (q.get("state") || "idle") as MachineState;
  if (!MACHINE_STATES.includes(state)) return { error: `state must be one of ${MACHINE_STATES.join(", ")}` };
  const arch = text("arch", 16);
  return {
    machine,
    platform: platform as UpdatePlatform,
    host: text("host", 128),
    arch,
    have,
    state,
    target: text("target", MAX_VERSION),
    // A machine's own words, cut rather than refused: a long reason is still a reason.
    detail: q.get("detail")?.slice(0, MAX_TEXT) || undefined,
  };
}

export interface Gate {
  /** This server's version, or for Windows its launcher's digest. */
  want: string;
  auto: boolean;
  /** Someone pressed Update now or Try again for this machine. */
  requested: boolean;
  live: boolean;
  /** When the service window open now closes, or null when none is open. */
  windowCloses: number | null;
}

/**
 * Whether a machine should update now. The one place this is decided.
 *
 * A Mac restarts its helper to finish, which takes every output it drives off air
 * for about two seconds, so it never does while a service is live or within the
 * window around one (the app's one definition of "near a service", service-window
 * .ts). Update now overrides the switch and the window, because a person asked;
 * it does not override a live service, because a press on the wrong row must not
 * black out an SDI feed on air.
 *
 * A Windows kiosk replaces a file and restarts nothing (the new launcher runs at the
 * next sign-in), so only the switch applies to it.
 */
export function decide(input: Pick<CheckInput, "platform" | "have" | "state" | "target">, gate: Gate): Decision {
  if (input.have === gate.want) return { update: false, why: "current" };
  if (input.state === "failed" && input.target === gate.want && !gate.requested) return { update: false, why: "failed" };
  if (!gate.auto && !gate.requested) return { update: false, why: "off" };
  if (input.platform === "windows") return { update: true };
  if (gate.live) return { update: false, why: "live" };
  if (gate.windowCloses !== null && !gate.requested) return { update: false, why: "window", until: gate.windowCloses };
  return { update: true };
}

/** The sentence Screens shows for a machine. A Windows launcher is a digest,
 *  which nobody can read, so it is never named. */
export function describe(platform: UpdatePlatform, have: string, want: string, d: Decision, state: MachineState, target: string | undefined, detail: string | undefined): string {
  const why = detail ? ` (${detail})` : "";
  if (platform === "windows") {
    if (d.update) return "Kiosk launcher updating";
    switch (d.why) {
      case "current":
        return state === "updated" ? "Kiosk launcher updated. It takes effect at the next sign-in" : "Kiosk launcher up to date";
      case "failed":
        return `Kiosk launcher out of date. The update failed${why}, so it is not tried again until someone asks`;
      default:
        return "Kiosk launcher out of date. Automatic updates are off";
    }
  }
  if (state === "local-network") return `Helper ${have}. macOS asks for Local Network access again since the update: someone at the Mac has to choose Allow`;
  // The server says go, and the Mac cannot yet: say what it is waiting for.
  if (d.update && state === "no-session") return `Helper ${have}. Updates to ${want} once someone is logged in at the Mac`;
  if (d.update && state === "not-running") return `Helper ${have}. Updates to ${want} once the helper is running again (it was quit at the Mac)`;
  if (d.update) return `Helper ${have}. Updating to ${want}`;
  switch (d.why) {
    case "current":
      return `Helper ${have}, the same as this server`;
    case "failed":
      return `Helper ${have}. The update to ${target ?? want} failed${why}, so it is not tried again until someone asks`;
    case "off":
      return `Helper ${have}. This server is ${want}; automatic updates are off`;
    case "live":
      return `Helper ${have}. Updates to ${want} when the service is no longer live`;
    case "window":
      return `Helper ${have}. Updates to ${want} after the service window closes at ${closing(d.until)}`;
  }
}

/** HH:MM in the app's zone: an operator reads it against their own clock. */
function closing(until: number | undefined): string {
  return clockOf(until ?? 0).slice(0, 5);
}

/** The noun for a machine in a log line: its name and enough of its id to tell
 *  two machines with the same name apart. */
function who(m: Pick<MachineUpdate, "host" | "machine" | "platform">): string {
  const kind = m.platform === "macos" ? "Mac" : "Windows kiosk";
  return `${kind} ${scrub(m.host || "with no name")} (${scrub(m.machine.slice(0, 8))})`;
}

export class MachineUpdates {
  private readonly machines = new Map<string, MachineUpdate>();
  /** Machines someone pressed Update now or Try again for. Consumed by the first
   *  answer that tells the machine to go ahead. A Set: the key is request-derived. */
  private readonly requested = new Set<string>();

  constructor(private readonly onChange: () => void = () => {}) {}

  /** Answer one check, remember what the machine said, and log what changed. */
  check(input: CheckInput, gate: Omit<Gate, "requested">, now = Date.now()): MachineUpdate {
    this.prune(now);
    const requested = this.requested.has(input.machine);
    const d = decide(input, { ...gate, requested });
    if (d.update) this.requested.delete(input.machine);
    // A machine that has caught up has nothing left to be asked for.
    if (!d.update && d.why === "current") this.requested.delete(input.machine);
    const next: MachineUpdate = {
      machine: input.machine,
      platform: input.platform,
      host: input.host,
      have: input.have,
      want: gate.want,
      state: input.state,
      target: input.target,
      detail: input.detail,
      checkedAt: now,
      update: d.update,
      reason: describe(input.platform, input.have, gate.want, d, input.state, input.target, input.detail),
      waitingOn: d.update ? undefined : d.why,
      waitUntil: d.update ? undefined : d.until,
    };
    const prev = this.machines.get(input.machine);
    this.machines.delete(input.machine);
    if (this.machines.size >= MAX_MACHINES) this.machines.delete(this.machines.keys().next().value!);
    this.machines.set(input.machine, next);
    this.logChange(prev, next);
    if (!prev || signature(prev) !== signature(next)) this.onChange();
    return next;
  }

  /** Update now, or Try again. Returns false for a machine that has not asked
   *  recently: there is nothing listening to answer. */
  request(machine: string, now = Date.now()): boolean {
    this.prune(now);
    const m = this.machines.get(machine);
    if (!m) return false;
    this.requested.add(machine);
    console.log(`[helper-update] ${who(m)}: an update to ${scrub(m.platform === "macos" ? m.want : "the current launcher")} was asked for from Screens; it starts at the machine's next check, within five minutes`);
    // Answer the button in the listing straight away, rather than leaving
    // "automatic updates are off" on screen until the machine next asks. A live
    // service still holds a Mac back (see decide), so that sentence stands.
    if (m.waitingOn !== "live") {
      this.machines.set(machine, { ...m, reason: "Update asked for. It starts at the machine's next check, within five minutes" });
      this.onChange();
    }
    return true;
  }

  list(now = Date.now()): MachineUpdate[] {
    this.prune(now);
    return [...this.machines.values()];
  }

  /** Tests only. */
  reset(): void {
    this.machines.clear();
    this.requested.clear();
  }

  private prune(now: number): void {
    let dropped = false;
    for (const [id, m] of this.machines) {
      if (m.checkedAt >= now - REPORT_TTL_MS) continue;
      this.machines.delete(id);
      this.requested.delete(id);
      console.log(`[helper-update] ${who(m)} stopped checking for updates`);
      dropped = true;
    }
    if (dropped) this.onChange();
  }

  /** Decisions and outcomes, written when they change, never on every check. */
  private logChange(prev: MachineUpdate | undefined, next: MachineUpdate): void {
    const name = who(next);
    const outcomeChanged = !prev || prev.state !== next.state || prev.target !== next.target || prev.detail !== next.detail;
    if (outcomeChanged && next.state !== "idle") {
      const t = scrub(next.platform === "macos" ? next.target ?? next.have : "the launcher");
      const why = next.detail ? `: ${scrub(next.detail)}` : "";
      const line = {
        updated: `updated ${next.platform === "macos" ? `to ${t}` : "its launcher; it takes effect at the next sign-in"}`,
        failed: `the update${next.platform === "macos" ? ` to ${t}` : ""} failed${why}; it is not tried again until someone asks from Screens`,
        "no-session": "an update is due, but nobody is logged in at the Mac to start and check the new helper; it waits for a login",
        "not-running": "an update is due, but the helper was quit at the Mac; it updates once it runs again",
        "local-network": `macOS refuses the helper Local Network access since the update to ${t}; answer the prompt at the Mac`,
      }[next.state];
      console.log(`[helper-update] ${name}: ${line}`);
    }
    const decisionChanged = !prev || prev.update !== next.update || prev.waitingOn !== next.waitingOn || prev.have !== next.have || prev.want !== next.want;
    if (!decisionChanged) return;
    const on = next.platform === "macos" ? `is on ${scrub(next.have)}, this server is ${scrub(next.want)}` : "has an older launcher than this server";
    if (next.update) console.log(`[helper-update] ${name} ${on}: going ahead`);
    else if (next.waitingOn === "current") console.log(`[helper-update] ${name} ${next.platform === "macos" ? `is on ${scrub(next.have)}, the same as this server` : "has this server's launcher"}`);
    else console.log(`[helper-update] ${name} ${on}: waiting, ${waitPhrase(next)}`);
  }
}

function waitPhrase(m: MachineUpdate): string {
  switch (m.waitingOn) {
    case "off":
      return "automatic updates are off";
    case "failed":
      return "this version failed here before";
    case "live":
      return "a service is live";
    case "window":
      return `a service window is open until ${closing(m.waitUntil)}`;
    default:
      return m.reason;
  }
}

/** What a person reads of a machine: its listing changes only when this does. */
function signature(m: MachineUpdate): string {
  return JSON.stringify([m.platform, m.host, m.have, m.want, m.state, m.target, m.detail, m.update, m.reason]);
}
