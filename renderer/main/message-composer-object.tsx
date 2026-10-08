// message-composer-object.tsx — the Message composer widget: pick who a message
// goes to, type it or press a quick one, send it (as an alert, if it should take
// the screen over), and read the day's thread with every reply under its message.
//
// DRAWN AS THE APPROVED MOCKUP DRAWS IT, piece for piece and in its order: To
// chips (Everyone and each group), Quick messages in two columns, the text box,
// the Alert switch beside Send (which turns red and says Send alert), the hint
// line saying how many screens it reaches, then Today: the thread newest first.
// Every size is a multiple of the object's font size, the mockup's divided by its
// 14.5px, so it scales with whatever the operator sets.
//
// ONE DECISION THE MOCKUP LEAVES OPEN: Clear alert. The mockup lists it as
// planned and not drawn; the plan puts it on any message whose alert is still
// running, so it is a small red button in that message's header line.
//
// TARGETS. Everyone is exclusive of the groups, several groups may be picked, and
// the choice is kept after a send (a producer sending three things to the Green
// room should not have to pick it three times). Nothing is picked to begin with:
// the first message of the day should be a decision.
//
// A FAILED SEND keeps the text, the targets and the Alert switch where they were,
// says why, and writes it to /log. A send that did not go must not read as sent.
//
// Controls are live only where the surface says so (`interactive`): on a wall
// display, or in the layout editor's own canvas, it draws and does nothing.

import { useState, type CSSProperties } from "react";

import { errorMessage } from "@main/services/errors";
import {
  ALERT_MS,
  DEFAULT_FROM,
  EVERYONE,
  FROM_MAX,
  MESSAGE_MAX,
  isAlertRunning,
  type MessageGroup,
  type MessagesState,
  type StageMessage,
} from "@main/types/messages";
import { toast } from "../components/ui";
import { cn } from "../lib/cn";
import { invoke } from "../lib/api";
import { logToServer } from "../lib/client-log";
import { ageLabel } from "./messages-object";

/**
 * Who a message from this composer says it is from: the output's name on a
 * screen, the console view's name on an in-app console, "Home" on Home. The
 * sender is a name, not an account (the app has none). Falls back to the server's
 * own default when nothing names it, so a send is never refused for a missing one.
 */
export function senderName(where: {
  home: boolean;
  outputId: string | null;
  /** The views being drawn, outermost first: the console's own view is the first. */
  embedChain: readonly string[];
  outputs: readonly { id: string; name: string }[];
  views: readonly { id: string; name: string }[];
}): string {
  const named = where.home
    ? "Home"
    : where.outputId !== null
      ? where.outputs.find((o) => o.id === where.outputId)?.name
      : where.views.find((v) => v.id === where.embedChain[0])?.name;
  return (named ?? "").trim().slice(0, FROM_MAX) || DEFAULT_FROM;
}

/**
 * The targets after pressing one chip. Everyone stands alone: pressing it picks
 * only it (or clears it), and pressing a group while it is picked swaps it for
 * that group. Groups toggle, so several can be picked.
 */
export function toggleTarget(current: readonly string[], id: string): string[] {
  if (id === EVERYONE) return current.includes(EVERYONE) ? [] : [EVERYONE];
  const groups = current.filter((t) => t !== EVERYONE);
  return groups.includes(id) ? groups.filter((t) => t !== id) : [...groups, id];
}

