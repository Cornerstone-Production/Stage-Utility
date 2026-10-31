// button-presses.tsx — "what does this Button press", as one control.
//
// Shared by the layout inspector and Home's Presses… sheet, so a Button asks the
// same question wherever it is edited. The Presses control has three choices:
//
//   Companion   a Companion button, picked from the live export
//   App action  one of the app's own actions, with its fields
//   A command   an existing command, from the manifest
//
// Companion and App action each write a command that belongs to this Button
// (owned-press.ts) the moment the pick is made, and bind the Button's `cue` to
// it. Every press is therefore a command and obeys Simulate, Disarm and the
// activity log. A command is just a pointer, as it always was.
//
// The Label and Show device rows are the host's: this draws the choice and what
// it saved as, nothing else.

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { validateParams } from "@main/services/automation-param-validation";
import { calledCueName } from "@main/services/cue-aliases";
import { errorMessage } from "@main/services/errors";
import type { Rule } from "@main/types/automation";
import type { LayoutObjectConfig } from "@main/types/views";

import { ErrorNote, Switch } from "../components/ui";
import { automationRegistryQuery } from "../lib/automation-registry";
import { invoke } from "../lib/api";
import { cn } from "../lib/cn";
import { useLatestRef } from "../lib/use-latest-ref";
import type { CuesLive } from "../main/use-cue-live";
import { useOptionSources } from "../settings/sections/automation-option-sources";
import { ActionParamsFields, seededParams } from "../settings/sections/rule-editor-dialog";
import { pickerEntries, pickerHeadings } from "../settings/sections/automation-picker";
import { CompanionPane, type PickedCompanion } from "./companion-pane";
import { CuePicker } from "./cue-picker";
import { RowToggle } from "./inspector-rows";
import {
  COMPANION_PRESS,
  listWithCommands,
  ownedRuleFor,
  pressKindOf,
  writeOwnedRule,
  type PressKind,
  type PressOwner,
  type PressTarget,
} from "./owned-press";

export type CueButtonConfig = Extract<LayoutObjectConfig, { type: "cue-button" }>;

/** Where "+ New manual command…" goes: the Automation page, which opens its creation
 *  flow for `new=manual`. */
export const NEW_MANUAL_COMMAND_HREF = "/automation?new=manual";

/** How long a typed field waits before its command is rewritten, so one edit is one
 *  write. An object so a test can set it to 0 rather than wait. */
export const timing = { fieldWriteMs: 500 };

const PRESSES: readonly { value: PressKind; label: string }[] = [
  { value: "companion", label: "Companion" },
  { value: "action", label: "App action" },
  { value: "command", label: "A command" },
];

type RulesReply = { rules: Rule[] };

/** The rules, under the key the Automation page reads, so a write here refreshes both. */
export const rulesQuery = {
  queryKey: ["automation:rules"],
  queryFn: () => invoke<RulesReply>("automation:rules"),
};

interface UsageUse {
  viewId: string;
  viewName: string;
  objectId: string;
  label: string;
  home: boolean;
}

export function ButtonPresses({
  owner,
  where,
  c,
  cues,
  onConfig,
}: {
  owner: PressOwner;
  /** This view's name, for the Used on chip of a Button that is not saved yet. */
  where: string;
  c: CueButtonConfig;
  /** The command manifest, for the A command list. null until it loads. */
  cues: CuesLive | null;
  onConfig: (c: LayoutObjectConfig) => void;
}) {
  const qc = useQueryClient();
  const rulesQ = useQuery(rulesQuery);
  const rules = useMemo(() => rulesQ.data?.rules ?? [], [rulesQ.data]);
  const own = ownedRuleFor(rules, owner, c.cue);
  const kind = pressKindOf(rules, owner, c.cue);
  // The choice shown is the operator's own until a pick makes the Button's rule say
  // which it is; before either it is Companion, the first of the three.
  const [chosen, setChosen] = useState<PressKind | null>(null);
  const mode = chosen ?? kind ?? "companion";

  const latest = useLatestRef(c);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Writes go one after another: two picks in a row must not both mint `btn_x`.
  const queue = useRef<Promise<void>>(Promise.resolve());

  /** Write the Button's own command, then bind the Button to it. */
  function commit(target: PressTarget): Promise<void> {
    const run = queue.current.then(async () => {
      setBusy(true);
      const made = await writeOwnedRule({ owner, cue: latest.current.cue, label: latest.current.label, target });
      setBusy(false);
      if (!made.ok) {
        // The Button is left exactly as it was, and the reason stays on screen.
        setError(made.error);
        return;
      }
      setError(null);
      void qc.invalidateQueries({ queryKey: ["automation:rules"] });
      void qc.invalidateQueries({ queryKey: ["cues:usage"] });
      if (latest.current.cue !== made.cue) onConfig({ ...latest.current, cue: made.cue });
    });
    queue.current = run;
    return run;
  }

  return (
    <>
      <RowToggle label="Presses" value={mode} options={PRESSES} onChange={setChosen} />

      {mode === "companion" && (
        <CompanionPane
          current={kind === "companion" && own ? pickedCompanion(own) : null}
          disabled={busy}
          onPick={(target) => void commit(target)}
        />
      )}
      {mode === "action" && (
        <ActionPane
          saved={kind === "action" && own ? { actionId: own.action.id, params: own.action.params } : null}
          onWrite={commit}
        />
      )}
      {mode === "command" && (
        <CommandPane
          cues={cues}
          value={kind === "command" ? c.cue : ""}
          hide={ownedCueNames(rules, own)}
          where={where}
          owner={owner}
          onChange={(cue) => onConfig({ ...c, cue })}
        />
      )}

      {rulesQ.isError && <ErrorNote>Could not read the commands: {errorMessage(rulesQ.error)}</ErrorNote>}
      {error && <ErrorNote>{error}</ErrorNote>}

      <HowItIsSaved
        c={c}
        own={kind === "companion" || kind === "action" ? own : null}
        busy={busy}
        onListed={() => {
          setError(null);
          void qc.invalidateQueries({ queryKey: ["automation:rules"] });
          void qc.invalidateQueries({ queryKey: ["cues:usage"] });
          // The Button presses a plain command now, and the pane says so.
          setChosen("command");
        }}
        onError={setError}
      />
    </>
  );
}

