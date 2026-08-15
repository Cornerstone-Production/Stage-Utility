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
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef(false);

  // Follow the server unless this operator is mid-edit — otherwise a broadcast
  // triggered by their own save would yank the cursor back.
  useEffect(() => {
    if (!pending.current) setLocal(null);
  }, [server]);

  function save(next: NotesContent) {
    setLocal(next);
    pending.current = true;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      // The failure is reported by the caller's toast layer; swallowing it here
      // would make "it looked saved" the default.
      void invoke("notes:set", { objectId, content: next })
        .catch(() => { /* surfaced by api's error toast */ })
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
  const items = content.items ?? [];

  function toggle(id: string) {
    save({ ...content, items: items.map((i) => (i.id === id ? { ...i, done: !i.done } : i)) });
  }

  return (
    <div style={{ ...ts, width: "100%", height: "100%", overflow: "auto" }}>
      {config.title && <div style={{ fontWeight: 600, marginBottom: "0.35em" }}>{config.title}</div>}
      {items.length === 0 && (
        <div style={{ opacity: 0.5 }}>{editable ? "No items yet" : "Empty"}</div>
      )}
      {items.map((i) => (
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
