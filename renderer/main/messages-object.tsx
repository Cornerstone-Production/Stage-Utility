// messages-object.tsx — the Messages widget: the newest stage messages sent to a
// screen's groups, each with the latest reply under it.
//
// DRAWN AS THE APPROVED MOCKUP DRAWS IT. A card headed "Messages", then up to
// three messages newest first — the newest large, the older two smaller and
// muted — each with its sender and age on a small line above and its latest
// reply in green below. Every size is a multiple of the object's own font size
// (the mockup's, divided by its 2.6cqw newest message), so the card scales with
// whatever the operator sets.
//
// WHICH MESSAGES. Those sent to Everyone or to a group the widget follows: its
// own list when it has one, else the groups of the screen it is drawn on (see
// widgetGroups). A widget with neither — on an in-app console, which is no
// screen, before any group is chosen — shows nothing, and says to choose in the
// editor.
//
// AGE is counted against the SERVER's clock (`now`), the one every widget draws
// from: a wall Pi's own is as wrong as the last time anyone set it.

import type { CSSProperties } from "react";

import { messageReaches, widgetGroups, type MessageGroup, type MessagesState, type StageMessage } from "@main/types/messages";

/** How many messages the widget draws. */
export const MESSAGES_SHOWN = 3;

/** The newest messages that reached these groups, newest first. */
export function shownMessages(state: MessagesState, groups: readonly string[]): StageMessage[] {
  return state.messages.filter((m) => messageReaches(m.to, groups)).slice(-MESSAGES_SHOWN).reverse();
}

/**
 * "now", "3 min", "2 h": how long ago, off the server's clock. Under 45 seconds
 * is "now"; a message's age is never shown as negative however far a wall's own
 * clock is out, because it is `now` and `at` that are compared and both are the
 * server's.
 */
export function ageLabel(now: number, at: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return "now";
  const m = Math.max(1, Math.round(s / 60));
  return m < 90 ? `${m} min` : `${Math.round(m / 60)} h`;
}

/** The group names a widget follows, in the config's order, for the line that
 *  says what a console can answer. Deleted groups drop out. */
export function groupNames(all: readonly MessageGroup[], ids: readonly string[]): string[] {
  const mine = new Set(ids);
  return all.filter((g) => mine.has(g.id)).map((g) => g.name);
}

export interface MessagesObjectProps {
  config: { groups?: string[] | null };
  /** The channel's value, and whether it has answered — see useMessagesStatus. */
  state: MessagesState | null;
  known: boolean;
  /** The groups of the screen this is drawn on; null when it is not on a screen. */
  screenGroups: readonly string[] | null;
  /** The layout editor's own canvas. */
  editing: boolean;
  /** The server's clock, ms. */
  now: number;
  ts: CSSProperties;
}

/** The eyebrow, the feed and the quiet states share one card body. */
export function MessagesObject({ config, state, known, screenGroups, editing, now, ts }: MessagesObjectProps) {
  const groups = widgetGroups(config.groups, screenGroups);
  const shown = groups && state ? shownMessages(state, groups) : null;

  return (
    <div
      style={{
        ...ts,
        // The card draws its own padding and text scale: everything below is in em
        // of the object's font size.
        width: "100%",
        height: "100%",
        boxSizing: "border-box",
        padding: "0.85em 0.96em",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        textAlign: "left",
        lineHeight: 1.3,
      }}
    >
      <div
        className="text-accent"
        style={{ fontSize: "0.65em", fontWeight: 600, letterSpacing: "0.14em", textTransform: "uppercase", lineHeight: 1.2 }}
      >
        Messages
      </div>
      {groups === null ? (
        // No screen and no list of its own. On the console itself there is
        // nothing to say; in the editor, say what to do.
        editing ? <Quiet>Choose groups for this widget</Quiet> : null
      ) : !known || !state ? (
        // Not answered yet, or the read failed: neither is "no messages".
        null
      ) : shown && shown.length > 0 ? (
        <div style={{ display: "grid", gap: "0.5em", marginTop: "0.54em", minHeight: 0 }}>
          {shown.map((m, i) => (
            <Message key={m.id} m={m} now={now} newest={i === 0} />
          ))}
        </div>
      ) : (
        <Quiet>No messages for this screen&apos;s groups</Quiet>
      )}
    </div>
  );
}

function Quiet({ children }: { children: string }) {
  return <div className="text-fg-faint" style={{ marginTop: "0.54em", fontSize: "0.81em" }}>{children}</div>;
}

function Message({ m, now, newest }: { m: StageMessage; now: number; newest: boolean }) {
  // Older ones are smaller and muted, and every figure inside is written against
  // the base so they keep the mockup's proportions at either size.
  const f = newest ? 1 : 0.81;
  const em = (x: number) => `${x / f}em`;
  const reply = m.replies.at(-1);
  return (
    <div style={{ fontSize: `${f}em`, opacity: newest ? 1 : 0.6, overflowWrap: "anywhere" }}>
      <small style={{ display: "block", fontSize: em(0.58), opacity: 0.45, marginBottom: em(0.08) }}>
        {m.from} &middot; {ageLabel(now, m.at)}
      </small>
      {m.text}
      {reply && (
        <span className="text-live-11" style={{ display: "block", fontSize: em(0.62), marginTop: em(0.12) }}>
          {reply.from}: {reply.text}
        </span>
      )}
    </div>
  );
}
