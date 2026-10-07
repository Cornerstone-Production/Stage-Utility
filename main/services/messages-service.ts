// messages-service.ts — stage messages: send, end an alert, keep the day's
// thread, clear it nightly, and say so to every screen.
//
// WHAT IT OWNS
//   - the day's messages, in memory and in messages.json, written before the
//     in-memory list changes and awaited, so a send that failed to save fails
//     for the caller instead of reading as sent until the next restart;
//   - the `messages:state` channel: one frame per change, stamped with a `rev`;
//   - one timer for the alert that is running, so the state goes back to "no
//     alert" at the moment the alert runs out on screens that keep no timer of
//     their own;
//   - the nightly clear, and the 200-message cap.
//
// THE CLOCK. "What day is it" is asked of app-timezone.ts and never of the host:
// a UTC box rolls its date at 19:00 in Chicago, and clearing the thread in the
// middle of an evening service is the failure this is written around. Instants
// (`at`, `alertUntil`) are server milliseconds from Date.now(); screens count an
// alert down against the server clock, from `alertUntil`, so a Pi with a wrong
// clock still ends it on time.
//
// ONE ALERT IN THE STATE. `alert` is the newest message whose alert is still
// running. Two alerts can run at once (to different groups), and this field
// names only the newer; each message still carries its own `alertUntil` and
// `clearedAt`, so a screen that must know about every running alert reads them
// from `messages`.

import { randomBytes } from "node:crypto";

import {
  ALERT_MS,
  DEFAULT_FROM,
  EVERYONE,
  FROM_MAX,
  GROUP_ID,
  GROUPS_MAX,
  MESSAGE_ID,
  MESSAGE_MAX,
  MESSAGES_CAP,
  MESSAGES_CHANNEL,
  type MessageGroup,
  type MessagesState,
  type MessagingConfig,
  type StageMessage,
} from "../types/messages.js";
import { zonedDateKey } from "./app-timezone.js";
import { broadcast } from "./broadcaster.js";
import { messagesStore } from "./messages-store.js";
import { messagingStore } from "./messaging-store.js";
import { scrub, scrubError } from "./scrub.js";
import { stageController } from "./stage-controller.js";
import { Ticker } from "./ticker.js";
import { WriteQueue } from "./write-queue.js";

/** How often the date is compared against the day the thread was last cleared. */
const CLEAR_CHECK_MS = 60_000;
/** How much of a message's text one log line carries. */
const LOG_TEXT_MAX = 120;

/**
 * The caller's mistake: a body the rules refuse. Routes answer it 400 with the
 * message; anything else that throws out of here is a failed write and is not
 * dressed up as one.
 */
export class MessageRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MessageRefused";
  }
}

export interface SendInput {
  to: unknown;
  text: unknown;
  alert?: unknown;
  from?: unknown;
}

/** What a send or a clear refuses to do, as `name` says. */
function checkedFrom(value: unknown): string {
  if (value === undefined) return DEFAULT_FROM;
  if (typeof value !== "string") throw new MessageRefused("from must be text");
  const from = value.trim();
  if (from.length < 1) throw new MessageRefused("from cannot be empty");
  if (from.length > FROM_MAX) throw new MessageRefused(`from is at most ${FROM_MAX} characters (this one is ${from.length})`);
  return from;
}

/**
 * The rules for a send, pure so they read without a store: `to` names groups
 * that exist or is exactly Everyone; `text` is 1 to 280 characters once trimmed.
 * Group ids off the wire are checked against GROUP_ID, then looked up in a Map
 * of the groups that exist — never used as a property name.
 */
export function checkSend(
  input: SendInput,
  groups: readonly MessageGroup[],
): { to: string[]; text: string; alert: boolean; from: string } {
  if (!Array.isArray(input.to) || input.to.length === 0) {
    throw new MessageRefused("to must name at least one group, or be [\"everyone\"]");
  }
  if (input.to.length > GROUPS_MAX + 1) throw new MessageRefused("to names too many groups");
  const wanted = new Set<string>();
  for (const t of input.to) {
    if (typeof t !== "string") throw new MessageRefused("to must be a list of group ids");
    wanted.add(t);
  }
  let to: string[];
  if (wanted.has(EVERYONE)) {
    if (wanted.size > 1) throw new MessageRefused("Everyone cannot be combined with other groups");
    to = [EVERYONE];
  } else {
    const known = new Map(groups.map((g) => [g.id, g]));
    for (const id of wanted) {
      if (!GROUP_ID.test(id)) throw new MessageRefused("to holds an id that is not a group id");
      if (!known.has(id)) throw new MessageRefused(`no group has the id ${id}`);
    }
    // The config's order, so the stored list does not depend on click order.
    to = groups.filter((g) => wanted.has(g.id)).map((g) => g.id);
  }

  if (typeof input.text !== "string") throw new MessageRefused("text must be text");
  const text = input.text.trim();
  if (text.length < 1) throw new MessageRefused("a message cannot be empty");
  if (text.length > MESSAGE_MAX) {
    throw new MessageRefused(`a message is at most ${MESSAGE_MAX} characters (this one is ${text.length})`);
  }

  if (input.alert !== undefined && typeof input.alert !== "boolean") {
    throw new MessageRefused("alert must be true or false");
  }
  return { to, text, alert: input.alert === true, from: checkedFrom(input.from) };
}