/** The Companion button an owned press rule points at, as stored on its action. */
function pickedCompanion(rule: Rule): PickedCompanion | null {
  if (rule.action.id !== COMPANION_PRESS) return null;
  const page = Number(rule.action.params.page);
  const row = Number(rule.action.params.row);
  const col = Number(rule.action.params.col);
  if (![page, row, col].every(Number.isFinite) || page < 1) return null;
  return { page, row, col, label: String(rule.action.params.label ?? "") };
}

/**
 * The commands that belong to some Button, other than this one's own. Another
 * Button's own command is not a thing to point at: it is listed with the others
 * first, which is what List it with the other commands does.
 */
function ownedCueNames(rules: readonly Rule[], own: Rule | null): ReadonlySet<string> {
  const names = new Set<string>();
  for (const r of rules) {
    if (!r.ownedBy || r === own) continue;
    const name = calledCueName(r.trigger);
    if (name) names.add(name);
  }
  return names;
}

// ── App action ────────────────────────────────────────────────────────────────

/** The action list as the rule editor groups it, then the action's own fields. */
function ActionPane({
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
  const unknown = shown && shown.actionId && actions && !action && shown.actionId !== COMPANION_PRESS;

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

// ── A command ─────────────────────────────────────────────────────────────────

function CommandPane({
  cues,
  value,
  hide,
  where,
  owner,
  onChange,
}: {
  cues: CuesLive | null;
  value: string;
  hide: ReadonlySet<string>;
  where: string;
  owner: PressOwner;
  onChange: (cue: string) => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <CuePicker cues={cues} value={value} hide={hide} onChange={onChange} />
      <a
        href={NEW_MANUAL_COMMAND_HREF}
        target="_blank"
        rel="noopener noreferrer"
        className="self-start rounded text-footnote text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        + New manual command…
      </a>
      {value && <UsedOn cue={value} where={where} owner={owner} />}
    </div>
  );
}

/** The chips of every screen a command is used on. */
function UsedOn({ cue, where, owner }: { cue: string; where: string; owner: PressOwner }) {
  const { data, isError } = useQuery({
    queryKey: ["cues:usage"],
    queryFn: () => invoke<Record<string, UsageUse[]>>("cues:usage"),
  });
  if (isError) return <p className="text-caption2 text-fg-subtle">Could not read where it is used.</p>;
  const uses = data ? ((Object.hasOwn(data, cue.trim().toLowerCase()) ? data[cue.trim().toLowerCase()] : null) ?? []) : null;
  if (!uses) return null;
  // A Button that is not saved yet is not in the views: it is on this screen all the same.
  const places = new Map<string, string>(uses.map((u) => [u.viewId, u.home ? "Home" : u.viewName]));
  if (!places.has(owner.viewId)) places.set(owner.viewId, where);
  return (
    <p className="flex flex-wrap items-center gap-1 text-caption1 text-fg-muted">
      <span>Used on</span>
      {[...places].map(([id, name]) => (
        <span key={id} className="rounded bg-fill px-1.5 text-caption2 text-fg">
          {name}
        </span>
      ))}
    </p>
  );
}

// ── What it saved as ──────────────────────────────────────────────────────────

function HowItIsSaved({
  c,
  own,
  busy,
  onListed,
  onError,
}: {
  c: CueButtonConfig;
  /** The Button's own command, when it presses a Companion button or an app action. */
  own: Rule | null;
  busy: boolean;
  onListed: () => void;
  onError: (message: string) => void;
}) {
  const [listing, setListing] = useState(false);
  if (!c.cue.trim()) {
    return (
      <div className="rounded-lg border border-line p-2.5 text-caption1 text-fg-muted">
        Nothing chosen yet. The Button reads Unbound until it is.
      </div>
    );
  }
  if (!own) {
    return (
      <div className="rounded-lg border border-line p-2.5 text-caption1 text-fg-muted">
        <span className="font-medium text-fg">Fires the command </span>
        <span className="font-mono text-fg">{c.cue}</span>
        <span>. Its cooldown, service guard and Home Assistant setting live on the Automation page.</span>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line p-2.5 text-caption1 text-fg-muted">
      <span>
        <span className="font-medium text-fg">Saved as this button&rsquo;s own command </span>
        <span className="font-mono text-fg">{calledCueName(own.trigger)}</span>
        <span>. Simulate, Disarm and the activity log apply.</span>
      </span>
      <label className="flex items-center justify-between gap-2">
        <span>List it with the other commands</span>
        <Switch
          aria-label="List it with the other commands"
          checked={false}
          disabled={busy || listing}
          onCheckedChange={async () => {
            setListing(true);
            const r = await listWithCommands(own);
            setListing(false);
            if (r.ok) onListed();
            else onError(r.error);
          }}
        />
      </label>
      <span className="text-caption2 leading-snug text-fg-subtle">
        It moves to the commands list on the Automation page, where it can get a voice name, a Home Assistant entity and other buttons pointing
        at it.
      </span>
    </div>
  );
}
