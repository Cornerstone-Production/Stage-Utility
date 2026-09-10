import { errorMessage } from "@main/services/errors";
import { CALL_TRIGGER_ID, encodeAliases, parseAliases } from "@main/services/cue-aliases";
import {
  cuePairs,
  isTogglePair,
  stateBindingOf,
  stateBindingParams,
  STATE_ANY_OTHER,
  STATE_OFF_DEFAULT,
  STATE_ON_DEFAULT,
} from "@main/services/cue-pairs";
import type { InferredStateSource } from "@main/services/companion-state-source";
import { hasServiceGuard, withServiceGuard } from "@main/services/service-guard";
// The one main type imported rather than restated below. The wire shapes in
// this file are deliberately local — the renderer models what the API sends —
// but an OUTCOME is a closed set the server owns, and a second copy of it is a
// list that silently stops covering the log: `skipped` had to be added here by
// hand, and nothing would have said so if it had not been.
import type { AutomationOutcome } from "@main/types/automation";
import { labelFor, ruleMatchesSearch } from "./rule-search";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useResyncOn } from "@renderer/lib/use-resync-on";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { DownloadIcon, OctagonXIcon, PlayIcon, PlusIcon, SearchIcon, Trash2Icon } from "lucide-react";

import { invoke, onNotification } from "../../lib/api";
import {
  Button,
  Collapsible,
  InfoHint,
  Input,
  NumberInput,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Separator,
  Status,
  Switch,
  toast,
} from "../../components/ui";
import { formatClock } from "../../lib/clock-format";
import {
  CompanionPressFields,
  CueAccessCard,
  CueButtonStatus,
  ImportPairsDialog,
} from "./companion-cues";

// ── Registry shapes (functions are stripped server-side) ──────────────────────

interface ParamSpec {
  key: string;
  label: string;
  type: "number" | "string" | "enum" | "multi-enum" | "key-value";
  min?: number;
  max?: number;
  options?: { value: string; label: string }[];
  optionsFrom?: string;
  optional?: boolean;
  help?: string;
  keyLabel?: string;
  valueLabel?: string;
}
interface Spec {
  id: string;
  label: string;
  params: ParamSpec[];
  help?: string;
}
interface Registry {
  triggers: (Spec & { channel: string })[];
  conditions: Spec[];
  actions: Spec[];
}

interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  trigger: { id: string; params: Record<string, string | number> };
  conditions: { id: string; params: Record<string, string | number> }[];
  action: { id: string; params: Record<string, string | number> };
  cooldownSec: number;
  oncePerService: boolean;
  confirmRequired?: boolean;
}

/** One bound pair's state, as `GET /api/cues/states` sends it. */
interface CueStateRow {
  on: string;
  off: string;
  variable: string;
  value: string | null;
  state: "on" | "off" | "unknown";
  reason?: string;
}

interface LogEntry {
  at: string;
  ruleName: string;
  triggerId: string;
  actionId: string;
  outcome: AutomationOutcome;
  detail: string;
  /** The token label behind a called cue. Absent for anything the engine fired. */
  caller?: string;
}

// ── Shared row helpers, matching the layout inspector's shape ─────────────────

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex items-center gap-3 py-1">
      <span className="w-36 shrink-0 text-caption1 text-fg-muted">
        {label}
        {hint ? <InfoHint>{hint}</InfoHint> : null}
      </span>
      <span className="min-w-0 flex-1">{children}</span>
    </label>
  );
}

const selectCls =
  "h-7 w-full rounded-md border border-line-strong bg-field px-2.5 py-1 text-footnote text-fg focus:border-focus focus:outline-none focus:ring-1 focus:ring-focus";

/** The saved JSON object as editable rows. Malformed config yields no rows rather
 *  than throwing — the operator can then just add them. */
function parseRows(value: string | number | undefined): [string, string][] {
  try {
    const parsed: unknown = JSON.parse(String(value ?? "") || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    return Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [k, String(v ?? "")] as [string, string]);
  } catch {
    return [];
  }
}

/**
 * A two-column table stored as a JSON object string.
 *
 * Exists for values that must be typed EXACTLY as some other system spells them —
 * a Dante channel name may carry a numeric prefix or be renamed at will, so nothing
 * can generate it and nothing here validates it. The operator reads it off the
 * other system and types it; the point is that they can see what they typed.
 */