/** Is this message's alert still holding the screens at `now`? */
function alertRunning(m: StageMessage, now: number): boolean {
  return m.alert && m.clearedAt === null && m.alertUntil !== null && m.alertUntil > now;
}

export class MessagesService {
  private messages: StageMessage[] = [];
  private lastClearedDate: string | null = null;
  private rev = 0;
  private running = false;
  private loading: Promise<void> | null = null;
  private loaded = false;
  private alertTimer: ReturnType<typeof setTimeout> | null = null;
  /** The day the 200-message cap was last logged, so it says so once a day. */
  private capLoggedOn: string | null = null;
  /** Serialises every change to the thread: each builds the next list from the
   *  current one and publishes it once it is on disk. */
  private readonly writes = new WriteQueue();

  private readonly clock = new Ticker({
    tick: async () => {
      await this.rollDay();
      return "done" as const;
    },
    nextDelayMs: () => CLEAR_CHECK_MS,
    wanted: () => this.running,
  });

  // ── Reading ────────────────────────────────────────────────────────────

  /** The snapshot `messages:state` carries and GET /api/messages answers. */
  state(): MessagesState {
    const now = Date.now();
    const alert = [...this.messages].reverse().find((m) => alertRunning(m, now)) ?? null;
    return { rev: this.rev, groups: messagingStore.get().groups, messages: this.messages, alert };
  }

  // ── Life cycle ─────────────────────────────────────────────────────────

  /**
   * Load the day's messages, compare the date against the day they belong to
   * (a server that was off at midnight clears on boot), and start the
   * once-a-minute check.
   *
   * Returns the failure of that first check instead of throwing it: a data
   * directory that cannot be written must not stop the server booting and
   * blank every screen, and the caller says so on /log.
   */
  async start(): Promise<Error | null> {
    await this.ensureLoaded();
    this.running = true;
    this.armAlertTimer();
    let failure: Error | null = null;
    try {
      await this.rollDay();
    } catch (err) {
      failure = err instanceof Error ? err : new Error(String(err));
    }
    this.clock.arm(CLEAR_CHECK_MS);
    return failure;
  }

  stop(): void {
    this.running = false;
    this.clock.cancel();
    if (this.alertTimer) clearTimeout(this.alertTimer);
    this.alertTimer = null;
  }

  // ── Changes ────────────────────────────────────────────────────────────

  /** Send a message. Refuses with MessageRefused, naming the reason. */
  async send(input: SendInput): Promise<StageMessage> {
    await this.ensureLoaded();
    let checked: ReturnType<typeof checkSend>;
    try {
      checked = checkSend(input, messagingStore.get().groups);
    } catch (err) {
      if (err instanceof MessageRefused) console.warn(`[messages] refused: ${scrub(err.message)}`);
      throw err;
    }
    return this.writes.enqueue(async () => {
      await this.rollDayLocked();
      const at = Date.now();
      const message: StageMessage = {
        id: randomBytes(8).toString("hex"),
        at,
        to: checked.to,
        text: checked.text,
        alert: checked.alert,
        alertUntil: checked.alert ? at + ALERT_MS : null,
        clearedAt: null,
        from: checked.from,
        replies: [],
      };
      let next = [...this.messages, message];
      const over = next.length - MESSAGES_CAP;
      if (over > 0) next = next.slice(over);
      await this.persist(this.lastClearedDate, next);
      if (over > 0) this.noteCap(at);

      const groups = new Map(messagingStore.get().groups.map((g) => [g.id, g.name]));
      const names = message.to.map((id) => (id === EVERYONE ? "Everyone" : groups.get(id) ?? id)).join(", ");
      console.log(
        `[messages] sent to ${scrub(names)}${scrub(message.alert ? " (alert)" : "")} by ${scrub(message.from)}: "${scrub(message.text, LOG_TEXT_MAX)}"`,
      );
      this.publish();
      return message;
    });
  }

  /**
   * End a running alert early. The message stays in the thread.
   *
   * "not-found" for an id nobody issued, "not-running" for a message whose alert
   * is already over (or was never an alert) — a no-op, so pressing Clear twice
   * is not an error.
   */
  async clearAlert(id: string, from?: unknown): Promise<"cleared" | "not-running" | "not-found"> {
    await this.ensureLoaded();
    const by = checkedFrom(from);
    if (!MESSAGE_ID.test(id)) return "not-found";
    return this.writes.enqueue(async () => {
      const found = this.messages.find((m) => m.id === id);
      if (!found) return "not-found";
      const now = Date.now();
      if (!alertRunning(found, now)) return "not-running";
      const next = this.messages.map((m) => (m.id === id ? { ...m, clearedAt: now } : m));
      await this.persist(this.lastClearedDate, next);
      console.log(`[messages] alert ${scrub(found.id)} cleared by ${scrub(by)}`);
      this.publish();
      return "cleared";
    });
  }

