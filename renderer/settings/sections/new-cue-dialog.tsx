// The New cue dialog: a stepped flow for making a cue or an automatic rule.
//
// NOTHING IS SAVED UNTIL CREATE: the draft lives in this component and goes with
// it, and Escape, the overlay, the close button and Cancel are all the same
// discard.
//
// The model — the steps, the defaults, what a step needs, the rule Create writes
// — is new-cue-flow.ts. This file draws it and runs the two writes: the rule, and
// then, for a manual cue, a Cue button on each console ticked.
//
// THE RULE IS CREATED FIRST AND IS NEVER ROLLED BACK. A console that refuses its
// button (somebody has its layout open, say) leaves the cue made and the other
// consoles written, and the result is SAID on a panel that stays until it is
// dismissed, naming which console failed — a toast would be gone in four seconds
// and the failure with it.
//
// NOT unit-tested here, and driven in a browser instead: the two-column dialog,
// the stepper's sidebar, the picker panel scrolling inside the body, and the
// kind cards' selected tint. jsdom loads no stylesheet and reports every
// offsetHeight as 0.

import { useEffect, useMemo, useRef, useState } from "react";
import { HandIcon, ZapIcon } from "lucide-react";
import { useQuery } from "@tanstack/react-query";

import { takenCueNames } from "@main/services/cue-aliases";
import { errorMessage } from "@main/services/errors";
import { plural } from "@main/services/plural";
import { fieldsNeedAttention } from "@main/services/automation-param-validation";
import type { Rule } from "@main/types/automation";
import type { View } from "@main/types/views";

import { invoke } from "../../lib/api";
import { logReadFailure, logToServer } from "../../lib/client-log";
import { cn } from "../../lib/cn";
import { joinWithAnd } from "../../lib/join-with-and";
import { QUERY_KEYS } from "../../app/queries";
import { addCueButtonToConsoles, consolesWithLayouts, type ConsoleResult } from "../../lib/console-cue-buttons";
import {
  Button,
  Checkbox,
  DialogContent,
  DialogRoot,
  DialogTitle,
  ErrorNote,
  Input,
  NumberInput,
  Switch,
  toast,
} from "../../components/ui";
import type { OptionSources } from "./automation-option-sources";
import { AutomationPicker, NOT_PICKED_TRIGGERS, PickerField } from "./automation-picker";
import {
  ActionParamsFields,
  ParamField,
  Row,
  seededParams,
  type Registry,
} from "./rule-editor-dialog";
import { OutlineButton, SettingRow } from "./screen-panel-parts";
import {
  buildRule,
  cooldownOf,
  displayName,
  emptyDraft,
  enabledOf,
  labelOf,
  newCueName,
  reachable,
  stepComplete,
  stepIssues,
  stepsFor,
  suggestedName,
  type CueDraft,
  type CueKind,
  type StepId,
} from "./new-cue-flow";

const KIND_NAMES: Record<CueKind, string> = { manual: "Manual cue", auto: "Automatic rule" };

/** What the dialog says after Create when a console was refused. */
interface Outcome {
  ruleName: string;
  cueName: string;
  results: ConsoleResult[];
}

