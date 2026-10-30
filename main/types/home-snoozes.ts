// Home's snoozed attention items, shared by the server's store and Home's widget.

/** Severity of an attention item. Ordered: a rise un-snoozes. */
export type AttentionSeverity = "critical" | "warn";

/** One snoozed problem. `key` is the item's `${source}:${subject}`. */
export interface HomeSnooze {
  key: string;
  /** The severity the item had when it was snoozed. */
  severity: AttentionSeverity;
  /** When it was snoozed, epoch ms. */
  at: number;
  /** Epoch ms after which it lapses on its own. Null: until the next service
   *  starts. Set only when Planning Center is not configured, where "the next
   *  service" is never announced. */
  expiresAt: number | null;
}

/** What `home:snoozes` carries and GET /api/home/snoozes answers. */
export interface HomeSnoozesState {
  /** Bumped on every change; a new process starts at 0. */
  rev: number;
  snoozes: HomeSnooze[];
}

/** The SSE channel that carries a {@link HomeSnoozesState}. */
export const HOME_SNOOZES_CHANNEL = "home:snoozes";

/** Keys as the widget builds them: a source name, a colon, a subject id. */
export const SNOOZE_KEY = /^[A-Za-z0-9_.-]{1,40}:[A-Za-z0-9_.:-]{1,100}$/;

/** How long a snooze lasts where no service is ever announced. */
export const SNOOZE_NO_PCO_MS = 12 * 60 * 60 * 1000;
