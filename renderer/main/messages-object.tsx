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
// ANSWERING. Where controls are live (a panel, a console in the app) the newest
// message shown gets the quick replies as buttons, under "Answering: <text>". A
// wall display draws none. The server decides whether the press is allowed — from
// the widget's stored groups and the output's, not from anything sent here — so
// the buttons are only ever offered for a message this widget follows, and a
// refusal is told to the operator rather than swallowed.
//
// AGE is counted against the SERVER's clock (`now`), the one every widget draws
// from: a wall Pi's own is as wrong as the last time anyone set it.

import { useState, type CSSProperties } from "react";

import { messageReaches, widgetGroups, type MessageGroup, type MessagesState, type StageMessage } from "@main/types/messages";
import { invoke } from "../lib/api";
import { ageLabel } from "../lib/age-label";
import { reportActionFailure } from "./report-action-failure";
import type { OwnScreen } from "./stage-screen";

/** How many messages the widget draws. */
export const MESSAGES_SHOWN = 3;

/** The newest messages that reached these groups, newest first. */
export function shownMessages(state: MessagesState, groups: readonly string[]): StageMessage[] {
  return state.messages.filter((m) => messageReaches(m.to, groups)).slice(-MESSAGES_SHOWN).reverse();
}

/** The group names a widget follows, in the config's order, for the line that
 *  says what a console can answer. Deleted groups drop out. */
export function groupNames(all: readonly MessageGroup[], ids: readonly string[]): string[] {
  const mine = new Set(ids);
  return all.filter((g) => mine.has(g.id)).map((g) => g.name);
}

export interface MessagesObjectProps {
  /** This widget's own id: the server finds it in the stored layouts to decide who it answers for. */
  objectId: string;
  config: { groups?: string[] | null };
  /** The channel's value, and whether it has answered — see useMessagesStatus. */
  state: MessagesState | null;
  known: boolean;
  /** The screen this is drawn on (its id, and the groups it is in); null when it is not on one. */
  screen: OwnScreen | null;
  /** Controls are live here: a panel or a console in the app, never a wall. */
  interactive: boolean;
  /** The layout editor's own canvas. */
  editing: boolean;
  /** The server's clock, ms. */
  now: number;
  ts: CSSProperties;
}

/** The eyebrow, the feed and the quiet states share one card body. */
export function MessagesObject({ objectId, config, state, known, screen, interactive, editing, now, ts }: MessagesObjectProps) {
  const groups = widgetGroups(config.groups, screen?.groups ?? null);
  const shown = groups && state ? shownMessages(state, groups) : null;
  // One answer at a time: pressing a second button while the first is in flight
  // would send two replies for one tap on a touch panel that registered twice.
  const [sending, setSending] = useState(false);
  // The buttons: only where controls are live, once the channel has answered, and for a widget that follows something.
  const answering = interactive && groups !== null && known ? state : null;

  async function answer(target: StageMessage, text: string) {
    if (sending) return;
    setSending(true);
    try {
      await invoke("messages:reply", { id: target.id, text, objectId, outputId: screen?.outputId ?? null });
    } catch (e) {
      // Told, and logged: a reply that did not go must not read as sent. The
      // thread shows replies only once the server has them, so a failure leaves
      // nothing on screen to mistake for success.
      reportActionFailure("send that reply", e, `to ${target.id}`);
    } finally {
      setSending(false);
    }
  }

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
      <Feed groups={groups} state={state} known={known} shown={shown} editing={editing} now={now} />
      {answering && (
        <Replies
          target={shown?.[0] ?? null}
          replies={answering.quickReplies}
          names={groupNames(answering.groups, groups ?? [])}
          sending={sending}
          onAnswer={answer}
        />
      )}
    </div>
  );
}

/** What goes under the heading: the messages, or the one quiet line that says why not. */
function Feed({
  groups,
  state,
  known,
  shown,
  editing,
  now,
}: {
  groups: readonly string[] | null;
  state: MessagesState | null;
  known: boolean;
  shown: StageMessage[] | null;
  editing: boolean;
  now: number;
}) {
  // No screen and no list of its own. On the console itself there is nothing to
  // say; in the editor, say what to do.
  if (groups === null) return editing ? <Quiet>Choose groups for this widget</Quiet> : null;
  // Not answered yet, or the read failed: neither is "no messages".
  if (!known || !state || !shown) return null;
  if (shown.length === 0) return <Quiet>No messages for this screen&apos;s groups</Quiet>;
  return (
    <div style={{ display: "grid", gap: "0.5em", marginTop: "0.54em", minHeight: 0 }}>
      {shown.map((m, i) => (
        <Message key={m.id} m={m} now={now} newest={i === 0} />
      ))}
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
    <div style={{ fontSize: `${f}em`, overflowWrap: "anywhere" }}>
      {/* The sender line is as faint on an older message as on the newest, and the
          reply keeps its green: only the words of an older message are muted. */}
      <small style={{ display: "block", fontSize: em(0.58), opacity: 0.33, marginBottom: em(0.08) }}>
        {m.from} &middot; {ageLabel(now, m.at)}
      </small>
      <span style={{ opacity: newest ? 1 : 0.6 }}>{m.text}</span>
      {reply && (
        <span className="text-live-11" style={{ display: "block", fontSize: em(0.62), marginTop: em(0.12) }}>
          {reply.from}: {reply.text}
        </span>
      )}
    </div>
  );
}

/**
 * The quick replies under the newest message, or what this console can answer
 * when there is nothing to answer. The mockup draws the buttons as raised pills
 * and the line above them faint.
 */
function Replies({
  target,
  replies,
  names,
  sending,
  onAnswer,
}: {
  target: StageMessage | null;
  replies: readonly string[];
  names: readonly string[];
  sending: boolean;
  onAnswer: (target: StageMessage, text: string) => void;
}) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "0.46em", marginTop: "auto", paddingTop: "0.46em" }}>
      <div className="text-fg-faint" style={{ width: "100%", fontSize: "0.58em" }}>
        {target
          ? `Answering: ${target.text}`
          : `Nothing to answer. This console can reply only to messages sent to ${names.length > 0 ? names.join(" or ") : "Everyone"}.`}
      </div>
      {target && replies.length === 0 && (
        <div className="text-fg-faint" style={{ width: "100%", fontSize: "0.58em" }}>
          No quick replies are set up. Add some in Settings, Messages.
        </div>
      )}
      {target &&
        replies.map((r) => (
          <button
            key={r}
            type="button"
            disabled={sending}
            onClick={() => onAnswer(target, r)}
            style={{
              font: "inherit",
              fontSize: "0.81em",
              fontWeight: 600,
              color: "inherit",
              background: "rgba(255,255,255,0.08)",
              border: "1px solid rgba(255,255,255,0.09)",
              borderRadius: "0.38em",
              padding: "0.38em 0.77em",
              cursor: sending ? "default" : "pointer",
              opacity: sending ? 0.6 : 1,
              touchAction: "manipulation",
            }}
          >
            {r}
          </button>
        ))}
    </div>
  );
}
