// The two editable objects: a free-text note and a checklist.
//
// Their content is NOT in the layout. A layout is a design that many screens can
// share; the text an operator types is theirs, changes weekly, and belongs in a
// store of its own — keyed by object id, so it survives the view being renamed
// or rearranged, and a duplicated view starts empty rather than silently sharing
// text with the original.
//
// `editable` is a capability, so these are read-only on a wall display exactly
// as controls are inert there. A note still SHOWS on a wall — that is the point
// of a note — it just cannot be typed into by a passer-by.

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { invoke } from "../lib/api";
import { errorMessage } from "@main/services/errors";
import { toast } from "../components/ui";
import { usePlanChecklist } from "./use-plan-checklist";

interface NotesContent {
  text?: string;
  items?: { id: string; text: string; done: boolean }[];
}

/** Debounce so a save is a sentence, not a keystroke. Long enough to batch
 *  typing, short enough that walking away from the panel does not lose it. */
const SAVE_DEBOUNCE_MS = 600;

function useSavedContent(objectId: string, all: Record<string, NotesContent> | undefined) {
  const server = all?.[objectId];
  const [local, setLocal] = useState<NotesContent | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef(false);

  // Follow the server unless this operator is mid-edit, or a save FAILED —
  // otherwise a broadcast triggered by their own save would yank the cursor
  // back, and a failed save would silently replace what they wrote with the
  // older server copy.
  useEffect(() => {
    if (!pending.current && !saveError) setLocal(null);
  }, [server, saveError]);

  function save(next: NotesContent) {
    setLocal(next);
    pending.current = true;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      // The catch REPORTS rather than swallowing. api.ts throws and does not
      // toast, so an empty catch here would lose the operator's typing in
      // silence — "it looked saved until the next restart" is precisely the
      // failure this repository has a rule against.
      //
      // setSaveError also stops the local copy being dropped on the next server
      // broadcast, so what they typed stays on screen instead of reverting
      // under them while an error toast explains why.
      void invoke("notes:set", { objectId, content: next })
        .then(() => { setSaveError(null); })
        .catch((e: unknown) => {
          setSaveError(errorMessage(e));
          toast.error(`Could not save that note: ${errorMessage(e)}`);
        })
        .finally(() => { pending.current = false; });
    }, SAVE_DEBOUNCE_MS);
  }

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  return [local ?? server ?? {}, save] as const;
}

export function NotesObject({
  objectId,
  config,
  editable,
  all,
  ts,
}: {
  objectId: string;
  config: { placeholder?: string };
  editable: boolean;
  all: Record<string, NotesContent> | undefined;
  ts: CSSProperties;
}) {
  const [content, save] = useSavedContent(objectId, all);

  if (!editable) {
    return (
      <div style={{ ...ts, width: "100%", height: "100%", overflow: "hidden", whiteSpace: "pre-wrap" }}>
        {content.text || ""}
      </div>
    );
  }
  return (
    <textarea
      value={content.text ?? ""}
      onChange={(e) => save({ ...content, text: e.target.value })}
      placeholder={config.placeholder ?? "Notes"}
      aria-label={config.placeholder ?? "Notes"}
      style={{
        ...ts,
        width: "100%",
        height: "100%",
        resize: "none",
        border: "none",
        outline: "none",
        background: "transparent",
        color: "inherit",
        fontFamily: "inherit",
        padding: 0,
      }}
    />
  );
}

/** One row as the checklist draws it, whichever source it came from. */
export interface ChecklistRow {
  id: string;
  text: string;
  done: boolean;
}

/**
 * Which list the object shows.
 *
 * The plan's notes, unless this object has items of its own — a path nothing in
 * the app can create, kept because the store is config-classified and this app
 * does not delete an operator's data to tidy something up.
 *
 * Pulled out of the component so the CHOICE can be tested without a DOM. The
 * component was shipped once with no source at all and rendered "No items yet"
 * for its whole life; that is a decision, and a decision is worth a test.
 */
export function checklistRows(
  own: readonly ChecklistRow[],
  planRows: readonly { key: string; text: string; done: boolean }[],
): ChecklistRow[] {
  if (own.length > 0) return [...own];
  return planRows.map((r) => ({ id: r.key, text: r.text, done: r.done }));
}

/**
 * A checklist on a custom layout.
 *
 * Its rows come from the PLAN's notes in Planning Center — the same source, and
 * the same hook, as the readiness card on Home. Ticking here shows there and the
 * other way round, because there is one list and one store behind both.
 *
 * Before this, the object had no source at all: it rendered `content.items` and
 * NOTHING in the app ever created one, so it read "No items yet" forever. The
 * only write was the toggle below. Rather than build a second place to author a
 * checklist, it now draws the one an operator already keeps in PCO.
 *
 * An object that somehow HAS its own items still renders them. That path is
 * unreachable through the UI, but the store is config-classified and this app
 * does not delete an operator's data to tidy something up — if bytes exist, they
 * are shown.
 */
export function ChecklistObject({
  objectId,
  config,
  editable,
  all,
  ts,
}: {
  objectId: string;
  config: { title?: string };
  editable: boolean;
  all: Record<string, NotesContent> | undefined;
  ts: CSSProperties;
}) {
  const [content, save] = useSavedContent(objectId, all);
  const own = content.items ?? [];
  const plan = usePlanChecklist();

  const fromPlan = own.length === 0;
  const rows = checklistRows(own, plan.rows);

  function toggle(id: string) {
    if (fromPlan) { void plan.toggle(id, !rows.find((r) => r.id === id)?.done); return; }
    save({ ...content, items: own.map((i) => (i.id === id ? { ...i, done: !i.done } : i)) });
  }

  return (
    <div style={{ ...ts, width: "100%", height: "100%", overflow: "auto" }}>
      {config.title && <div style={{ fontWeight: 600, marginBottom: "0.35em" }}>{config.title}</div>}
      {rows.length === 0 && (
        <div style={{ opacity: 0.5 }}>
          {/* Says which thing is missing. "Empty" for a wall display, because a
              passer-by cannot act on it and a settings instruction on a screen
              in the auditorium is noise. */}
          {editable ? "No plan notes chosen — Settings, Plan" : "Empty"}
        </div>
      )}
      {rows.map((i) => (
        <label
          key={i.id}
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: "0.5em",
            marginBottom: "0.2em",
            cursor: editable ? "pointer" : "default",
            opacity: i.done ? 0.55 : 1,
          }}
        >
          <input
            type="checkbox"
            checked={i.done}
            disabled={!editable}
            onChange={() => toggle(i.id)}
            style={{ marginTop: "0.25em" }}
          />
          <span style={{ textDecoration: i.done ? "line-through" : "none" }}>{i.text}</span>
        </label>
      ))}
    </div>
  );
}
