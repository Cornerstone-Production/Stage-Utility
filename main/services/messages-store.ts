// messages-store.ts — the day's stage messages, so a restart mid-service keeps
// the thread.
//
// "runtime", NOT "config", and the distinction is the design. A message is an
// observation about one day: restoring a backup from last winter and having its
// "Walk now" reappear on this Sunday's screens would be worse than starting
// empty. The groups the messages went to are the operator's work and live in
// messaging-store.ts, which a backup does carry.
//
// The messages service is the only writer; it owns the nightly clear, the cap
// and the broadcast. This module is the file and its shape.

import {
  GROUP_ID,
  EVERYONE,
  MESSAGE_ID,
  type MessageReply,
  type StageMessage,
} from "../types/messages.js";
import { DataStore } from "./data-store.js";
import { scrub } from "./scrub.js";

export interface MessagesFile {
  /**
   * The calendar date, in the app time zone, on which the thread was last
   * cleared (or first started). Null only before the first start. Compared each
   * minute against today's date so a server that was off at midnight clears the
   * stale day on boot.
   */
  lastClearedDate: string | null;
  /** Oldest first. */
  messages: StageMessage[];
}

const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isText = (v: unknown): v is string => typeof v === "string";

function readReply(raw: unknown): MessageReply | null {
  const r = raw as Partial<MessageReply> | null;
  if (!r || typeof r !== "object") return null;
  if (!isText(r.id) || !MESSAGE_ID.test(r.id) || !isNumber(r.at) || !isText(r.from) || !isText(r.text)) return null;
  return { id: r.id, at: r.at, from: r.from, text: r.text };
}

/** One stored message, or null when it cannot be read. Total: it runs on whatever
 *  the file held, including a hand edit, and the result is what every client is
 *  sent — a malformed entry would reach their renderers. */
function readMessage(raw: unknown): StageMessage | null {
  const m = raw as Partial<StageMessage> | null;
  if (!m || typeof m !== "object") return null;
  if (!isText(m.id) || !MESSAGE_ID.test(m.id) || !isNumber(m.at) || !isText(m.text) || !isText(m.from)) return null;
  if (!Array.isArray(m.to) || m.to.length === 0 || !m.to.every((t) => isText(t) && (t === EVERYONE || GROUP_ID.test(t)))) return null;
  const alert = m.alert === true;
  return {
    id: m.id,
    at: m.at,
    to: [...m.to],
    text: m.text,
    alert,
    alertUntil: alert && isNumber(m.alertUntil) ? m.alertUntil : null,
    clearedAt: isNumber(m.clearedAt) ? m.clearedAt : null,
    from: m.from,
    replies: (Array.isArray(m.replies) ? m.replies : []).map(readReply).filter((r): r is MessageReply => r !== null),
  };
}

function readFile(parsed: unknown): MessagesFile {
  const raw = (parsed !== null && typeof parsed === "object" ? parsed : {}) as Partial<MessagesFile>;
  const rows = Array.isArray(raw.messages) ? raw.messages : [];
  const messages = rows.map(readMessage).filter((m): m is StageMessage => m !== null);
  if (messages.length !== rows.length) {
    console.warn(
      `[messages] messages.json: left out ${scrub(rows.length - messages.length)} message(s) that could not be read`,
    );
  }
  return {
    lastClearedDate: isText(raw.lastClearedDate) ? raw.lastClearedDate : null,
    messages,
  };
}

export const messagesStore = new DataStore<MessagesFile>(
  "messages.json",
  { lastClearedDate: null, messages: [] },
  "runtime",
  { normalize: readFile },
);