  /**
   * Replace the messaging config (groups, quick messages, quick replies).
   *
   * A group whose id is gone comes off every screen that held it, in one write,
   * and the state is re-sent because it carries `groups`. Messages already sent
   * to the group are left alone. Refuses with MessagingRefused like the store.
   */
  async updateConfig(input: unknown): Promise<MessagingConfig> {
    await messagingStore.init();
    const groupsBefore = JSON.stringify(messagingStore.get().groups);
    const { config, removed } = await messagingStore.replace(input);
    try {
      if (removed.length > 0) {
        // Counted per group before the strip, because the strip is one write over
        // every screen and answers only a total.
        const outputs = stageController.getState().outputs;
        const held = new Map(removed.map((g) => [g.id, outputs.filter((o) => o.groups?.includes(g.id)).length]));
        await stageController.stripOutputGroups(removed.map((g) => g.id));
        for (const g of removed) {
          console.log(`[messages] group "${scrub(g.name)}" deleted; removed from ${scrub(held.get(g.id) ?? 0)} screen(s)`);
        }
      }
    } finally {
      // Re-sent even when the strip failed: the config is saved either way, and
      // the screens must not keep drawing a group that is gone.
      if (JSON.stringify(config.groups) !== groupsBefore) this.publish();
    }
    return config;
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    // The load in flight, shared: two callers arriving cold must not each assign
    // the list over the other's send.
    this.loading ??= (async () => {
      await messagingStore.init();
      const file = await messagesStore.load();
      this.messages = file.messages;
      this.lastClearedDate = file.lastClearedDate;
      this.loaded = true;
    })();
    try {
      await this.loading;
    } finally {
      this.loading = null;
    }
  }

  /**
   * Write the next thread, THEN make it the live one. A write that fails (a full
   * SD card) throws to the caller and leaves what was there, instead of a thread
   * every screen shows that the next restart loses.
   */
  private async persist(date: string | null, next: StageMessage[]): Promise<void> {
    try {
      await messagesStore.save({ lastClearedDate: date, messages: next });
    } catch (err) {
      // The caller gets the failure; this line is for the 9am-on-a-Sunday reader,
      // since a send that will not save otherwise leaves nothing on /log.
      console.error("[messages] could not save, NOT recorded:", scrubError(err));
      throw err;
    }
    this.messages = next;
    this.lastClearedDate = date;
  }

  /** One frame to every screen, and the alert timer re-aimed at whatever runs now. */
  private publish(): void {
    this.rev++;
    broadcast(MESSAGES_CHANNEL, this.state());
    this.armAlertTimer();
  }

  /**
   * One timer, for the alert the state is showing, cleared before it is re-armed.
   * When it fires the alert is over, so the state is sent again with `alert`
   * back to null (or to an older alert that is still running).
   */
  private armAlertTimer(): void {
    if (this.alertTimer) clearTimeout(this.alertTimer);
    this.alertTimer = null;
    if (!this.running) return;
    const alert = this.state().alert;
    if (alert?.alertUntil == null) return;
    // At least 1 ms, and re-checked when it fires: a timer may run a hair early
    // against Date.now(), and an alert that is still running then is re-armed
    // rather than announced over.
    this.alertTimer = setTimeout(() => this.alertTimerFired(), Math.max(1, alert.alertUntil - Date.now()));
    this.alertTimer.unref();
  }

  private alertTimerFired(): void {
    this.alertTimer = null;
    if (this.state().alert) {
      this.armAlertTimer();
      return;
    }
    this.publish();
  }

  /** Compare today's date, in the app time zone, with the day the thread was last cleared. */
  private async rollDay(): Promise<void> {
    await this.ensureLoaded();
    await this.writes.enqueue(() => this.rollDayLocked());
  }

  /**
   * The clear itself, run inside the write queue. Also run at the head of every
   * send: a message sent at 00:00:20 must not be swept away by the 00:01 check.
   *
   * Only a date that has ADVANCED clears. A store with no date yet records today
   * and clears nothing; a stored date AHEAD of today (the time zone was moved
   * west) is adopted without a clear, since those messages are today's.
   */
  private async rollDayLocked(): Promise<void> {
    const today = zonedDateKey(Date.now());
    const previous = this.lastClearedDate;
    if (previous === today) return;
    if (previous === null) {
      await this.persist(today, this.messages);
      return;
    }
    if (previous > today) {
      await this.persist(today, this.messages);
      console.log("[messages] the date moved back (a time zone change?); today's messages are kept");
      return;
    }
    const removed = this.messages.length;
    await this.persist(today, []);
    console.log(`[messages] nightly clear removed ${scrub(removed)} message(s)`);
    if (removed > 0) this.publish();
  }

  /** Say once per day that the oldest messages are being dropped. */
  private noteCap(at: number): void {
    const today = zonedDateKey(at);
    if (this.capLoggedOn === today) return;
    this.capLoggedOn = today;
    console.log(`[messages] over ${scrub(MESSAGES_CAP)} today; dropping the oldest`);
  }
}

export const messagesService = new MessagesService();
