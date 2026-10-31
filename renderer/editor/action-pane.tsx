// action-pane.tsx — the App action choice of a Button: the action list as the rule
// editor groups it, then the action's own fields.
//
// A pick writes at once. A typed field is rewritten once it has stopped changing,
// and at once when the pane goes away under it: a typed value must not be lost to a
// click elsewhere. A command with a field still blank would be refused by the
// server, and a Button bound to a command that refuses is worse than one bound to
// nothing, so nothing is written until every required field is filled in.

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { validateParams } from "@main/services/automation-param-validation";

import { ErrorNote } from "../components/ui";
import { automationRegistryQuery } from "../lib/automation-registry";
import { cn } from "../lib/cn";
import { useOptionSources } from "../settings/sections/automation-option-sources";
import { ActionParamsFields, seededParams } from "../settings/sections/rule-editor-dialog";
import { pickerEntries, pickerHeadings } from "../settings/sections/automation-picker";
import { COMPANION_PRESS, type PressTarget } from "./owned-press";

/** How long a typed field waits before its command is rewritten, so one edit is one
 *  write. An object so a test can set it to 0 rather than wait. */
export const timing = { fieldWriteMs: 500 };

/** The action list as the rule editor groups it, then the action's own fields. */
export function ActionPane({
  saved,
  onWrite,
}: {
  /** What this Button's own command does now, when it presses an app action. */
  saved: { actionId: string; params: Record<string, string | number> } | null;
  onWrite: (target: PressTarget) => Promise<void>;
}) {
  const { data: registry, isError } = useQuery(automationRegistryQuery);
  const optionSources = useOptionSources();
  const actions = registry?.actions ?? null;
  // What is being edited: the saved rule's action until the operator touches one.
  const [draft, setDraft] = useState<{ actionId: string; params: Record<string, string | number> } | null>(null);
  const shown = draft ?? saved;
  const action = actions?.find((a) => a.id === shown?.actionId) ?? null;
  const params = shown?.params ?? {};
  const issues = action ? validateParams(action.params, params) : [];
  const entries = useMemo(
    // Press a Companion button is the Companion choice, not an app action.
    () => pickerEntries("action", (actions ?? []).filter((a) => a.id !== COMPANION_PRESS)),
    [actions],
  );
  const headings = useMemo(() => pickerHeadings(entries), [entries]);

  // A field is rewritten once it has stopped changing, and at once when the
  // inspector closes under it: a typed value must not be lost to a click elsewhere.
  const pending = useRef<{ timer: ReturnType<typeof setTimeout>; send: () => void } | null>(null);
  useEffect(
    () => () => {
      if (!pending.current) return;
      clearTimeout(pending.current.timer);
      pending.current.send();
    },
    [],
  );

  function change(next: { actionId: string; params: Record<string, string | number> }, delayMs: number) {
    setDraft(next);
    if (pending.current) clearTimeout(pending.current.timer);
    pending.current = null;
    const spec = actions?.find((a) => a.id === next.actionId);
    // A command with a field still blank would be refused by the server, and a
    // Button bound to a command that refuses is worse than one bound to nothing.
    if (!spec || validateParams(spec.params, next.params).length > 0) return;
    const send = () => {
      pending.current = null;
      void onWrite({ name: spec.label, action: { id: next.actionId, params: next.params } });
    };
    if (delayMs <= 0) send();
    else pending.current = { timer: setTimeout(send, delayMs), send };
  }

  if (isError) return <ErrorNote>Could not load the app&rsquo;s actions.</ErrorNote>;
  const unknown = shown && shown.actionId && actions && !action;

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div role="listbox" aria-label="App actions" className="flex max-h-64 flex-col overflow-y-auto rounded-md border border-line">
        {!actions && <p className="px-2.5 py-1.5 text-caption1 text-fg-muted">Loading actions…</p>}
        {unknown && (
          // A saved id the registry no longer has stays visible and marked, so the Button stays editable.
          <ActionOption label={`${shown.actionId} (not found)`} selected onPick={() => undefined} />
        )}
        {headings.map((h) => (
          <div key={h.name} role="group" aria-label={h.name}>
            <div className="px-2.5 pb-1 pt-2 text-caption2 font-semibold uppercase tracking-wider text-fg-subtle">{h.name}</div>
            {entries
              .filter((e) => e.group === h.name)
              .map((e) => (
                <ActionOption
                  key={e.id}
                  label={e.label}
                  selected={e.id === shown?.actionId}
                  onPick={() => {
                    if (e.id === shown?.actionId) return;
                    const spec = actions?.find((a) => a.id === e.id);
                    change({ actionId: e.id, params: seededParams("action", e.id, spec?.params ?? []) }, 0);
                  }}
                />
              ))}
          </div>
        ))}
      </div>
      {action?.help && <p className="text-caption2 leading-snug text-fg-muted">{action.help}</p>}
      {shown && (
        <ActionParamsFields
          actionId={shown.actionId}
          action={action}
          params={params}
          optionSources={optionSources}
          onChange={(next) => change({ actionId: shown.actionId, params: next }, timing.fieldWriteMs)}
          issues={Object.fromEntries(issues.map((i) => [i.key, i.message]))}
          attempted
        />
      )}
      {issues.length > 0 && (
        <p className="text-caption2 leading-snug text-fg-muted">
          Fill in what needs setup and the Button saves its command. Until then it keeps what it pressed before.
        </p>
      )}
    </div>
  );
}

function ActionOption({ label, selected, onPick }: { label: string; selected: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onPick}
      className={cn(
        "flex w-full items-center justify-between gap-2 border-b border-line px-2.5 py-1.5 text-left text-footnote text-fg last:border-b-0",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
        selected ? "bg-accent/12" : "hover:bg-fill",
      )}
    >
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
}