export function NewCueDialog({
  registry,
  optionSources,
  rules,
  initialKind,
  onClose,
  onCreated,
}: {
  registry: Registry;
  optionSources: OptionSources;
  /** Every rule, for the names already taken. */
  rules: readonly Pick<Rule, "trigger">[];
  /** Set when a link already says which kind: the dialog opens past the first step. */
  initialKind: CueKind | null;
  onClose: () => void;
  /** A rule was created: re-read the list. */
  onCreated: () => void;
}) {
  const [draft, setDraft] = useState<CueDraft>(() => emptyDraft(initialKind));
  const [stepIndex, setStepIndex] = useState(initialKind ? 1 : 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const patch = (over: Partial<CueDraft>) => setDraft((d) => ({ ...d, ...over }));

  const steps = stepsFor(draft.kind);
  const step = steps[Math.min(stepIndex, steps.length - 1)];
  const last = stepIndex === steps.length - 1 && steps.length > 1;
  const complete = stepComplete(step.id, draft, registry);

  // Consoles come from the same state read the rest of the app shares, so this
  // is not a request of its own while the page already holds it.
  const { data: stage, error: stageError } = useQuery({
    queryKey: QUERY_KEYS.stageState,
    queryFn: () => invoke<{ views?: View[] }>("stage:getState"),
  });
  const consoles = useMemo(() => consolesWithLayouts(stage?.views ?? []), [stage]);
  // A failed read is not "there are no consoles": the step says so, and /log has it.
  useEffect(() => {
    if (stageError) logReadFailure("automation", "the consoles for a cue button", stageError);
  }, [stageError]);

  const takenNow = useMemo(() => takenCueNames(rules, registry.reservedCueNames), [rules, registry]);
  // FROZEN from Create until the dialog is done. The moment the rule exists the
  // list re-reads and holds the very name this cue was just made with, so a Review
  // still on screen would derive `stage_reset_2` for a cue that is `stage_reset`.
  const [frozenTaken, setFrozenTaken] = useState<ReadonlySet<string> | null>(null);
  const taken = frozenTaken ?? takenNow;
  const cueName = newCueName(draft, registry, taken);
  const suggestion = suggestedName(draft, registry);

  const go = (id: StepId) => {
    const i = steps.findIndex((s) => s.id === id);
    if (i >= 0) setStepIndex(i);
  };

  /** One line under a step's fields naming what still blocks Next. */
  const missing = stepIssues(step.id, draft, registry);

  // Set at once, not through state: a second press before the first re-render would
  // otherwise create a second automatic rule, which nothing refuses as a duplicate.
  const started = useRef(false);

  async function create() {
    if (started.current) return;
    started.current = true;
    setBusy(true);
    setError(null);
    setFrozenTaken(taken);
    let created: Rule;
    try {
      created = await invoke<Rule>("automation:addRule", buildRule(draft, registry, taken));
    } catch (e) {
      // The dialog stays open with the draft intact: nothing was written, and a
      // dialog that closed on this would lose the whole thing and say nothing.
      // Unfrozen, so the name is derived against what is there now.
      setError(errorMessage(e));
      setFrozenTaken(null);
      setBusy(false);
      started.current = false;
      return;
    }
    onCreated();

    const ruleName = created.name;
    const name = String(created.trigger.params.name ?? "");
    let results: ConsoleResult[] = [];
    if (draft.kind === "manual" && draft.consoleIds.length > 0) {
      results = await addCueButtonToConsoles(draft.consoleIds, name, draft.buttonLabel.trim(), ruleName);
      logConsoleButtons(name, results);
    }
    setBusy(false);
    if (results.some((r) => !r.ok)) {
      // Stay: the cue is made, and the operator has to be told which console is not.
      setOutcome({ ruleName, cueName: name, results });
      return;
    }
    // Said, not dropped: the button is there but on top of something, and the only
    // other evidence is a console somebody has to open.
    const crowded = results.filter((r) => r.overEdge).map((r) => r.name);
    toast.success(
      results.length > 0
        ? `Created ${ruleName}, with a button on ${joinWithAnd(results.map((r) => r.name))}.` +
            (crowded.length > 0
              ? ` ${joinWithAnd(crowded)} had no room below its other objects, so the button sits against the bottom edge.`
              : "")
        : `Created ${ruleName}`,
    );
    onClose();
  }

  // ── Sidebar ────────────────────────────────────────────────────────────────

  const sub = (id: StepId): string => {
    switch (id) {
      case "kind":
        return draft.kind ? KIND_NAMES[draft.kind] : "";
      case "trig":
        return labelOf(registry.triggers, draft.trigger.id);
      case "if":
        return draft.conditions.length === 0
          ? "None"
          : plural(draft.conditions.length, "condition");
      case "act":
        return labelOf(registry.actions, draft.action.id);
      case "name":
        return displayName(draft, registry);
      case "console":
        return draft.consoleIds.length === 0
          ? "None"
          : plural(draft.consoleIds.length, "console");
      default:
        return "";
    }
  };

  // ── The body of each step ──────────────────────────────────────────────────

  const head = headingFor(step.id, draft.kind);

  const body = (() => {
    switch (step.id) {
      case "kind":
        return <KindStep kind={draft.kind} onChoose={(kind) => patch({ kind })} />;

      case "trig":
        return (
          <>
            <AutomationPicker
              kind="trigger"
              defs={registry.triggers}
              value={draft.trigger.id}
              exclude={NOT_PICKED_TRIGGERS}
              onChange={(id) =>
                patch({
                  trigger: {
                    id,
                    params: seededParams("trigger", id, registry.triggers.find((t) => t.id === id)?.params ?? []),
                  },
                })
              }
            />
            {registry.triggers
              .find((t) => t.id === draft.trigger.id)
              ?.params.map((p) => (
                <ParamField
                  key={p.key}
                  spec={p}
                  value={draft.trigger.params[p.key]}
                  optionSources={optionSources}
                  onChange={(v) => patch({ trigger: { ...draft.trigger, params: { ...draft.trigger.params, [p.key]: v } } })}
                />
              ))}
          </>
        );

      case "if":
        return (
          <>
            {draft.conditions.length === 0 ? (
              <p className="rounded-lg border border-line bg-surface px-3 py-2 text-caption1 text-fg-muted">
                No conditions. The rule fires whenever its trigger does.
              </p>
            ) : (
              draft.conditions.map((c, i) => {
                const spec = registry.conditions.find((x) => x.id === c.id);
                return (
                  <div key={`${c.id}-${i}`} data-condition={c.id} className="rounded-md border border-line px-3 py-1.5">
                    <div className="flex items-center gap-2">
                      <span className="flex-1 text-footnote font-medium text-fg">{spec?.label ?? c.id}</span>
                      <Button
                        variant="transparent"
                        size="small"
                        onClick={() => patch({ conditions: draft.conditions.filter((_, j) => j !== i) })}
                      >
                        Remove
                      </Button>
                    </div>
                    {spec?.params.map((p) => (
                      <ParamField
                        key={p.key}
                        spec={p}
                        value={c.params[p.key]}
                        optionSources={optionSources}
                        onChange={(v) => {
                          const next = [...draft.conditions];
                          next[i] = { ...c, params: { ...c.params, [p.key]: v } };
                          patch({ conditions: next });
                        }}
                      />
                    ))}
                  </div>
                );
              })
            )}
            <Row label="Add a condition" plain>
              <PickerField
                kind="condition"
                defs={registry.conditions}
                value=""
                placeholder="Choose…"
                ariaLabel="Add a condition"
                onChange={(id) =>
                  patch({
                    conditions: [
                      ...draft.conditions,
                      { id, params: seededParams("condition", id, registry.conditions.find((c) => c.id === id)?.params ?? []) },
                    ],
                  })
                }
              />
            </Row>
          </>
        );

      case "act":
        return (
          <>
            <AutomationPicker
              kind="action"
              defs={registry.actions}
              value={draft.action.id}
              onChange={(id) =>
                patch({
                  action: {
                    id,
                    params: seededParams("action", id, registry.actions.find((a) => a.id === id)?.params ?? []),
                  },
                })
              }
            />
            {draft.action.id !== "" && (
              <ActionParamsFields
                actionId={draft.action.id}
                action={registry.actions.find((a) => a.id === draft.action.id) ?? null}
                params={draft.action.params}
                optionSources={optionSources}
                onChange={(params) => patch({ action: { ...draft.action, params } })}
              />
            )}
          </>
        );

      case "name":
        return (
          <>
            <SettingRow label="Name" help="Shown in the list and on the Run button." htmlFor="new-cue-name">
              <Input
                id="new-cue-name"
                value={draft.name}
                placeholder={suggestion}
                onChange={(e) => patch({ name: e.target.value })}
                className="h-8 w-64 max-w-[55%]"
              />
            </SettingRow>
            {draft.kind === "manual" ? (
              <>
                <SettingRow label="Home Assistant" help="A button there, and so in Apple Home and by voice.">
                  <Switch
                    checked={draft.homeAssistant}
                    onCheckedChange={(v) => patch({ homeAssistant: v })}
                    aria-label="Home Assistant"
                    className="mt-0.5"
                  />
                </SettingRow>
                <SettingRow
                  label="Allowed during a service"
                  help="Off refuses it while a service is live or about to start."
                >
                  <Switch
                    checked={draft.allowedDuringService}
                    onCheckedChange={(v) => patch({ allowedDuringService: v })}
                    aria-label="Allowed during a service"
                    className="mt-0.5"
                  />
                </SettingRow>
              </>
            ) : (
              <>
                <SettingRow label="Cooldown (seconds)" help="Before it may fire again.">
                  <NumberInput
                    value={cooldownOf(draft)}
                    min={0}
                    max={86400}
                    onChange={(n) => patch({ cooldownSec: n })}
                    className="h-8 w-28"
                  />
                </SettingRow>
                <SettingRow label="Once per service" help="Fire at most once per Planning Center service occurrence.">
                  <Switch
                    checked={draft.oncePerService}
                    onCheckedChange={(v) => patch({ oncePerService: v })}
                    aria-label="Once per service"
                    className="mt-0.5"
                  />
                </SettingRow>
              </>
            )}
          </>
        );

      case "console":
        return (
          <ConsoleStep
            consoles={consoles}
            readError={!stage && stageError ? errorMessage(stageError) : null}
            chosen={draft.consoleIds}
            onToggle={(id) =>
              patch({
                consoleIds: draft.consoleIds.includes(id)
                  ? draft.consoleIds.filter((c) => c !== id)
                  : [...draft.consoleIds, id],
              })
            }
            label={draft.buttonLabel}
            onLabel={(buttonLabel) => patch({ buttonLabel })}
            placeholder={draft.name.trim() || suggestion}
          />
        );

      case "review": {
        const on = enabledOf(draft);
        const consoleNames = draft.consoleIds.map((id) => consoles.find((c) => c.id === id)?.name ?? id);
        const rows: [string, string, StepId][] =
          draft.kind === "manual"
            ? [
                ["Kind", KIND_NAMES.manual, "kind"],
                ["Does", labelOf(registry.actions, draft.action.id) || "—", "act"],
                ["Name", displayName(draft, registry) || "—", "name"],
                ["Cue name", cueName, "name"],
                ["Fires from", ["Run button", draft.homeAssistant ? "Home Assistant" : null].filter(Boolean).join(", "), "name"],
                ["During a service", draft.allowedDuringService ? "Allowed" : "Refused", "name"],
                ["On consoles", consoleNames.join(", ") || "None", "console"],
              ]
            : [
                ["Kind", KIND_NAMES.auto, "kind"],
                ["When", labelOf(registry.triggers, draft.trigger.id) || "—", "trig"],
                ["If", draft.conditions.map((c) => labelOf(registry.conditions, c.id) || c.id).join(", ") || "Always", "if"],
                ["Then", labelOf(registry.actions, draft.action.id) || "—", "act"],
                ["Name", displayName(draft, registry) || "—", "name"],
              ];
        return (
          <>
            <div className="overflow-hidden rounded-[10px] border border-line" data-review="">
              {rows.map(([k, v, to]) => (
                <div
                  key={k}
                  data-review-row={k}
                  className="grid grid-cols-[120px_minmax(0,1fr)_auto] items-center gap-2.5 border-b border-line px-3 py-2 text-footnote last:border-b-0"
                >
                  <span className="text-caption2 font-semibold uppercase tracking-wider text-fg-subtle">{k}</span>
                  <span className="min-w-0 break-words text-fg">{v}</span>
                  {/* Cue name is derived, so there is nothing to change on its own
                      row: Change goes to the Name it comes from. */}
                  {k === "Cue name" ? (
                    <span />
                  ) : (
                    <button
                      type="button"
                      className="text-caption1 text-accent-text hover:underline"
                      aria-label={`Change ${k}`}
                      onClick={() => go(to)}
                    >
                      Change
                    </button>
                  )}
                </div>
              ))}
            </div>
            <SettingRow
              label={draft.kind === "manual" ? "On" : "Enabled"}
              help={
                draft.kind === "manual"
                  ? "Safe to leave on: it never fires by itself."
                  : "Starts off. Run it once with Test, and watch it through a service with a log message before giving it a real action."
              }
            >
              <Switch
                checked={on}
                onCheckedChange={(v) => patch({ enabled: v })}
                aria-label="Enabled"
                className="mt-0.5"
              />
            </SettingRow>
            {draft.kind === "auto" && on && (
              <p role="status" className="rounded-lg bg-amber-3 px-3 py-2 text-caption1 text-amber-11">
                This rule will fire on its own from now on. Simulate mode on the Automation page still applies.
              </p>
            )}
            {error && <ErrorNote>{error}</ErrorNote>}
          </>
        );
      }
    }
  })();

  const skippable = step.optional === true && (step.id === "if" ? draft.conditions.length === 0 : draft.consoleIds.length === 0);

  // The dialog cannot be closed while Create is writing: the rule is made and the
  // buttons are being written, and a dialog closed under them could never say which
  // console refused — the failure this dialog exists to name.
  return (
    <DialogRoot open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent
        aria-describedby={undefined}
        data-new-cue=""
        className={cn(
          "flex max-h-[92vh] min-h-[520px] max-w-[860px] gap-0 overflow-hidden p-0",
          "max-md:flex-col",
        )}
      >
        <nav
          aria-label="Steps"
          className="flex w-[210px] shrink-0 flex-col gap-0.5 border-r border-line bg-surface px-3 py-[18px] max-md:hidden"
        >
          <DialogTitle className="px-2.5 pb-2.5 text-caption2 font-semibold uppercase tracking-wider text-fg-subtle">
            New cue
          </DialogTitle>
          {steps.map((s, i) => {
            const done = outcome === null && i < stepIndex;
            const current = i === stepIndex;
            const shown = i <= stepIndex ? sub(s.id) : "";
            return (
              <button
                key={s.id}
                type="button"
                data-step={s.id}
                aria-current={current ? "step" : undefined}
                disabled={busy || outcome !== null || (!current && !reachable(i, draft, registry))}
                onClick={() => setStepIndex(i)}
                className={cn(
                  "flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors",
                  "disabled:cursor-not-allowed disabled:opacity-60",
                  current ? "bg-accent/12 text-fg" : "text-fg-muted hover:bg-fill",
                  done && s.optional && shown === "None" && "opacity-60",
                )}
              >
                <span
                  className={cn(
                    "mt-px grid size-5 shrink-0 place-items-center rounded-full border font-mono text-caption2",
                    current ? "border-accent bg-accent text-white" : "border-line-strong",
                    done && "bg-fill-hover text-fg",
                  )}
                >
                  {done ? "✓" : i + 1}
                </span>
                <span className="min-w-0 text-footnote">
                  {s.label}
                  {shown && <small className="mt-px block max-w-[140px] truncate text-caption1 text-fg-subtle">{shown}</small>}
                </span>
              </button>
            );
          })}
        </nav>

        <section className="flex min-h-0 min-w-0 flex-1 flex-col">
          {outcome ? (
            <OutcomePanel outcome={outcome} onDone={onClose} />
          ) : (
            <>
              <div className="px-[22px] pb-1.5 pt-[18px] pr-12">
                <h2 data-step-heading="" className="text-subheadline font-semibold text-fg">{head.title}</h2>
                {head.blurb && <p className="mt-0.5 text-footnote text-fg-muted">{head.blurb}</p>}
              </div>
              <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-[22px] py-3" data-step-body={step.id}>
                {body}
                {missing.length > 0 && !complete && (
                  <p data-needs="" className="text-caption1 text-fg-muted">
                    {fieldsNeedAttention(missing.length)}: {joinWithAnd(missing.map((m) => m.label))}.
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2 border-t border-line px-[22px] py-3">
                <Button variant="transparent" size="medium" onClick={onClose} disabled={busy}>
                  Cancel
                </Button>
                <span className="flex-1" />
                {stepIndex > 0 && (
                  <OutlineButton onClick={() => setStepIndex(stepIndex - 1)} disabled={busy}>
                    Back
                  </OutlineButton>
                )}
                {skippable && (
                  <Button variant="transparent" size="medium" onClick={() => setStepIndex(stepIndex + 1)}>
                    Skip
                  </Button>
                )}
                {last ? (
                  <Button variant="accent" size="medium" onClick={() => void create()} disabled={busy}>
                    {busy ? "Creating…" : "Create"}
                  </Button>
                ) : (
                  !skippable && (
                    <Button variant="accent" size="medium" onClick={() => setStepIndex(stepIndex + 1)} disabled={!complete || busy}>
                      Next
                    </Button>
                  )
                )}
              </div>
            </>
          )}
        </section>
      </DialogContent>
    </DialogRoot>
  );
}

/** The line the /log page gets for the buttons: which consoles took
 *  one and which refused, in one line so a Sunday morning reads it at a glance. */
function logConsoleButtons(cue: string, results: ConsoleResult[]): void {
  const ok = results.filter((r) => r.ok).map((r) => `"${r.name}"`);
  const bad = results.filter((r) => !r.ok).map((r) => `"${r.name}": ${r.error}`);
  const parts = [
    ok.length > 0 ? `added to ${ok.join(", ")}` : "",
    bad.length > 0 ? `failed on ${bad.join("; ")}` : "",
  ].filter(Boolean);
  logToServer("automation", `cue button for ${cue} ${parts.join("; ")}`);
}

function headingFor(id: StepId, kind: CueKind | null): { title: string; blurb: string } {
  switch (id) {
    case "kind":
      return { title: "What kind of cue?", blurb: "You can change this later from the cue’s editor." };
    case "trig":
      return { title: "When does it fire?", blurb: "One trigger. It fires on the change, never on a state that just persists." };
    case "if":
      return { title: "Only if… (optional)", blurb: "Every condition must hold when the trigger fires. Most rules need none." };
    case "act":
      return { title: kind === "manual" ? "What does it do?" : "Then do what?", blurb: "One action." };
    case "name":
      return kind === "manual"
        ? { title: "Name it, and say where it can be fired", blurb: "The Run button on the Automation page always works." }
        : { title: "Name it, and set its safety", blurb: "" };
    case "console":
      return {
        title: "Put it on a console (optional)",
        blurb:
          "Adds a button that fires this cue to each console you tick. Skip it and you can still add one later in the layout editor.",
      };
    case "review":
      return { title: "Review", blurb: "Nothing has been saved yet." };
  }
}

function KindStep({ kind, onChoose }: { kind: CueKind | null; onChoose: (k: CueKind) => void }) {
  const card = (
    k: CueKind,
    icon: React.ReactNode,
    title: string,
    what: string,
    example: string,
  ) => (
    <button
      type="button"
      data-kind={k}
      aria-pressed={kind === k}
      onClick={() => onChoose(k)}
      className={cn(
        "flex flex-col items-start gap-2 rounded-xl border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
        kind === k ? "border-accent bg-accent/12" : "border-line-strong bg-surface hover:bg-fill",
      )}
    >
      <span className="grid size-[34px] place-items-center rounded-[9px] bg-accent/12 text-accent-text">{icon}</span>
      <span className="text-subheadline font-semibold text-fg">{title}</span>
      <span className="text-footnote text-fg-muted">{what}</span>
      <span className="text-caption1 text-fg-subtle">{example}</span>
    </button>
  );
  return (
    <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1" role="group" aria-label="Kind of cue">
      {card(
        "manual",
        <HandIcon className="size-[18px]" />,
        "Manual cue",
        "Fires only when someone fires it: its Run button, a cue button on a console, Home Assistant or voice. Nothing happening in the building sets it off.",
        "Projectors on. Foyer TVs off. Reset the stage.",
      )}
      {card(
        "auto",
        <ZapIcon className="size-[18px]" />,
        "Automatic rule",
        "Fires on its own when something happens: the service goes live, a recording starts, a count crosses a number.",
        "When the service goes live, start OBS recording.",
      )}
    </div>
  );
}

function ConsoleStep({
  consoles,
  readError,
  chosen,
  onToggle,
  label,
  onLabel,
  placeholder,
}: {
  consoles: readonly View[];
  /** Why the consoles could not be read, when they could not. */
  readError: string | null;
  chosen: readonly string[];
  onToggle: (id: string) => void;
  label: string;
  onLabel: (v: string) => void;
  placeholder: string;
}) {
  if (readError) {
    return (
      <ErrorNote>
        Could not read the consoles: {readError}. Skip this step and add the button in the layout editor.
      </ErrorNote>
    );
  }
  if (consoles.length === 0) {
    return (
      <p className="rounded-lg border border-line bg-surface px-3 py-2 text-caption1 text-fg-muted">
        There are no consoles to put a button on yet. Skip this and add one in the layout editor when there are.
      </p>
    );
  }
  return (
    <>
      <div role="group" aria-label="Consoles" className="flex flex-col gap-1.5">
        {consoles.map((c) => {
          const on = chosen.includes(c.id);
          return (
            <label
              key={c.id}
              data-console={c.id}
              className={cn(
                "flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2 transition-colors",
                on ? "border-accent bg-accent/12" : "border-line bg-surface hover:bg-fill",
              )}
            >
              <Checkbox checked={on} onCheckedChange={() => onToggle(c.id)} aria-label={c.name} />
              <span className="text-footnote font-medium text-fg">{c.name}</span>
              <span className="ml-auto text-caption1 text-fg-muted">console</span>
            </label>
          );
        })}
      </div>
      {chosen.length > 0 && (
        <>
          <SettingRow label="Button label" help="Blank uses the cue’s name." htmlFor="new-cue-button-label">
            <Input
              id="new-cue-button-label"
              value={label}
              placeholder={placeholder}
              onChange={(e) => onLabel(e.target.value)}
              className="h-8 w-64 max-w-[55%]"
            />
          </SettingRow>
          <p className="rounded-lg border border-line bg-surface px-3 py-2 text-caption1 text-fg-muted">
            The button goes at the bottom of each layout, sized like its other buttons. Drag it where you want it in the
            layout editor.
          </p>
        </>
      )}
    </>
  );
}

/** After Create, when at least one console did not take its button. */
function OutcomePanel({ outcome, onDone }: { outcome: Outcome; onDone: () => void }) {
  const failed = outcome.results.filter((r) => !r.ok);
  const done = outcome.results.filter((r) => r.ok);
  return (
    <>
      <div className="px-[22px] pb-1.5 pt-[18px] pr-12">
        <h2 className="text-subheadline font-semibold text-fg">Created, but not everywhere</h2>
        <p className="mt-0.5 text-footnote text-fg-muted">
          {outcome.ruleName} is made and runs. {failed.length === 1 ? "One console" : `${failed.length} consoles`} did not
          get its button.
        </p>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-[22px] py-3" data-outcome="">
        {failed.map((r) => (
          <ErrorNote key={r.viewId}>
            {r.name}: {r.error}. Add the button in the layout editor, bound to the cue {outcome.cueName}.
          </ErrorNote>
        ))}
        {done.length > 0 && (
          <p className="text-footnote text-fg-muted">
            Added to {joinWithAnd(done.map((r) => r.name))}.
            {done.some((r) => r.overEdge) && " The layout had no room below its other objects, so the button sits against the bottom edge."}
          </p>
        )}
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-line px-[22px] py-3">
        <Button variant="accent" size="medium" onClick={onDone}>
          Done
        </Button>
      </div>
    </>
  );
}