function KeyValueField({
  spec,
  value,
  onChange,
}: {
  spec: ParamSpec;
  value: string | number | undefined;
  onChange: (v: string) => void;
}) {
  // The rows being edited live here rather than being derived from the saved
  // value, because a half-typed row cannot be represented in what gets saved: the
  // param is a JSON OBJECT, and an object has no key for a row whose key is still
  // blank. Deriving them meant "add row" created a row that was filtered out
  // before it could render, so the button appeared to do nothing.
  const [rows, setRows] = useState<[string, string][]>(() => parseRows(value));
  // What we last sent up, so an echo of our own write does not clobber a blank row
  // the operator is still filling in.
  const lastWritten = useRef<string | null>(null);

  useEffect(() => {
    const incoming = String(value ?? "");
    if (incoming === lastWritten.current) return;
    setRows(parseRows(value));
  }, [value]);

  const write = (next: [string, string][]) => {
    setRows(next);
    // Blank keys are dropped on the way out only — they stay visible while typing.
    const json = JSON.stringify(Object.fromEntries(next.filter(([k]) => k.trim() !== "")));
    lastWritten.current = json;
    onChange(json);
  };

  return (
    <div className="flex flex-col gap-1.5 py-1">
      <span className="text-caption1 text-fg-muted">
        {spec.label}
        {spec.help ? <InfoHint>{spec.help}</InfoHint> : null}
      </span>
      <div className="flex flex-col gap-1">
        {rows.map(([k, v], i) => (
          <div key={i} className="flex items-center gap-1.5">
            <Input
              value={k}
              onChange={(e) => write(rows.map((r, j) => (j === i ? [e.target.value, r[1]] : r)))}
              className="h-7 w-20 text-footnote"
              aria-label={spec.keyLabel ?? "Key"}
              placeholder={spec.keyLabel ?? "Key"}
            />
            <Input
              value={v}
              onChange={(e) => write(rows.map((r, j) => (j === i ? [r[0], e.target.value] : r)))}
              className="h-7 flex-1 text-footnote"
              aria-label={spec.valueLabel ?? "Value"}
              placeholder={spec.valueLabel ?? "Value"}
            />
            <button
              type="button"
              onClick={() => write(rows.filter((_, j) => j !== i))}
              className="touch-target rounded p-0.5 text-fg-subtle hover:text-warn-11"
              aria-label="Remove row"
            >
              <Trash2Icon className="size-3.5" />
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => write([...rows, ["", ""]])}
          className="inline-flex w-fit items-center gap-1 rounded px-1 py-0.5 text-caption2 text-fg-subtle hover:text-fg"
        >
          <PlusIcon className="size-3" /> row
        </button>
      </div>
    </div>
  );
}

/** Renders one param from its spec — the reason a new provider needs no UI work. */
function ParamField({
  spec,
  value,
  onChange,
  dynamicOptions,
}: {
  spec: ParamSpec;
  value: string | number | undefined;
  onChange: (v: string | number) => void;
  dynamicOptions: Record<string, { value: string; label: string }[]>;
}) {
  const options = spec.optionsFrom ? (dynamicOptions[spec.optionsFrom] ?? []) : (spec.options ?? []);

  if (spec.type === "key-value") {
    return <KeyValueField spec={spec} value={value} onChange={onChange} />;
  }

  if (spec.type === "number") {
    return (
      <Row label={spec.label} hint={spec.help}>
        <NumberInput
          value={Number(value ?? spec.min ?? 0)}
          min={spec.min}
          max={spec.max}
          onChange={(n) => onChange(n)}
          className="h-7 text-footnote"
        />
      </Row>
    );
  }
  if (spec.type === "enum" || spec.type === "multi-enum") {
    return (
      <Row label={spec.label} hint={spec.help}>
        <select className={selectCls} value={String(value ?? "")} onChange={(e) => onChange(e.target.value)}>
          <option value="">{spec.optional ? "(any)" : "Pick one…"}</option>
          {options.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </Row>
    );
  }
  // A string param can still name a runtime source. It stays typeable on purpose:
  // the list only knows the plan that is loaded right now, and a rule is written
  // for every week — so picking is a convenience, not a constraint.
  if (spec.optionsFrom && options.length > 0) {
    const listId = `opts-${spec.optionsFrom}`;
    return (
      <Row label={spec.label} hint={spec.help}>
        <>
          <Input
            value={String(value ?? "")}
            list={listId}
            onChange={(e) => onChange(e.target.value)}
            className="h-7 text-footnote"
          />
          <datalist id={listId}>
            {options.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </datalist>
        </>
      </Row>
    );
  }

  return (
    <Row label={spec.label} hint={spec.help}>
      <Input
        value={String(value ?? "")}
        onChange={(e) => onChange(e.target.value)}
        className="h-7 text-footnote"
      />
    </Row>
  );
}

// ── Activity log ──────────────────────────────────────────────────────────────

const OUTCOME_STYLE: Record<AutomationOutcome, string> = {
  fired: "text-fg",
  simulated: "text-fg-muted",
  suppressed: "text-fg-subtle",
  skipped: "text-fg-subtle",
  "condition-not-met": "text-fg-subtle",
  failed: "text-red-10",
};

function ActivityLog() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["automation:log"],
    queryFn: () => invoke<{ entries: LogEntry[] }>("automation:log"),
  });
  const refresh = useCallback(() => void qc.invalidateQueries({ queryKey: ["automation:log"] }), [qc]);
  useEffect(() => onNotification("automation:log", refresh), [refresh]);

  const entries = data?.entries ?? [];

  return (
    <Collapsible label="Activity" summary={`${entries.length} recent`} className="su-card px-4 py-2.5">
      <div className="flex flex-col gap-1 pt-2">
        {entries.length === 0 ? (
          <p className="text-caption1 text-fg-muted">
            Nothing yet. Rules log here when they fire — and when they are suppressed, with the reason.
          </p>
        ) : (
          entries.slice(0, 60).map((e, i) => (
            <div key={`${e.at}-${i}`} className="flex items-baseline gap-2 text-caption1">
              <span className="shrink-0 font-mono text-caption2 text-fg-subtle">
                {formatClock(e.at, { seconds: true })}
              </span>
              <span className="shrink-0 font-medium text-fg-muted">{e.ruleName}</span>
              {e.caller && (
                <span className="shrink-0 text-caption2 text-fg-subtle">via {e.caller}</span>
              )}
              <span className={`min-w-0 flex-1 truncate ${OUTCOME_STYLE[e.outcome]}`}>
                {e.outcome === "fired" ? "" : `${e.outcome}: `}
                {e.detail}
              </span>
            </div>
          ))
        )}
        {entries.length > 0 && (
          <div className="pt-2">
            <Button
              variant="transparent"
              size="small"
              onClick={async () => {
                await invoke("automation:clearLog");
                refresh();
              }}
            >
              Clear
            </Button>
          </div>
        )}
      </div>
    </Collapsible>
  );
}

// ── One rule ──────────────────────────────────────────────────────────────────

/**
 * The names a cue used to answer to, each with a remove.
 *
 * Renders nothing when there are none, which is every cue nobody has renamed.
 * Removing one is an ordinary rule save — it goes through the same Save button
 * and the same server-side name check as any other edit — because a former name
 * is a live URL and dropping it is a decision, not a tidy-up.
 */
function FormerNamesField({
  params,
  onChange,
}: {
  params: Record<string, string | number>;
  onChange: (aliases: string) => void;
}) {
  const names = parseAliases(params);
  if (names.length === 0) return null;
  return (
    <Row
      label="Former names"
      hint="Names this cue still answers to, kept when its Companion button was relabelled. Remove one and that URL stops resolving — re-paste the Home Assistant config first."
    >
      <span className="flex flex-wrap gap-1" data-cue-former-list={names.join(",")}>
        {names.map((name) => (
          <span
            key={name}
            className="inline-flex items-center gap-1 rounded-md border border-line px-1.5 py-0.5 text-caption1 text-fg-muted"
          >
            {name}
            <button
              type="button"
              aria-label={`Remove former name ${name}`}
              onClick={() => onChange(encodeAliases(names.filter((n) => n !== name)))}
            >
              <Trash2Icon className="size-3 text-fg-subtle" />
            </button>
          </span>
        ))}
      </span>
    </Row>
  );
}

/**
 * One pair's row out of the states answer, or null when it has none.
 *
 * `Object.hasOwn` rather than `states[base]`: the key is the pair's base, which
 * is half of a cue name, and a pair called `constructor_on`/`constructor_off`
 * read `Object.prototype.constructor` straight off the prototype chain. That is
 * a function, so it is truthy, so the row grew a pill — an amber dot with no
 * word beside it, saying nothing at all about a pair that is simply not in the
 * answer. `__proto__`, `prototype` and `toString` are the same shape.
 */
function cueStateFor(
  states: Record<string, CueStateRow> | undefined,
  base: string | null,
): CueStateRow | null {
  if (!states || base === null || !Object.hasOwn(states, base)) return null;
  return states[base] ?? null;
}

/**
 * What a bound pair's device is actually doing, on the `_on` half's row.
 *
 * The `_off` half shows nothing: one pair is one thing, and a second pill saying
 * the same word twice reads as two devices. Renders nothing at all for an
 * unbound pair or a cue that is not half of one — an "unknown" pill on every
 * rule in the list would be noise nobody could act on.
 */
function CuePairState({ base, state }: { base: string; state: CueStateRow }) {
  const variant = state.state === "on" ? "success" : state.state === "off" ? "neutral" : "warning";
  return (
    <span
      className="flex min-w-0 items-center gap-1.5"
      // The pair, always, beside the word. `data-cue-state` alone is not enough
      // to see a pill that should not be there: a row that took its state off
      // the prototype chain rendered a dot with no word AND no state attribute,
      // so nothing could count it.
      data-cue-pair={base}
      data-cue-state={state.state}
      // The reason on hover rather than on the row: it is a sentence, and the
      // row already carries the rule name and the summary.
      title={state.reason ? `${state.variable}: ${state.reason}` : state.variable}
    >
      <Status variant={variant}>{state.state}</Status>
    </span>
  );
}

/**
 * "service-safe" (quiet) when the cue carries `service.is-not-live`, or a
 * clearly visible amber "any time" when it does not — so the cues that can
 * fire mid-service stand out in a long list rather than needing the editor
 * opened one at a time.
 *
 * Only for a cue (`call.by-name`): the condition means nothing on a rule that
 * cannot be called.
 */
function ServiceGuardBadge({ conditions }: { conditions: Rule["conditions"] }) {
  const guarded = hasServiceGuard(conditions);
  return (
    <span
      data-service-guard={guarded ? "on" : "off"}
      className={
        "inline-flex shrink-0 items-center rounded-md px-1.5 py-0.5 text-caption2 " +
        (guarded ? "text-fg-subtle" : "border border-amber-7 bg-amber-3 font-medium text-amber-11")
      }
    >
      {guarded ? "service-safe" : "any time"}
    </span>
  );
}

/**
 * The one switch over the `service.is-not-live` condition — see
 * service-guard.ts for what flipping it does to the condition list.
 *
 * Only for a cue: the condition, and the switch reading it, mean nothing on a
 * rule with any other trigger.
 */
function ServiceGuardField({
  conditions,
  onChange,
}: {
  conditions: Rule["conditions"];
  onChange: (next: Rule["conditions"]) => void;
}) {
  const allowed = !hasServiceGuard(conditions);
  return (
    <Row
      label="Allowed during a service"
      hint='Off: refused while a service is live or about to start (the imported default). On: fires whenever it is called.'
    >
      <Switch
        checked={allowed}
        onCheckedChange={(v) => onChange(withServiceGuard(conditions, !v))}
        aria-label="Allowed during a service"
      />
    </Row>
  );
}

/**
 * The three state-binding fields, on the `_on` half of a pair and nowhere else.
 *
 * A binding on a cue with no partner reads a variable nothing ever shows, so the
 * fields are not offered there at all rather than offered and ignored.
 *
 * The variable is a SELECT of what Companion has, with a text field as well
 * whenever the export could not be read — otherwise an unreachable Companion
 * would mean an existing binding could not even be seen, let alone cleared.
 */
/** One button in the Companion offer, as far as the editor reads it. */
interface OfferedButton {
  page: number;
  row: number;
  col: number;
  stateSource?: InferredStateSource | null;
}

/**
 * `GET /api/companion/pairs`, as far as the editor reads it.
 *
 * The custom variable names for the select, and every offered button's inferred
 * source — the pairs' halves and the singles between them are every labelled
 * button Companion has. Every field optional, so an older server's answer still
 * renders.
 */
interface CompanionPairsReply {
  customVariables?: string[];
  pairs?: { on?: OfferedButton; off?: OfferedButton }[];
  buttons?: OfferedButton[];
}

function CueStateFields({
  params,
  base,
  toggle,
  customVariables,
  inferred,
  onChange,
}: {
  params: Record<string, string | number>;
  base: string;
  /** Both halves press the same Companion button. See isTogglePair. */
  toggle: boolean;
  customVariables: string[];
  /** Where this pair's own button says its device reports state, or null. */
  inferred: InferredStateSource | null;
  onChange: (patch: Record<string, string>) => void;
}) {
  const binding = stateBindingOf(params);
  const variable = String(params.stateVariable ?? "");
  // A variable that is bound but no longer in Companion's export — renamed or
  // deleted — is still offered, so the select shows what the rule actually says.
  // The INFERRED one is offered too and labelled, because on a Companion with
  // no custom variables it is the only thing there is to pick.
  const options = [...new Set([...customVariables, ...(variable ? [variable] : [])])].sort();
  const offered = [
    ...(inferred && !options.includes(inferred.variable)
      ? [{ value: inferred.variable, text: `${inferred.variable} (inferred)` }]
      : []),
    ...options.map((name) => ({
      value: name,
      text: name === inferred?.variable ? `${name} (inferred)` : name,
    })),
  ];

  /**
   * Write the whole binding, all three params, through the module that owns the
   * keys.
   *
   * The select used to patch `stateVariable` alone. Clearing it therefore left
   * `stateOnValue` and `stateOffValue` behind, so a pair unbound and later bound
   * to a different variable inherited the values typed for the old one — a
   * switch reporting on for a device that is off, with nothing on screen saying
   * where "POWER=ON" came from. The raw values are carried across rather than
   * `binding`'s: `binding` resolves a blank to the default, and writing "on"
   * and "off" out explicitly would turn a field the operator left alone into
   * one they had filled in.
   */
  const setVariable = (next: string) =>
    onChange(
      stateBindingParams(
        next.trim()
          ? // Picking the INFERRED variable brings its two values with it. A kasa
            // plug's `power_state` holds `On`, not `on`, and the comparison is
            // case-sensitive — chosen without them the pair reads unknown
            // forever, with the field on screen looking right.
            next.trim() === inferred?.variable
            ? inferred
            : {
                variable: next,
                onValue: String(params.stateOnValue ?? ""),
                offValue: String(params.stateOffValue ?? ""),
              }
          : null,
      ),
    );
  return (
    <>
      <Row
        label="State variable"
        hint={
          // A toggle pair with nothing bound is the one case where blank is not
          // merely "optimistic": the two halves press the same key, so an
          // optimistic switch reports the opposite of the truth every other
          // press. Said on the field, where the operator can fix it.
          inferred && !binding
            ? `This pair's button drives a device that reports its own state — ${inferred.variable}. Pick it and nothing has to be built in Companion.`
            : toggle && !binding
              ? "Both halves press the same button. Without a state variable, Home Assistant cannot know which way it went."
              : `A Companion custom variable your ON/OFF buttons set, or a module's own variable as <connection label>:<name>. The generated Home Assistant switch for "${base}" then reports what the device is doing instead of what it was asked to do. Blank leaves it optimistic.`
        }
      >
        {offered.length > 0 ? (
          <Select value={variable} onValueChange={setVariable}>
            <SelectTrigger className="w-full" aria-label="State variable">
              <SelectValue placeholder="No state" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">No state</SelectItem>
              {offered.map((o) => (
                <SelectItem key={o.value} value={o.value}>{o.text}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          // Companion could not be read and nothing is bound: a text field, so
          // the binding can still be typed. Letters, digits, _, - and . are
          // refused by the server otherwise, with the reason.
          <Input
            value={variable}
            onChange={(e) => setVariable(e.target.value)}
            placeholder="projectors_state"
            aria-label="State variable"
            className="h-7 text-footnote"
          />
        )}
      </Row>
      {binding && (
        <>
          <Row label="Value meaning on" hint={`What the variable holds when it is on. Blank means "${STATE_ON_DEFAULT}".`}>
            <Input
              value={String(params.stateOnValue ?? "")}
              onChange={(e) => onChange({ stateOnValue: e.target.value })}
              placeholder={STATE_ON_DEFAULT}
              aria-label="Value meaning on"
              className="h-7 text-footnote"
            />
          </Row>
          {/* The `*` sentinel is named on the OFF field only, because that is
              the only field it is legal on — the server refuses it as the on
              value. A status variable with several answers (a recorder's
              transport, say) is bound by spelling out the on value and leaving
              the rest to `*`. */}
          <Row
            label="Value meaning off"
            hint={
              `What the variable holds when it is off. Blank means "${STATE_OFF_DEFAULT}"; ` +
              `"${STATE_ANY_OTHER}" means anything else — any value that is not the on value.`
            }
          >
            <Input
              value={String(params.stateOffValue ?? "")}
              onChange={(e) => onChange({ stateOffValue: e.target.value })}
              placeholder={STATE_OFF_DEFAULT}
              aria-label="Value meaning off"
              className="h-7 text-footnote"
            />
          </Row>
        </>
      )}
    </>
  );
}

function RuleCard({
  rule,
  registry,
  dynamicOptions,
  pairBase,
  pairIsToggle,
  cueState,
  customVariables,
  inferredSource,
  onChanged,
}: {
  rule: Rule;
  registry: Registry;
  dynamicOptions: Record<string, { value: string; label: string }[]>;
  /** The pair's base when this rule is its `_on` half, else null. */
  pairBase: string | null;
  /** This rule's pair presses one button both ways. See isTogglePair. */
  pairIsToggle: boolean;
  /** This pair's state, when it has a binding and the route answered. */
  cueState: CueStateRow | null;
  customVariables: string[];
  /** Where this rule's own Companion button says its device reports state. */
  inferredSource: InferredStateSource | null;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Rule>(rule);
  const [busy, setBusy] = useState(false);

  useResyncOn([rule], () => setDraft(rule));

  const formerNames = rule.trigger.id === CALL_TRIGGER_ID ? parseAliases(rule.trigger.params) : [];
  const trigger = registry.triggers.find((t) => t.id === draft.trigger.id) ?? null;
  const action = registry.actions.find((a) => a.id === draft.action.id) ?? null;
  const dirty = JSON.stringify(draft) !== JSON.stringify(rule);

  const summary = `When ${trigger?.label ?? draft.trigger.id}` +
    (draft.conditions.length ? ` · if ${draft.conditions.length} condition${draft.conditions.length > 1 ? "s" : ""}` : "") +
    ` · then ${action?.label ?? draft.action.id}`;

  async function save() {
    setBusy(true);
    try {
      await invoke("automation:updateRule", { id: rule.id, patch: draft });
      onChanged();
    } catch (e) {
      // The server refuses a duplicate or malformed cue name with a 400. Without
      // this the rejection was an unhandled rejection and the editor just sat
      // there with the operator's change still on screen, apparently saved.
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function testFire() {
    try {
      const r = await invoke<{ ok: boolean; detail: string }>("automation:testRule", { id: rule.id });
      if (r.ok) toast.success(`Test fire: ${r.detail}`);
      else toast.error(`Test fire failed: ${r.detail}`);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  return (
    <div className="rounded-lg border border-line bg-surface p-3">
      <div className="flex items-center gap-2">
        <Switch
          checked={rule.enabled}
          onCheckedChange={async (v) => {
            await invoke("automation:updateRule", { id: rule.id, patch: { enabled: v } });
            onChanged();
          }}
          aria-label="Enable rule"
        />
        <button
          type="button"
          className="min-w-0 flex-1 text-left"
          onClick={() => setOpen((o) => !o)}
        >
          <div className="flex min-w-0 items-baseline gap-2">
            <span data-rule-name={rule.name} className="truncate text-footnote font-medium text-fg">{rule.name}</span>
            {/* The names this cue used to answer to, quietly. A cue is renamed
                when its Companion button is relabelled, and the old name stays
                live — so this is the only place the rules list says that the URL
                in somebody's Home Assistant config is not the name on the row. */}
            {/* `min-w-0` with a cap, not `shrink-0`: a shrink-0 box cannot
                truncate — it takes whatever width its text wants and crushes
                the rule name beside it, which is the one thing on the row that
                has to stay readable. Five former names is the maximum
                (cue-aliases.ts), and five names is wider than most rule names.
                Not unit-tested: jsdom loads no stylesheet, so a width and a
                truncation are not observable in it at all, and asserting the
                class string would only say the class is spelled how it is
                spelled. Driven in a browser. */}
            {formerNames.length > 0 && (
              <span
                data-cue-former-names={formerNames.join(",")}
                className="min-w-0 max-w-[40%] truncate text-caption2 text-fg-subtle"
              >
                was {formerNames.join(", ")}
              </span>
            )}
            {rule.trigger.id === CALL_TRIGGER_ID && <ServiceGuardBadge conditions={rule.conditions} />}
          </div>
          <div className="truncate text-caption1 text-fg-muted">{summary}</div>
          {/* What the last reconcile found about this rule's Companion button.
              Inside the row's own button, so the way to act on a `button
              missing` pill is to press the thing saying it — which opens the
              editor and its picker. Renders nothing for any other action, and
              nothing for a rule that has never been reconciled. */}
          {rule.action.id === "companion.press" && <CueButtonStatus params={rule.action.params} />}
          {/* What the device is actually doing, for a pair bound to a Companion
              custom variable. Inside the row's own button like the status pill
              above, so pressing the thing saying `unknown` opens the editor
              that can fix it. */}
          {cueState && pairBase !== null && <CuePairState base={pairBase} state={cueState} />}
        </button>
        <Button variant="transparent" size="small" onClick={() => void testFire()} aria-label="Test fire">
          <PlayIcon className="size-3.5" /> Test
        </Button>
        <Button
          variant="transparent"
          size="small"
          iconOnly
          aria-label="Delete rule"
          onClick={async () => {
            await invoke("automation:removeRule", { id: rule.id });
            onChanged();
          }}
        >
          <Trash2Icon className="size-3.5 text-red-10" />
        </Button>
      </div>

      {open && (
        <div className="mt-3 flex flex-col gap-1 border-t border-line pt-3">
          <Row label="Name">
            <Input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              className="h-7 text-footnote"
            />
          </Row>

          <Separator />
          <span className="pt-1 text-caption2 font-semibold uppercase tracking-wider text-fg-muted">When</span>
          <Row label="Trigger">
            <select
              className={selectCls}
              value={draft.trigger.id}
              onChange={(e) => setDraft({ ...draft, trigger: { id: e.target.value, params: {} } })}
            >
              {registry.triggers.map((t) => (
                <option key={t.id} value={t.id}>{t.label}</option>
              ))}
            </select>
          </Row>
          {trigger?.params
            // `aliases` is a list, not a string to type. It renders below as one
            // chip per former name with a remove — a text field over a
            // comma-joined list of live URLs is a typo away from a switch in
            // Home Assistant that stops resolving.
            // `aliases` is a list; the three `state*` params are rendered by
            // CueStateFields below, and only for the `_on` half of a pair. Three
            // text fields on every cue that cannot use them would read as three
            // settings that do nothing.
            .filter((p) => p.key !== "aliases" && !p.key.startsWith("state"))
            .map((p) => (
              <ParamField
                key={p.key}
                spec={p}
                value={draft.trigger.params[p.key]}
                dynamicOptions={dynamicOptions}
                onChange={(v) => setDraft({ ...draft, trigger: { ...draft.trigger, params: { ...draft.trigger.params, [p.key]: v } } })}
              />
            ))}
          {draft.trigger.id === CALL_TRIGGER_ID && (
            <FormerNamesField
              params={draft.trigger.params}
              onChange={(aliases) =>
                setDraft({ ...draft, trigger: { ...draft.trigger, params: { ...draft.trigger.params, aliases } } })
              }
            />
          )}
          {draft.trigger.id === CALL_TRIGGER_ID && pairBase !== null && (
            <CueStateFields
              params={draft.trigger.params}
              base={pairBase}
              toggle={pairIsToggle}
              customVariables={customVariables}
              inferred={inferredSource}
              onChange={(patch) =>
                setDraft({ ...draft, trigger: { ...draft.trigger, params: { ...draft.trigger.params, ...patch } } })
              }
            />
          )}

          <Separator />
          <span className="pt-1 text-caption2 font-semibold uppercase tracking-wider text-fg-muted">If</span>
          {/* The single switch over `service.is-not-live`, for a cue only — the
              condition means nothing on a rule with any other trigger. A view
              on the condition below, not a replacement for it: the condition
              is still there in the list and still removable by hand. */}
          {draft.trigger.id === CALL_TRIGGER_ID && (
            <ServiceGuardField
              conditions={draft.conditions}
              onChange={(conditions) => setDraft({ ...draft, conditions })}
            />
          )}
          {draft.conditions.length === 0 && (
            <p className="text-caption1 text-fg-subtle">No conditions — the rule fires whenever its trigger does.</p>
          )}
          {draft.conditions.map((c, i) => {
            const spec = registry.conditions.find((x) => x.id === c.id);
            return (
              <div key={`${c.id}-${i}`} className="rounded-md border border-line px-2 py-1">
                <div className="flex items-center gap-2">
                  <span className="flex-1 text-caption1 text-fg">{spec?.label ?? c.id}</span>
                  <Button
                    variant="transparent"
                    size="small"
                    iconOnly
                    aria-label="Remove condition"
                    onClick={() => setDraft({ ...draft, conditions: draft.conditions.filter((_, j) => j !== i) })}
                  >
                    <Trash2Icon className="size-3.5 text-fg-subtle" />
                  </Button>
                </div>
                {spec?.params.map((p) => (
                  <ParamField
                    key={p.key}
                    spec={p}
                    value={c.params[p.key]}
                    dynamicOptions={dynamicOptions}
                    onChange={(v) => {
                      const next = [...draft.conditions];
                      next[i] = { ...c, params: { ...c.params, [p.key]: v } };
                      setDraft({ ...draft, conditions: next });
                    }}
                  />
                ))}
              </div>
            );
          })}
          <Row label="Add condition">
            <select
              className={selectCls}
              value=""
              onChange={(e) => {
                if (!e.target.value) return;
                setDraft({ ...draft, conditions: [...draft.conditions, { id: e.target.value, params: {} }] });
              }}
            >
              <option value="">Add…</option>
              {registry.conditions.map((c) => (
                <option key={c.id} value={c.id}>{c.label}</option>
              ))}
            </select>
          </Row>

          <Separator />
          <span className="pt-1 text-caption2 font-semibold uppercase tracking-wider text-fg-muted">Then</span>
          <Row label="Action">
            <select
              className={selectCls}
              value={draft.action.id}
              onChange={(e) => setDraft({ ...draft, action: { id: e.target.value, params: {} } })}
            >
              {registry.actions.map((a) => (
                <option key={a.id} value={a.id}>{a.label}</option>
              ))}
            </select>
          </Row>
          {/* One action renders its own params: three coordinates are not
              something an operator can be expected to know, so companion.press
              gets a picker that fills them in. The fields stay visible and
              editable — the picker is a convenience over the same params, not a
              replacement for them, which is what keeps a button that is not in
              Companion's export reachable. */}
          {draft.action.id === "companion.press" ? (
            <CompanionPressFields
              params={draft.action.params}
              onChange={(patch) =>
                setDraft({ ...draft, action: { ...draft.action, params: { ...draft.action.params, ...patch } } })
              }
            />
          ) : (
            action?.params.map((p) => (
              <ParamField
                key={p.key}
                spec={p}
                value={draft.action.params[p.key]}
                dynamicOptions={dynamicOptions}
                onChange={(v) => setDraft({ ...draft, action: { ...draft.action, params: { ...draft.action.params, [p.key]: v } } })}
              />
            ))
          )}

          <Separator />
          <Row
            label="Cooldown"
            hint="Seconds before this rule may fire again. Stops a value that oscillates across a threshold firing repeatedly."
          >
            <NumberInput
              value={draft.cooldownSec}
              min={0}
              max={86400}
              onChange={(n) => setDraft({ ...draft, cooldownSec: n })}
              className="h-7 text-footnote"
            />
          </Row>
          <Row label="Once per service" hint="Fire at most once per PCO service occurrence.">
            <Switch
              checked={draft.oncePerService}
              onCheckedChange={(v) => setDraft({ ...draft, oncePerService: v })}
              aria-label="Once per service"
            />
          </Row>
          {/* Only for a called cue: there is nothing to confirm to when a rule
              fires itself off a state change, and a switch that did nothing on
              every other rule would be worse than absent. */}
          {draft.trigger.id === CALL_TRIGGER_ID && (
            <Row
              label="Ask twice"
              hint="The first call is answered with a confirmation and does nothing. A second call within 30 seconds runs it."
            >
              <Switch
                checked={draft.confirmRequired === true}
                onCheckedChange={(v) => setDraft({ ...draft, confirmRequired: v })}
                aria-label="Ask twice before running"
              />
            </Row>
          )}

          {dirty && (
            <div className="flex items-center gap-2 pt-2">
              <Button variant="accent" size="small" onClick={() => void save()} disabled={busy}>
                {busy ? "Saving…" : "Save"}
              </Button>
              <Button variant="transparent" size="small" onClick={() => setDraft(rule)} disabled={busy}>
                Discard
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Section ───────────────────────────────────────────────────────────────────

export function AutomationSection() {
  const qc = useQueryClient();
  const [importing, setImporting] = useState(false);
  const { data: registry } = useQuery({
    queryKey: ["automation:registry"],
    queryFn: () => invoke<Registry>("automation:registry"),
  });
  const { data } = useQuery({
    queryKey: ["automation:rules"],
    queryFn: () => invoke<{ rules: Rule[]; settings: { simulate: boolean; disarmed: boolean } }>("automation:rules"),
  });
  const refresh = useCallback(() => void qc.invalidateQueries({ queryKey: ["automation:rules"] }), [qc]);
  useEffect(() => onNotification("automation:rules", refresh), [refresh]);
  useEffect(() => onNotification("automation:settings", refresh), [refresh]);

  // Runtime option sources, so a param declaring optionsFrom resolves to real things.
  const { data: rt } = useQuery({
    queryKey: ["rosstalk:targets"],
    queryFn: () => invoke<{ targets: { id: string; name: string }[] }>("rosstalk:targets"),
  });
  const { data: rtCmds } = useQuery({
    queryKey: ["rosstalk:commands"],
    queryFn: () => invoke<{ id: string; label: string }[]>("rosstalk:commands"),
  });
  const { data: planItems } = useQuery({
    queryKey: ["automation:plan-items"],
    queryFn: () => invoke<{ items: { value: string; label: string }[] }>("automation:plan-items"),
  });
  const dynamicOptions = useMemo(
    () => ({
      "rosstalk-targets": (rt?.targets ?? []).map((t) => ({ value: t.id, label: t.name })),
      "rosstalk-commands": (rtCmds ?? []).map((c) => ({ value: c.id, label: c.label })),
      "plan-items": planItems?.items ?? [],
    }),
    [rt, rtCmds, planItems],
  );

  // Memoised because the pair resolution below depends on it: `data?.rules ?? []`
  // is a new array on every render, which would re-resolve every pair each time.
  const rules = useMemo(() => data?.rules ?? [], [data]);
  const settings = data?.settings ?? { simulate: true, disarmed: false };

  // The ON/OFF pairs among the rules, resolved by the same module the server
  // generates the Home Assistant config from — so the row that offers a state
  // binding is exactly the row that would get one.
  const pairs = useMemo(() => cuePairs(rules), [rules]);
  // The `_on` half's rule id to its pair's base, which is what decides both the
  // row's state pill and whether the editor offers the three state fields at
  // all: a binding on a cue with no partner reads a variable nothing ever shows,
  // so it is not offered there rather than offered and ignored. One Map over the
  // resolved pairs rather than a per-row lookup — 200 rules asking "am I half of
  // a pair" is 200 passes over the whole rules list on every render.
  const pairBases = useMemo(
    () => new Map(pairs.map((p) => [p.on.id, p.base] as const)),
    [pairs],
  );
  // The `_on` halves whose pair presses ONE button both ways — an imported
  // toggle, or two cues somebody pointed at the same key. The state variable is
  // the only thing that can tell those two directions apart, so the field says
  // so when there is none.
  const togglePairs = useMemo(
    () => new Set(pairs.filter((p) => isTogglePair(p)).map((p) => p.on.id)),
    [pairs],
  );
  const anyBinding = useMemo(() => pairs.some((p) => p.binding !== null), [pairs]);

  // The search field's value, in component state only — it is a filter over
  // what is on screen right now, not something a maintainer with hundreds of
  // cues would want restored on the next visit.
  const [search, setSearch] = useState("");
  const filteredRules = useMemo(() => {
    if (!search.trim()) return rules;
    return rules.filter((r) =>
      ruleMatchesSearch(
        r,
        search,
        labelFor(registry?.triggers ?? [], r.trigger.id),
        labelFor(registry?.actions ?? [], r.action.id),
      ),
    );
  }, [rules, search, registry]);

  // The custom variables Companion has, for the editor's select. Read from the
  // same offer the import dialog uses, and only worth asking for when there is
  // a pair that could be bound.
  const { data: companionPairs } = useQuery({
    queryKey: ["companion:pairs"],
    queryFn: () => invoke<CompanionPairsReply>("companion:pairs"),
    enabled: pairBases.size > 0,
  });

  /**
   * Every offered button's inferred state source, keyed by its coordinates.
   *
   * Built from the SAME offer, over the union of the pairs' halves and the
   * single buttons — which between them is every labelled button Companion has.
   * A rule is matched to it by the coordinates its press action stores, so a
   * cue whose button was moved and reconciled finds the button it now presses.
   */
  const inferredByLocation = useMemo(() => {
    const out = new Map<string, InferredStateSource>();
    const add = (b: OfferedButton | undefined) => {
      if (b?.stateSource) out.set(`${b.page}:${b.row}:${b.col}`, b.stateSource);
    };
    for (const p of companionPairs?.pairs ?? []) {
      add(p.on);
      add(p.off);
    }
    for (const b of companionPairs?.buttons ?? []) add(b);
    return out;
  }, [companionPairs]);

  const inferredFor = (rule: Rule): InferredStateSource | null => {
    if (rule.action.id !== "companion.press") return null;
    const p = rule.action.params;
    return inferredByLocation.get(`${Number(p.page)}:${Number(p.row)}:${Number(p.col)}`) ?? null;
  };

  /**
   * Every bound pair's real state, while this page is OPEN.
   *
   * react-query's `refetchInterval` stops when the component unmounts, which is
   * the whole gate: leave the Automation page and nothing polls Companion. The
   * query is not enabled at all until some pair has a binding, so an install
   * that does not use this never asks.
   */
  const { data: cueStateData, error: cueStateError } = useQuery({
    queryKey: ["cues:states"],
    queryFn: () => invoke<{ states: Record<string, CueStateRow> }>("cues:states"),
    enabled: anyBinding,
    refetchInterval: 10_000,
  });

  async function setSettings(patch: Record<string, boolean>) {
    await invoke("automation:setSettings", patch);
    refresh();
  }

  return (
    // The same wrapper every other section uses. This one had no horizontal or
    // vertical padding at all, so its cards ran to the pane edges while every
    // neighbouring tab inset them.
    <div className="flex flex-col gap-4 pt-5 max-sm:pt-4 pb-[50vh] max-sm:pb-24">
      {/* No title here — the shell renders the page heading and its blurb from
          SECTION_DESC, same as every other section. A local h1 duplicated it. */}

      {/* Safety first: these are the controls that decide whether anything real happens. */}
      <div
        className={
          "flex flex-col gap-2 rounded-lg border p-3 " +
          (settings.disarmed
            ? "border-red-6 bg-red-2/50"
            : settings.simulate
              ? "border-amber-6 bg-amber-2/60"
              : "border-line bg-surface")
        }
      >
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-footnote font-medium text-fg">Simulate mode</div>
            <p className="mt-0.5 text-caption1 text-fg-muted">
              {settings.simulate
                ? "Rules evaluate and log what they would do. Nothing reaches a device."
                : "Rules act on your devices."}
            </p>
          </div>
          <Switch
            checked={settings.simulate}
            onCheckedChange={(v) => void setSettings({ simulate: v })}
            aria-label="Simulate mode"
          />
        </div>
        <Separator />
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-footnote font-medium text-fg">
              {settings.disarmed ? "All rules disarmed" : "Rules armed"}
            </div>
            <p className="mt-0.5 text-caption1 text-fg-muted">
              {settings.disarmed
                ? "No rule will run, whatever its own switch says."
                : "Use this to stop everything at once."}
            </p>
          </div>
          <Button
            variant={settings.disarmed ? "accent" : "filled"}
            size="small"
            onClick={() => void setSettings({ disarmed: !settings.disarmed })}
          >
            <OctagonXIcon className="size-3.5" />
            {settings.disarmed ? "Re-arm" : "Disarm all"}
          </Button>
        </div>
      </div>

      {registry && (
        <div className="flex flex-col gap-2">
          {/* The route itself failed — not a pair reading unknown, which has its
              own pill and its own reason. Without this the pills simply stopped
              appearing, which looks exactly like a set of pairs with no
              bindings. One muted line, above the list, because it is about all
              of them at once; the pills are left alone rather than turned amber,
              since nothing was read and a pill would be a guess. */}
          {cueStateError !== null && anyBinding && (
            <p className="text-caption1 text-fg-muted" data-cue-state-error="">
              Cue state unavailable: {errorMessage(cueStateError)}
            </p>
          )}
          {rules.length === 0 ? (
            <p className="text-caption1 text-fg-muted">
              No rules yet. Start with the <span className="font-medium text-fg">Write a log message</span> action —
              arm the rule, watch Activity through a service to confirm it fires when you expect, then swap in the
              real action.
            </p>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <span className="relative min-w-0 flex-1">
                  <SearchIcon className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-fg-subtle" />
                  <Input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search rules"
                    aria-label="Search rules"
                    className="h-8 pl-7 text-footnote"
                  />
                </span>
                {search.trim() && (
                  <span className="shrink-0 text-caption1 text-fg-muted" data-rule-search-count="">
                    {filteredRules.length} of {rules.length} rules
                  </span>
                )}
              </div>
              {filteredRules.length === 0 ? (
                <p className="text-caption1 text-fg-muted">No rules match.</p>
              ) : (
                filteredRules.map((r) => (
                  <RuleCard
                    key={r.id}
                    rule={r}
                    registry={registry}
                    dynamicOptions={dynamicOptions}
                    pairBase={pairBases.get(r.id) ?? null}
                    pairIsToggle={togglePairs.has(r.id)}
                    cueState={cueStateFor(cueStateData?.states, pairBases.get(r.id) ?? null)}
                    customVariables={companionPairs?.customVariables ?? []}
                    inferredSource={inferredFor(r)}
                    onChanged={refresh}
                  />
                ))
              )}
            </>
          )}
          <div className="flex items-center gap-2">
            <Button
              variant="filled"
              size="small"
              onClick={async () => {
                await invoke("automation:addRule", {
                  name: `Rule ${rules.length + 1}`,
                  enabled: false,
                  trigger: { id: registry.triggers[0]?.id ?? "", params: {} },
                  conditions: [],
                  action: { id: "log.message", params: { message: "rule matched" } },
                  cooldownSec: 30,
                  oncePerService: false,
                });
                refresh();
              }}
            >
              <PlusIcon className="size-3.5" /> Add rule
            </Button>
            <Button variant="transparent" size="small" onClick={() => setImporting(true)}>
              <DownloadIcon className="size-3.5" /> Import from Companion…
            </Button>
          </div>
        </div>
      )}

      <ImportPairsDialog open={importing} onOpenChange={setImporting} onImported={refresh} />
      <CueAccessCard />
      <ActivityLog />
    </div>
  );
}
