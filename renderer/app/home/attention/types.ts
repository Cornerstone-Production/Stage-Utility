// What Home's Needs attention is made of.
//
// Every source is a pure function from state Home already reads to zero or more
// items, so each is testable without rendering and none can fetch anything of
// its own. The data arrives in one AttentionInput, assembled by use-attention.ts.

import type { DeviceStatus } from "@main/types/devices";
import type { AttentionSeverity } from "@main/types/home-snoozes";
import type { IntegrationState } from "@main/types/integrations";
import type { ObsStatusDTO, ReaperStatusDTO, StreamStatusDTO } from "@main/types/live";

export type { AttentionSeverity };

/** Where a fix goes, or what it does in place. */
export interface AttentionFix {
  label: string;
  /** A page to open. */
  route?: string;
  /** `data-flash-id` of the control on that page that fixes it. */
  flash?: string;
  /** Instead of opening a page: a command to press now (POST /api/cues/:name), so
   *  Simulate, Disarm and the activity log apply as they do to any Button. */
  command?: string;
}

export interface AttentionItem {
  /** `${source}:${subject}` -- stable, and the snooze key. */
  key: string;
  severity: AttentionSeverity;
  /** "Handheld 3 at 19%". */
  title: string;
  /** The reason, not a restatement. */
  detail: string;
  fix: AttentionFix;
}

/**
 * A source that has not answered contributes nothing: each takes its own `known`
 * flag, as `readinessChecks` takes `onlineKnown`, because the page must never
 * tell an operator to fix something it has not heard about.
 */
export interface AttentionInput {
  /** Home's mood. Severity depends on it; "unknown" never reaches a source. */
  mood: "live" | "idle";
  /** The server's clock, ms. */
  now: number;
  state: StageState;
  /** Output ids with a live heartbeat, and whether presence has answered. */
  onlineOutputIds: readonly string[];
  onlineKnown: boolean;
  /** When each output last reported in, epoch ms. An output with no entry has never connected. */
  lastSeen: ReadonlyMap<string, number>;
  wireless: readonly DeviceStatus[];
  wirelessKnown: boolean;
  /** Wireless channel id -> what the slot it is assigned to is called. A channel
   *  in no slot is not anyone's problem. */
  assigned: ReadonlyMap<string, string>;
  /** Minutes the service has left (plan length less elapsed), or null when that is not known. */
  minutesLeft: number | null;
  integrations: readonly IntegrationState[];
  integrationLabels: Readonly<Record<string, string>>;
  integrationsKnown: boolean;
  /** When this browser first saw each integration down, epoch ms. */
  downSince: ReadonlyMap<string, number>;
  reaper: ReaperStatusDTO | null;
  reaperKnown: boolean;
  obs: ObsStatusDTO | null;
  obsKnown: boolean;
  /** Streaming platforms, read only while their integration is enabled. */
  resi: StreamStatusDTO | null;
  resiKnown: boolean;
  youtube: StreamStatusDTO | null;
  youtubeKnown: boolean;
}

/** One source: its id is the first half of every key it makes. */
export interface AttentionSource {
  id: string;
  items: (input: AttentionInput) => AttentionItem[];
}

/** FNV-1a over the UTF-16 units, as 8 hex digits. Not crypto: a plain-HTTP page has
 *  no crypto.subtle, and all this has to do is tell two subjects apart. */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** The longest subject the server's key shape takes (SNOOZE_KEY). */
const SUBJECT_MAX = 100;

/**
 * A snooze key. The subject often comes from an id the app did not choose
 * (a wireless channel is `connection::bay`), and the server accepts only a fixed
 * alphabet, so anything outside it becomes `_`. That alone would let "a b" and
 * "a_b" share a key, and so would cutting a long subject short: whenever anything
 * was replaced or cut, a hash of the ORIGINAL subject is appended so two
 * different subjects stay two keys. A subject that was already clean is untouched.
 */
export function attentionKey(source: string, subject: string): string {
  const clean = subject.replace(/[^A-Za-z0-9_.:-]/g, "_");
  if (clean === subject && clean.length <= SUBJECT_MAX) return `${source}:${clean}`;
  const suffix = `-${fnv1a(subject)}`;
  return `${source}:${clean.slice(0, SUBJECT_MAX - suffix.length)}${suffix}`;
}