/** "Green room", "Green room and Stage", "Green room, Stage and Booth". */
function listOf(names: readonly string[]): string {
  return names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The line under Send: what pressing it will do. "Reaches 2 screens in Green
 * room." / "Takes over every screen for 30 seconds." Counts the screens (outputs)
 * in any chosen group; an in-app console is not a screen and is not counted.
 */
export function reachLine(
  to: readonly string[],
  alert: boolean,
  groups: readonly MessageGroup[],
  outputs: readonly { groups?: string[] }[],
): string {
  const verb = alert ? "Takes over" : "Reaches";
  const tail = alert ? ` for ${ALERT_MS / 1000} seconds.` : ".";
  if (to.length === 0) return "Pick who this goes to.";
  if (to.includes(EVERYONE)) return `${verb} every screen${tail}`;
  const chosen = new Set(to);
  const n = outputs.filter((o) => (o.groups ?? []).some((g) => chosen.has(g))).length;
  const names = listOf(groups.filter((g) => chosen.has(g.id)).map((g) => g.name));
  if (n === 0) return `No screens are in ${names} yet.`;
  return `${verb} ${n} screen${n === 1 ? "" : "s"} in ${names}${tail}`;
}

/** Where a message went, for its header: group names, or Everyone, in the config's order. */
function destination(m: StageMessage, groups: readonly MessageGroup[]): string {
  if (m.to.includes(EVERYONE)) return "Everyone";
  const names = new Map(groups.map((g) => [g.id, g.name]));
  return m.to.map((id) => names.get(id) ?? "(deleted group)").join(", ");
}

export interface MessageComposerProps {
  state: MessagesState | null;
  known: boolean;
  /** The screens, for the hint line's count of what a send reaches. */
  outputs: readonly { groups?: string[] }[];
  /** Who it signs as — see senderName. */
  from: string;
  /** Controls are live here. */
  interactive: boolean;
  /** The server's clock, ms. */
  now: number;
  ts: CSSProperties;
}

export function MessageComposerObject({ state, known, outputs, from, interactive, now, ts }: MessageComposerProps) {
  const [to, setTo] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [alert, setAlert] = useState(false);
  const [sending, setSending] = useState(false);
  const [clearing, setClearing] = useState<string | null>(null);

  const body = text.trim();
  // Nothing can be picked or typed where controls are not live (every handler below
  // checks), so there is nothing to send there and no separate test is needed here.
  const canSend = !sending && to.length > 0 && body.length > 0;

  async function send() {
    if (!canSend) return;
    setSending(true);
    try {
      await invoke("messages:send", { to, text: body, alert, from });
      // Cleared only once the server has it. The targets stay: see the header.
      setText("");
      setAlert(false);
    } catch (e) {
      toast.error(`Could not send that message: ${errorMessage(e)}`);
      logToServer("messages", `could not send a message to ${to.join(", ")}: ${errorMessage(e)}`);
    } finally {
      setSending(false);
    }
  }

  async function clearAlert(m: StageMessage) {
    if (!interactive || clearing) return;
    setClearing(m.id);
    try {
      await invoke("messages:clearAlert", { id: m.id, from });
    } catch (e) {
      toast.error(`Could not clear that alert: ${errorMessage(e)}`);
      logToServer("messages", `could not clear alert ${m.id}: ${errorMessage(e)}`);
    } finally {
      setClearing(null);
    }
  }

  return (
    <div
      style={{
        ...ts,
        width: "100%",
        height: "100%",
        boxSizing: "border-box",
        padding: "0.85em 1.1em",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        textAlign: "left",
        lineHeight: 1.5,
        fontWeight: 400,
        // A wall draws this and cannot press it; so does the editor's canvas.
        pointerEvents: interactive ? undefined : "none",
      }}
    >
      {!state ? (
        <div className="text-fg-faint" style={{ fontSize: "0.9em" }}>
          {known ? "Could not read the messages." : "Reading the messages..."}
        </div>
      ) : (
        <>
          <div style={{ display: "grid", gap: "0.83em", flex: "none" }}>
            <Field cap="To">
              <div role="group" aria-label="Send to" style={{ display: "flex", flexWrap: "wrap", gap: "0.41em" }}>
                {[{ id: EVERYONE, name: "Everyone" }, ...state.groups].map((g) => {
                  const on = to.includes(g.id);
                  return (
                    <button
                      key={g.id}
                      type="button"
                      aria-pressed={on}
                      onClick={() => interactive && setTo((cur) => toggleTarget(cur, g.id))}
                      className={cn(
                        "rounded-full border hover:text-fg",
                        on ? "border-accent/45 bg-accent/15 text-accent" : "border-line-strong bg-surface text-fg-muted",
                      )}
                      style={{ font: "inherit", fontSize: "0.9em", padding: "0.28em 0.76em", cursor: "pointer" }}
                    >
                      {g.name}
                    </button>
                  );
                })}
              </div>
            </Field>

            {state.quickMessages.length > 0 && (
              <Field cap="Quick messages">
                <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "0.41em" }}>
                  {state.quickMessages.map((q, i) => (
                    <button
                      // The list may hold the same words twice; the index is what tells them apart.
                      key={`${i}:${q}`}
                      type="button"
                      onClick={() => interactive && setText(q)}
                      className="border border-line-strong bg-surface text-fg hover:bg-surface-raised"
                      style={{
                        font: "inherit",
                        fontSize: "0.9em",
                        textAlign: "left",
                        borderRadius: "0.48em",
                        padding: "0.48em 0.69em",
                        cursor: "pointer",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </Field>
            )}

            <textarea
              value={text}
              onChange={(e) => interactive && setText(e.target.value)}
              readOnly={!interactive}
              maxLength={MESSAGE_MAX}
              aria-label="Message"
              placeholder="Type a message, or press a quick one"
              className="border border-line-strong bg-surface text-fg placeholder:text-fg-subtle"
              style={{
                font: "inherit",
                width: "100%",
                boxSizing: "border-box",
                minHeight: "4.1em",
                resize: "vertical",
                borderRadius: "0.48em",
                padding: "0.55em 0.69em",
              }}
            />

            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.69em", flexWrap: "wrap" }}>
              <button
                type="button"
                role="switch"
                aria-checked={alert}
                onClick={() => interactive && setAlert((v) => !v)}
                className={alert ? "text-danger-11" : "text-fg-muted"}
                style={{ font: "inherit", fontSize: "0.9em", display: "inline-flex", alignItems: "center", gap: "0.55em", background: "none", border: 0, padding: 0, cursor: "pointer" }}
              >
                <span
                  className={alert ? "bg-danger-9" : "bg-line-strong"}
                  style={{ position: "relative", width: "2.07em", height: "1.24em", borderRadius: 999, flex: "none", transition: "background 160ms" }}
                >
                  <span
                    className="bg-fg"
                    style={{
                      position: "absolute",
                      top: "0.14em",
                      left: "0.14em",
                      width: "0.97em",
                      height: "0.97em",
                      borderRadius: "50%",
                      transform: alert ? "translateX(0.83em)" : undefined,
                      transition: "transform 160ms cubic-bezier(0.2,0.6,0.2,1)",
                    }}
                  />
                </span>
                Alert: takes over the screen
              </button>
              <button
                type="button"
                disabled={!canSend}
                onClick={() => void send()}
                className={alert ? "bg-danger-9" : undefined}
                style={{
                  font: "inherit",
                  fontSize: "0.93em",
                  fontWeight: 600,
                  color: "#fff",
                  // The brand blue, or the one the operator picked in Branding.
                  background: alert ? undefined : "var(--brand-accent-set, #2e6691)",
                  border: 0,
                  borderRadius: "0.48em",
                  padding: "0.48em 1.1em",
                  cursor: canSend ? "pointer" : "default",
                  opacity: canSend || !interactive ? 1 : 0.5,
                }}
              >
                {alert ? "Send alert" : "Send"}
              </button>
            </div>

            <div className="text-fg-subtle" style={{ fontSize: "0.86em" }}>
              {reachLine(to, alert, state.groups, outputs)}
            </div>
          </div>

          <div
            className="border-t border-line"
            style={{ marginTop: "0.9em", paddingTop: "0.69em", flex: "1 1 auto", minHeight: 0, overflowY: "auto", display: "grid", gap: "0.55em", alignContent: "start" }}
          >
            <Cap>Today</Cap>
            {state.messages.length === 0 ? (
              <div className="text-fg-faint" style={{ fontSize: "0.9em" }}>Nothing sent today.</div>
            ) : (
              [...state.messages].reverse().map((m) => (
                <Thread
                  key={m.id}
                  m={m}
                  groups={state.groups}
                  now={now}
                  canClear={interactive && isAlertRunning(m, now)}
                  clearing={clearing === m.id}
                  onClear={() => void clearAlert(m)}
                />
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Cap({ children }: { children: string }) {
  return (
    <span className="text-fg-subtle" style={{ fontSize: "0.76em", fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase", lineHeight: 1.2 }}>
      {children}
    </span>
  );
}

function Field({ cap, children }: { cap: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gap: "0.41em" }}>
      <Cap>{cap}</Cap>
      {children}
    </div>
  );
}

/** One message in the thread, and every reply under it. */
function Thread({
  m,
  groups,
  now,
  canClear,
  clearing,
  onClear,
}: {
  m: StageMessage;
  groups: readonly MessageGroup[];
  now: number;
  canClear: boolean;
  clearing: boolean;
  onClear: () => void;
}) {
  return (
    <>
      <div
        className={cn("border", m.alert ? "border-danger-9/40 bg-danger-9/15" : "border-line bg-surface-raised")}
        style={{ display: "grid", gap: "0.14em", padding: "0.55em 0.69em", borderRadius: "0.55em" }}
      >
        <div className="text-fg-subtle" style={{ display: "flex", justifyContent: "space-between", gap: "0.55em", fontSize: "0.83em" }}>
          <span>
            <b className="text-fg-muted" style={{ fontWeight: 600 }}>{m.from}</b> &rarr;{" "}
            <span className="text-accent">{destination(m, groups)}</span>
            {m.alert ? " · alert" : ""}
          </span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: "0.55em", flex: "none" }}>
            {canClear && (
              <button
                type="button"
                disabled={clearing}
                onClick={onClear}
                className="border border-danger-9/50 text-danger-11 hover:bg-danger-9/15"
                style={{ font: "inherit", borderRadius: "0.41em", padding: "0 0.55em", cursor: "pointer", opacity: clearing ? 0.6 : 1 }}
              >
                Clear alert
              </button>
            )}
            {ageLabel(now, m.at)}
          </span>
        </div>
        <div className="text-fg" style={{ fontSize: "0.97em", overflowWrap: "anywhere" }}>{m.text}</div>
      </div>
      {m.replies.map((r) => (
        <div
          key={r.id}
          className="border-l-2 border-live-9 text-fg"
          style={{ marginLeft: "1.1em", padding: "0.41em 0.69em", fontSize: "0.93em", overflowWrap: "anywhere" }}
        >
          <b className="text-live-11" style={{ fontWeight: 600, fontSize: "0.9em", marginRight: "0.41em" }}>{r.from}</b>
          {r.text}
          <span className="text-fg-subtle" style={{ fontSize: "0.9em", marginLeft: "0.41em" }}>{ageLabel(now, r.at)}</span>
        </div>
      ))}
    </>
  );
}
