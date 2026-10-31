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

import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { calledCueName } from "@main/services/cue-aliases";
import { errorMessage } from "@main/services/errors";
import type { Rule } from "@main/types/automation";
import type { LayoutObjectConfig } from "@main/types/views";

import { ErrorNote, Switch } from "../components/ui";
import { invoke } from "../lib/api";
import { useLatestRef } from "../lib/use-latest-ref";
import type { CuesLive } from "../main/use-cue-live";
import { ActionPane, type PendingWrite } from "./action-pane";
import { CommandPane } from "./command-pane";
import { CompanionPane, type PickedCompanion } from "./companion-pane";
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

const PRESSES: readonly { value: PressKind; label: string }[] = [
  { value: "companion", label: "Companion" },
  { value: "action", label: "App action" },
  { value: "command", label: "A command" },
];

type RulesReply = { rules: Rule[] };

/** The rules, under the key the Automation page reads, so a write here refreshes both. */
const RULES_KEY = ["automation:rules"] as const;
const rulesQuery = { queryKey: RULES_KEY, queryFn: () => invoke<RulesReply>("automation:rules") };

export function ButtonPresses({
  owner,
  where,
  c,
  cues,
  onConfig,
  settleRef,
}: {
  owner: PressOwner;
  /** This view's name, for the Used on chip of a Button that is not saved yet. */
  where: string;
  c: CueButtonConfig;
  /** The command manifest, for the A command list. null until it loads. */
  cues: CuesLive | null;
  onConfig: (c: LayoutObjectConfig) => void;
  /**
   * Filled with a function that resolves once every write this control has started, or is
   * about to start for a typed field, has landed and bound the Button. A host that stores
   * the Button on its own Save (Home's sheet) waits on it first: a Save that raced a pick
   * stored the Button without its command and left the command with no Button.
   */
  settleRef?: MutableRefObject<(() => Promise<void>) | null>;
}) {
  const qc = useQueryClient();
  const rulesQ = useQuery(rulesQuery);
  const rules = useMemo(() => rulesQ.data?.rules ?? [], [rulesQ.data]);
  /** What a write changed: the rules, and where each command is used. */
  const refreshRules = () => {
    void qc.invalidateQueries({ queryKey: RULES_KEY });
    void qc.invalidateQueries({ queryKey: ["cues:usage"] });
  };
  const own = ownedRuleFor(rules, owner, c.cue);
  const kind = pressKindOf(rules, owner, c.cue);
  // The choice shown is the operator's own until a pick makes the Button's rule say
  // which it is; before either it is Companion, the first of the three.
  const [chosen, setChosen] = useState<PressKind | null>(null);
  const mode = chosen ?? kind ?? "companion";

  const latest = useLatestRef(c);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Writes go one after another: two picks in a row must not both mint `btn_x`. The chain
  // never rejects: a job that throws is shown, and the next one still runs.
  const queue = useRef<Promise<void>>(Promise.resolve());
  const inflight = useRef(0);
  // Bumped by anything that binds the Button on its own (picking a command): a write that
  // was started before it must not bind the Button over it when it lands.
  const epoch = useRef(0);
  const pending = useRef<PendingWrite | null>(null);

  function enqueue(job: () => Promise<void>): Promise<void> {
    inflight.current += 1;
    setBusy(true);
    const run = queue.current
      .then(job)
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => {
        inflight.current -= 1;
        if (inflight.current === 0) setBusy(false);
      });
    queue.current = run;
    return run;
  }

  /** Send the typed field that is waiting out its debounce, now. */
  function flushPending() {
    const p = pending.current;
    if (!p) return;
    clearTimeout(p.timer);
    p.send();
  }

  // Re-pointed every render, because flushPending reads refs and the closures above are new each time.
  useEffect(() => {
    if (!settleRef) return;
    settleRef.current = async () => {
      flushPending();
      await queue.current;
    };
  });

  /** Write the Button's own command, then bind the Button to it. */
  function commit(target: PressTarget): Promise<void> {
    const started = epoch.current;
    return enqueue(async () => {
      const made = await writeOwnedRule({ owner, cue: latest.current.cue, label: latest.current.label, target });
      if (!made.ok) {
        // The Button is left exactly as it was, and the reason stays on screen.
        setError(made.error);
        return;
      }
      setError(null);
      refreshRules();
      if (epoch.current === started && latest.current.cue !== made.cue) onConfig({ ...latest.current, cue: made.cue });
    });
  }

  /** List the Button's own command, after any typed field has been written. */
  function list(): Promise<void> {
    flushPending();
    epoch.current += 1;
    return enqueue(async () => {
      const r = await listWithCommands(owner, latest.current.cue);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setError(null);
      refreshRules();
      // The Button presses a plain command now, and the pane says so.
      setChosen("command");
    });
  }

  return (
    <>
      <RowToggle
        label="Presses"
        value={mode}
        options={PRESSES}
        onChange={(next) => {
          // A typed field is written before the pane that holds it goes.
          flushPending();
          setChosen(next);
        }}
      />

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
          pendingRef={pending}
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
          onChange={(cue) => {
            epoch.current += 1;
            onConfig({ ...c, cue });
          }}
        />
      )}

      {rulesQ.isError && <ErrorNote>Could not read the commands: {errorMessage(rulesQ.error)}</ErrorNote>}
      {error && <ErrorNote>{error}</ErrorNote>}

      <HowItIsSaved c={c} own={kind === "companion" || kind === "action" ? own : null} busy={busy} onList={list} />
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

// ── What it saved as ──────────────────────────────────────────────────────────

function HowItIsSaved({
  c,
  own,
  busy,
  onList,
}: {
  c: CueButtonConfig;
  /** The Button's own command, when it presses a Companion button or an app action. */
  own: Rule | null;
  busy: boolean;
  onList: () => Promise<void>;
}) {
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
          disabled={busy}
          onCheckedChange={() => void onList()}
        />
      </label>
      <span className="text-caption2 leading-snug text-fg-subtle">
        It moves to the commands list on the Automation page, where it can get a voice name, a Home Assistant entity and other buttons pointing
        at it.
      </span>
    </div>
  );
}
