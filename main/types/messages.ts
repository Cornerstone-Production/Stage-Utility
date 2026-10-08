// main/types/messages.ts — stage messages: groups of screens, the day's thread,
// and the alerts that are running.
//
// A producer sends a short message to one or more GROUPS of screens (or to
// Everyone). A screen belongs to any number of groups (`Output.groups`). An
// alert is a message that also takes the screens over for ALERT_MS.

/** The built-in target that reaches every screen, in a group or not. Not a
 *  stored group: it cannot be renamed, deleted or assigned to a screen. */
export const EVERYONE = "everyone";

export interface MessageGroup {
  /** Server-generated, `g-` plus eight hex characters (GROUP_ID). Permanent. */
  id: string;
  name: string;
}

/** The operator's own work, in `messaging.json`. */
export interface MessagingConfig {
  /**
   * Bumped by one on every successful replace; a file without one reads as 0.
   * A save must carry the version it was built from, and one built from an older
   * version is refused (409): the whole config is replaced at once, so a window
   * that has not seen another window's new group would otherwise save without
   * it and delete it.
   */
  version: number;
  groups: MessageGroup[];
  /** One-press messages the composer offers. */
  quickMessages: string[];
  /** One-press answers a console offers. */
  quickReplies: string[];
}

export interface MessageReply {
  id: string;
  at: number;
  from: string;
  text: string;
}

export interface StageMessage {
  /** Server-generated, sixteen hex characters (MESSAGE_ID). */
  id: string;
  /** Server clock, ms. */
  at: number;
  /** Group ids, or exactly `[EVERYONE]`. */
  to: string[];
  text: string;
  alert: boolean;
  /** `at + ALERT_MS` when `alert`, else null. */
  alertUntil: number | null;
  /** Set by Clear alert: the alert is over, the message stays in the thread. */
  clearedAt: number | null;
  from: string;
  replies: MessageReply[];
}

/** What `messages:state` carries, and what GET /api/messages answers. */
export interface MessagesState {
  /** Bumped by the server on every frame it sends. A new process starts at 0. */
  rev: number;
  groups: MessageGroup[];
  /** The composer's one-press messages, so a composer placed on a screen offers
   *  the list as Settings has it now. */
  quickMessages: string[];
  /** A console's one-press answers, for the same reason. */
  quickReplies: string[];
  /** Oldest first, today only. */
  messages: StageMessage[];
  /** Every message whose alert is still running, newest first. Two can run at
   *  once, to different groups; a screen shows the ones sent to its groups. */
  alerts: StageMessage[];
}

/** The SSE channel that carries a {@link MessagesState}. */
export const MESSAGES_CHANNEL = "messages:state";

/** How long an alert holds the screens. */
export const ALERT_MS = 30_000;

/** Ids as the server generates them. Anything off the wire is checked against
 *  these before it is used to look anything up. */
export const GROUP_ID = /^g-[0-9a-f]{8}$/;
export const MESSAGE_ID = /^[0-9a-f]{16}$/;

/** The limits, in one place so the Settings page can say them too. */
export const MESSAGE_MAX = 280;
export const MESSAGES_CAP = 200;
export const GROUPS_MAX = 20;
export const GROUP_NAME_MAX = 40;
export const QUICK_MESSAGES_MAX = 24;
export const QUICK_REPLIES_MAX = 12;
export const QUICK_REPLY_MAX = 60;
export const FROM_MAX = 60;

/** What a message says it came from when the sender does not say. */
export const DEFAULT_FROM = "Operator";

export const DEFAULT_QUICK_MESSAGES: readonly string[] = [
  "Walk now",
  "You're on after this song",
  "2 minutes",
  "Wrap it up",
  "Band back on stage",
  "Running 5 min late",
];

export const DEFAULT_QUICK_REPLIES: readonly string[] = ["Copy", "Walking now", "Need 2 min"];
