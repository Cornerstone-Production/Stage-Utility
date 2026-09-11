// The rule editor, as a dialog over the rules list.
//
// A rule is edited in a MODAL, not by expanding its row: the editor is thirty
// fields tall, and expanding it in place pushed the rest of the list — and the
// search field's own results — off the screen. The list and the search field
// stay exactly where they are while one rule is edited.
//
// A PAIR IS ONE DIALOG. `cue-pairs.ts` says a pair is one thing — one switch in
// Home Assistant, one thing an operator turns on and off — so its dialog shows
// the settings that belong to the PAIR once (Home Assistant, allowed during a
// service, state variable, room), and a Turn on / Turn off control for the
// fields that genuinely differ between the two halves (cue name, what it says,
// which button it presses). Two stacked editors, which is what this replaced,
// asked the operator to know which of the two identical-looking forms owned
// each setting.
//
// The field components below are MOVED here from automation-section.tsx
// unchanged: the rules list still renders the collapsed row, and the editor is
// only ever mounted by this dialog, so the two files split along that line.

import { errorMessage } from "@main/services/errors";
import { CALL_TRIGGER_ID, encodeAliases, parseAliases } from "@main/services/cue-aliases";
import {
  APP_STATE_SOURCES,
  appStateRef,
  appStateSourceDef,
  isAppStateRef,
} from "@main/services/app-state-sources";
import {
  homeVisibilityParams,
  implicitStateBinding,
  isHiddenFromHome,
  stateBindingOf,
  stateBindingParams,
  STATE_ANY_OTHER,
  STATE_OFF_DEFAULT,
  STATE_ON_DEFAULT,
} from "@main/services/cue-pairs";
import type { InferredStateSource } from "@main/services/companion-state-source";
import {
  LEARN_MAX_ATTEMPTS,
  learnAgainParams,
  learningHint,
  parseCandidates,
  parseLearning,
} from "@main/services/companion-state-learn";
import { hasServiceGuard, withServiceGuard } from "@main/services/service-guard";
import { useEffect, useRef, useState } from "react";
import { PlayIcon, PlusIcon, Trash2Icon } from "lucide-react";

import { invoke } from "../../lib/api";
import {
  Button,
  confirm,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogRoot,
  DialogTitle,
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
import { CompanionPressFields } from "./companion-cues";

// ── Registry shapes (functions are stripped server-side) ──────────────────────

export interface ParamSpec {
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
export interface Spec {
  id: string;
  label: string;
  params: ParamSpec[];
  help?: string;
}
export interface Registry {
  triggers: (Spec & { channel: string })[];
  conditions: Spec[];
  actions: Spec[];
}

export interface Rule {
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

/**
 * One ON/OFF pair as the rules list shows it: ONE row, holding both halves.
 *
 * `name` is the words the pair is called — a switch in Home Assistant is called
 * this, and so is the row.
 */
export interface PairRowData {
  base: string;
  name: string;
  onName: string;
  offName: string;
  hidden: boolean;
  on: Rule;
  off: Rule;
}

/** One bound pair's state, as `GET /api/cues/states` sends it. */
export interface CueStateRow {
  on: string;
  off: string;
  variable: string;
  value: string | null;
  state: "on" | "off" | "unknown";
  reason?: string;
  /** True for up to eight seconds after a press, while `state` may still be
   *  the pre-press reading — see `main/services/cue-states.ts`. */
  settling?: true;
  /** What that press asked for. Present exactly when `settling` is. */
  commanded?: "on" | "off";
}

// ── Shared row helpers, matching the layout inspector's shape ─────────────────

export function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
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
 * What a bound pair's device is actually doing, on the pair's row and in the
 * header of its dialog.
 *
 * Renders nothing at all for an unbound pair or a cue that is not half of one —
 * an "unknown" pill on every rule in the list would be noise nobody could act
 * on.
 */
export function CuePairState({ base, state }: { base: string; state: CueStateRow }) {
  // While settling, `commanded` is what the press asked for and is shown
  // instead of `state` — `state` may still be the pre-press reading for up to
  // eight seconds (see the settle window in main/services/cue-states.ts), and
  // it is never `unknown` because a press always commands `on` or `off`.
  const shown = state.settling ? state.commanded : state.state;
  const variant = shown === "on" ? "success" : shown === "off" ? "neutral" : "warning";
  const title = state.settling
    ? "Pressed just now; the device has not reported back yet"
    : state.reason
      ? `${state.variable}: ${state.reason}`
      : state.variable;
  return (
    <span
      className="flex min-w-0 items-center gap-1.5"
      // The pair, always, beside the word. `data-cue-state` alone is not enough
      // to see a pill that should not be there: a row that took its state off
      // the prototype chain rendered a dot with no word AND no state attribute,
      // so nothing could count it.
      data-cue-pair={base}
      data-cue-state={shown}
      // The reason on hover rather than on the row: it is a sentence, and the
      // row already carries the rule name and the summary. While settling it
      // is replaced with a note that the reading below it is stale.
      title={title}
    >
      <Status variant={variant}>{state.settling ? `${shown}…` : shown}</Status>
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
  allowed,
  onChange,
}: {
  allowed: boolean;
  onChange: (allowed: boolean) => void;
}) {
  return (
    <Row
      label="Allowed during a service"
      hint='Off: refused while a service is live or about to start (the imported default). On: fires whenever it is called.'
    >
      <Switch
        checked={allowed}
        onCheckedChange={onChange}
        aria-label="Allowed during a service"
      />
    </Row>
  );
}

/**
 * The one switch over `homeAssistant` — see cue-pairs.ts for what it stores.
 *
 * The sentence beside it names the entity that exists, because "hidden" and
 * "shown" on their own do not say what appears where: a pair is ONE switch in
 * Home Assistant and in Apple Home, not two buttons.
 */
function HomeVisibilityField({
  hidden,
  pairName,
  onChange,
}: {
  hidden: boolean;
  /** The words a switch for this pair is called, or null for a single cue. */
  pairName: string | null;
  onChange: (hidden: boolean) => void;
}) {
  const shownText =
    pairName === null
      ? "Shown as a button in Home Assistant and Apple Home."
      : `Shown. One switch, ${pairName}, in Home Assistant and Apple Home.`;
  return (
    <Row label="Home Assistant">
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="flex items-center gap-2">
          <Switch
            checked={!hidden}
            onCheckedChange={(v) => onChange(!v)}
            aria-label="Shown in Home Assistant"
          />
          <span className="min-w-0 text-caption1 text-fg-muted" data-cue-home={hidden ? "hidden" : "shown"}>
            {hidden ? "Hidden. Voice only." : shownText}
          </span>
        </span>
        <span className="text-caption2 text-fg-subtle">
          Turn off to keep this cue voice-only. It disappears from Home Assistant within a few
          seconds; automations there that refer to it stop working.
        </span>
      </span>
    </Row>
  );
}

/**
 * The stored form of an app source, with the two values it reports.
 *
 * Written out rather than left blank: blank means "the defaults", and a source
 * whose values are not `on`/`off` would then be compared against the wrong two
 * strings with the field on screen looking right — the same trap the inferred
 * Companion source has.
 */
function appBindingFor(ref: string): { variable: string; onValue: string; offValue: string } | null {
  const def = appStateSourceDef(ref);
  return def ? { variable: ref, onValue: def.onValue, offValue: def.offValue } : null;
}

/**
 * The state-binding fields. A PAIR'S, not a half's — a binding on a cue with no
 * partner reads a variable nothing ever shows, so the fields are not offered
 * there at all rather than offered and ignored.
 *
 * The variable is a SELECT of what Companion has, with a text field as well
 * whenever the export could not be read — otherwise an unreachable Companion
 * would mean an existing binding could not even be seen, let alone cleared.
 */
function CueStateFields({
  params,
  base,
  toggle,
  customVariables,
  inferred,
  onAction,
  appSources,
  onChange,
}: {
  params: Record<string, string | number>;
  base: string;
  /** Both halves press the same Companion button. See isTogglePair. */
  toggle: boolean;
  customVariables: string[];
  /** Where this pair's own button says its device reports state, or null. */
  inferred: InferredStateSource | null;
  /** The ON half's action as it stands in the draft — what implies a binding. */
  onAction: Rule["action"];
  /** App state sources whose integration is set up, so there is something to read. */
  appSources: string[];
  onChange: (patch: Record<string, string>) => void;
}) {
  const binding = stateBindingOf(params);
  const variable = String(params.stateVariable ?? "");
  // What this pair's own action implies, when nothing is stored. The SAME
  // function the server binds with — a second copy of "a Record cue reads
  // app:reaper.recording" is how the editor and the switch come to disagree.
  const implicit = binding ? null : implicitStateBinding(onAction);
  /** What is being read, stored or implied. */
  const effective = binding?.variable ?? implicit?.variable ?? "";
  /** An app source needs no values: it reports exactly `on` and `off`. */
  const fromApp = isAppStateRef(effective);
  /** The source's own one-liner, or null when this is not an app source. */
  const appHint = appStateSourceDef(effective)?.hint ?? null;
  // What learning has found and how far it got. A pair whose connections the
  // verified table has no row for is probed by the reconcile and BOUND from
  // watching a press, so the field has something to say with nothing picked and
  // nothing inferred. See companion-state-learn.ts.
  const candidates = parseCandidates(params);
  const learning = parseLearning(params);
  const learnable = candidates.length > 0 || learning.stopped !== undefined;
  // A variable that is bound but no longer in Companion's export — renamed or
  // deleted — is still offered, so the select shows what the rule actually says.
  // The INFERRED one is offered too and labelled, because on a Companion with
  // no custom variables it is the only thing there is to pick.
  const options = [...new Set([...customVariables, ...(variable ? [variable] : [])])]
    .filter((name) => !isAppStateRef(name))
    .sort();
  // APP SOURCES FIRST. They are read from an integration this app is already
  // talking to, so there is nothing to build in Companion for them — and the
  // implied one has to be offered whatever the integration list says, or the
  // select would show a value that is not among its options.
  const appOffered = [...APP_STATE_SOURCES].flatMap(([id, def]) => {
    const ref = appStateRef(id);
    return appSources.includes(ref) || effective === ref ? [{ value: ref, text: def.label }] : [];
  });
  const offered = [
    ...appOffered,
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
            : // An APP source reports exactly two values and this app knows
              // which — written out, so the pair is not left comparing against
              // whatever was typed for the variable it used to read.
              appBindingFor(next.trim()) ?? {
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
          // An APP SOURCE first: there is nothing to set up for it, and the
          // Companion wording below would send an operator to build a custom
          // variable this pair will never read.
          //
          // Then the toggle case, which is the one where blank is not merely
          // "optimistic": the two halves press the same key, so an optimistic
          // switch reports the opposite of the truth every other press. Said on
          // the field, where the operator can fix it.
          appHint ??
          (inferred && !binding
            ? `This pair's button drives a device that reports its own state — ${inferred.variable}. Pick it and nothing has to be built in Companion.`
            : toggle && !binding
              ? "Both halves press the same button. Without a state variable, Home Assistant cannot know which way it went."
              : `A Companion custom variable your ON/OFF buttons set, or a module's own variable as <connection label>:<name>. The generated Home Assistant switch for "${base}" then reports what the device is doing instead of what it was asked to do. Blank leaves it optimistic.`)
        }
      >
        {offered.length > 0 ? (
          // `effective`, not `variable`: an IMPLIED binding is shown as selected
          // even though nothing is stored, because it is what the switch really
          // reads. Choosing anything else — including "No state" — stores that
          // and the implication stops applying.
          <Select value={effective} onValueChange={setVariable}>
            <SelectTrigger className="w-full" aria-label="State variable">
              <SelectValue placeholder="No state" />
            </SelectTrigger>
            <SelectContent>
              {/* NOT offered while a binding is implied: there is nothing to
                  clear, so a "No state" that re-rendered as the app source
                  would be a control that visibly does nothing. */}
              {!implicit && <SelectItem value="">No state</SelectItem>}
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
      {/* LEARNING, as a VISIBLE line rather than a hover hint. Nothing in the
          verified table covers what this pair drives, so its state source is
          being learned from what moves when it is pressed — and a blank State
          variable with no explanation beside it reads as "this pair cannot
          report its state", which is the opposite of what is about to happen.
          A tooltip nobody hovers is not an explanation. */}
      {learnable && (
        <Row
          label="Learning"
          hint="Forget what was learned about this pair and probe its connections again on the next hourly pass. The binding above is left alone."
        >
          <span className="flex items-center gap-2">
            <span className="min-w-0 flex-1 text-caption1 text-fg-subtle">
              {learning.stopped === "gave-up"
                ? `Learning gave up after ${LEARN_MAX_ATTEMPTS} presses — nothing this pair drives moved in both directions. Pick a variable, or start again.`
                : learning.stopped === "bound"
                  ? "Learned from watching this pair being pressed."
                  : learningHint(candidates)}
            </span>
            {/* CLEARING A BINDING deliberately does NOT restart learning — an
                operator who unbound a pair on purpose would otherwise have it
                re-probed and re-bound within the hour — so this is the one
                control that starts it over. */}
            <Button
              type="button"
              variant="transparent"
              className="h-7 shrink-0 text-footnote"
              onClick={() => onChange(learnAgainParams())}
            >
              Learn again
            </Button>
          </span>
        </Row>
      )}
      {/* An app source reports exactly two values, which this app writes itself,
          so there is nothing here for an operator to set. Hidden rather than
          disabled: two fields that cannot change anything are two settings that
          read as ignored. */}
      {binding && !fromApp && (
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

// ── The editor body ───────────────────────────────────────────────────────────

/** The pair-level trigger params, rendered once by the dialog and not per half. */
const PAIR_PARAM_KEYS = ["homeAssistant", "room", "stateVariable", "stateOnValue", "stateOffValue"];

/**
 * One rule's fields, in the order they have always been in.
 *
 * `pairFieldsElsewhere` is the ONE difference between a half of a pair and any
 * other rule: the pair's own settings are rendered above this, once, so they do
 * not appear twice with the two copies free to disagree.
 */
export function RuleEditorBody({
  draft,
  setDraft,
  registry,
  dynamicOptions,
  customVariables,
  appSources,
  inferredSource,
  pairBase,
  pairIsToggle,
  pairFieldsElsewhere,
}: {
  draft: Rule;
  setDraft: (next: Rule) => void;
  registry: Registry;
  dynamicOptions: Record<string, { value: string; label: string }[]>;
  customVariables: string[];
  /** App state sources whose integration is set up. See useConfiguredIntegrations. */
  appSources: string[];
  /** Where this rule's own Companion button says its device reports state. */
  inferredSource: InferredStateSource | null;
  /** The pair's base when this rule is its `_on` half, else null. */
  pairBase: string | null;
  /** This rule's pair presses one button both ways. See isTogglePair. */
  pairIsToggle: boolean;
  /** This is one half of a pair, whose shared settings are rendered above. */
  pairFieldsElsewhere: boolean;
}) {
  const trigger = registry.triggers.find((t) => t.id === draft.trigger.id) ?? null;
  const action = registry.actions.find((a) => a.id === draft.action.id) ?? null;
  const isCue = draft.trigger.id === CALL_TRIGGER_ID;

  return (
    <div className="flex flex-col gap-1">
      <Row label="Name">
        <Input
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          className="h-7 text-footnote"
          aria-label="Rule name"
        />
      </Row>
      <Row label="Enabled" hint="Off, the rule never runs — it is still called, and still logged as skipped.">
        <Switch
          checked={draft.enabled}
          onCheckedChange={(v) => setDraft({ ...draft, enabled: v })}
          aria-label="Rule enabled"
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
        // CueStateFields, and only for a pair. Three text fields on every cue
        // that cannot use them would read as three settings that do nothing.
        // On a half of a pair the pair's own params go with them.
        .filter((p) => p.key !== "aliases" && !p.key.startsWith("state"))
        .filter((p) => !(pairFieldsElsewhere && PAIR_PARAM_KEYS.includes(p.key)))
        .map((p) => (
          <ParamField
            key={p.key}
            spec={p}
            value={draft.trigger.params[p.key]}
            dynamicOptions={dynamicOptions}
            onChange={(v) => setDraft({ ...draft, trigger: { ...draft.trigger, params: { ...draft.trigger.params, [p.key]: v } } })}
          />
        ))}
      {isCue && (
        <FormerNamesField
          params={draft.trigger.params}
          onChange={(aliases) =>
            setDraft({ ...draft, trigger: { ...draft.trigger, params: { ...draft.trigger.params, aliases } } })
          }
        />
      )}
      {isCue && pairBase !== null && !pairFieldsElsewhere && (
        <CueStateFields
          params={draft.trigger.params}
          base={pairBase}
          toggle={pairIsToggle}
          customVariables={customVariables}
          inferred={inferredSource}
          onAction={draft.action}
          appSources={appSources}
          onChange={(patch) =>
            setDraft({ ...draft, trigger: { ...draft.trigger, params: { ...draft.trigger.params, ...patch } } })
          }
        />
      )}

      <Separator />
      <span className="pt-1 text-caption2 font-semibold uppercase tracking-wider text-fg-muted">If</span>
      {/* The single switch over `service.is-not-live`, for a cue only — the
          condition means nothing on a rule with any other trigger. A view on
          the condition below, not a replacement for it: the condition is still
          there in the list and still removable by hand. A pair's is above, over
          both halves at once. */}
      {isCue && !pairFieldsElsewhere && (
        <ServiceGuardField
          allowed={!hasServiceGuard(draft.conditions)}
          onChange={(allowed) => setDraft({ ...draft, conditions: withServiceGuard(draft.conditions, !allowed) })}
        />
      )}
      {isCue && !pairFieldsElsewhere && (
        <HomeVisibilityField
          hidden={isHiddenFromHome(draft.trigger.params)}
          pairName={null}
          onChange={(hidden) =>
            setDraft({
              ...draft,
              trigger: { ...draft.trigger, params: { ...draft.trigger.params, ...homeVisibilityParams(hidden) } },
            })
          }
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
      {isCue && (
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
    </div>
  );
}

// ── The dialog ────────────────────────────────────────────────────────────────

/** What the dialog is editing: one rule, or both halves of one pair. */
export type RuleEditorTarget =
  | { kind: "rule"; rule: Rule }
  | { kind: "pair"; pair: PairRowData; toggle: boolean; cueState: CueStateRow | null };

/** The pair's state binding as the SERVER reads it: the ON half, then the OFF
 *  half as a fallback. A hand-edited rules file with the binding on the off
 *  side is a setting the server honours, so the dialog has to show it —
 *  `cuePairs` in main/services/cue-pairs.ts does exactly this. Save then writes
 *  it to the ON half and clears the OFF one, so the two can only disagree by
 *  hand. */
function pairStateParams(
  onParams: Record<string, string | number>,
  offParams: Record<string, string | number>,
): Record<string, string | number> {
  if (stateBindingOf(onParams) || !stateBindingOf(offParams)) return onParams;
  return {
    ...onParams,
    stateVariable: offParams.stateVariable ?? "",
    stateOnValue: offParams.stateOnValue ?? "",
    stateOffValue: offParams.stateOffValue ?? "",
  };
}

const roomOf = (params: Record<string, string | number>): string => String(params.room ?? "").trim();

/**
 * The rule editor, over the list.
 *
 * Mounted only while something is being edited, so the drafts are seeded on
 * open and thrown away on close — Escape, the overlay and Cancel are all the
 * same discard. A failed save keeps the dialog open with the drafts intact: the
 * server refuses a duplicate or malformed cue name with a 400, and a dialog
 * that closed on that would lose the change and report success.
 */
export function RuleEditorDialog({
  target,
  onClose,
  registry,
  dynamicOptions,
  customVariables,
  appSources,
  inferredFor,
  onChanged,
}: {
  target: RuleEditorTarget;
  onClose: () => void;
  registry: Registry;
  dynamicOptions: Record<string, { value: string; label: string }[]>;
  customVariables: string[];
  appSources: string[];
  inferredFor: (rule: Rule) => InferredStateSource | null;
  onChanged: () => void;
}) {
  const isPair = target.kind === "pair";
  const [onDraft, setOnDraft] = useState<Rule>(isPair ? target.pair.on : target.rule);
  const [offDraft, setOffDraft] = useState<Rule | null>(isPair ? target.pair.off : null);
  const [half, setHalf] = useState<"on" | "off">("on");
  const [busy, setBusy] = useState(false);

  const offParams = offDraft?.trigger.params ?? {};
  const onParams = onDraft.trigger.params;
  const editingOff = half === "off" && offDraft !== null;
  const selected = editingOff ? offDraft! : onDraft;
  const setSelected = (next: Rule) => (editingOff ? setOffDraft(next) : setOnDraft(next));

  // ── The pair's own settings, read as the server reads them ──────────────────
  // Each is the ON half's with the OFF half's as a FALLBACK, which is what
  // `cuePairs` and `cue-manifest` do: a rules file hand-edited so that only the
  // off cue carries the room, the binding or the hidden flag is a pair that
  // really does have it. Shown here as the pair's, and written to the ON half
  // on save.
  const pairHidden = isHiddenFromHome(onParams) || isHiddenFromHome(offParams);
  const pairRoom = roomOf(onParams) || roomOf(offParams);
  const stateParams = pairStateParams(onParams, offParams);
  // The SERVICE GUARD is the exception: it is a condition on each rule and the
  // engine evaluates each half against its own conditions — there is no
  // fallback for it to read. So the pair is "allowed during a service" only
  // when NEITHER half carries the condition, and the switch writes BOTH halves.
  // Written to the ON half alone it would leave the off cue refusing mid-service
  // with the switch on screen saying it was allowed.
  const pairAllowed = !hasServiceGuard(onDraft.conditions) && !hasServiceGuard(offDraft?.conditions ?? []);

  const title = isPair ? target.pair.name : onDraft.name;

  function setPairParams(patch: Record<string, string>) {
    setOnDraft((d) => ({ ...d, trigger: { ...d.trigger, params: { ...d.trigger.params, ...patch } } }));
  }

  function setPairAllowed(allowed: boolean) {
    setOnDraft((d) => ({ ...d, conditions: withServiceGuard(d.conditions, !allowed) }));
    setOffDraft((d) => (d === null ? d : { ...d, conditions: withServiceGuard(d.conditions, !allowed) }));
  }

  /**
   * The ON half as it will be saved: its own fields, and the pair's settings
   * written out where the server looks for them.
   *
   * `stateParams` carries the three binding keys RAW rather than through
   * `stateBindingOf`, which resolves a blank to the default: writing "on" and
   * "off" out would turn two fields the operator left alone into two they had
   * filled in. A key is written only where the pair has something to say, so a
   * pair with no room and no hidden flag is saved without either.
   */
  function onHalfPatch(): Rule {
    if (!isPair) return onDraft;
    return {
      ...onDraft,
      trigger: {
        ...onDraft.trigger,
        params: {
          ...stateParams,
          ...(pairHidden || "homeAssistant" in onParams ? homeVisibilityParams(pairHidden) : {}),
          ...(pairRoom || "room" in onParams ? { room: pairRoom } : {}),
        },
      },
    };
  }

  /** The OFF half as it will be saved: its own fields, and none of the pair's. */
  function offHalfPatch(off: Rule): Rule {
    const params = { ...off.trigger.params };
    for (const key of PAIR_PARAM_KEYS) {
      // Only where the off half actually carries one: writing a blank key into
      // every pair's off rule would rewrite half the rules file to say nothing.
      if (String(params[key] ?? "").trim() !== "") params[key] = "";
    }
    return { ...off, trigger: { ...off.trigger, params } };
  }

  async function save() {
    setBusy(true);
    try {
      // ON FIRST. It is where the pair's settings live, so a failure on the off
      // half leaves the pair's own settings saved rather than a rules file
      // where the off half claims settings the on half no longer has.
      await invoke("automation:updateRule", { id: onDraft.id, patch: onHalfPatch() });
      if (offDraft) {
        await invoke("automation:updateRule", { id: offDraft.id, patch: offHalfPatch(offDraft) });
      }
      onChanged();
      onClose();
    } catch (e) {
      // The server refuses a duplicate or malformed cue name with a 400. The
      // dialog stays open with both drafts intact — closing here is how a
      // refused save reads as a save.
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function testFire() {
    try {
      const r = await invoke<{ ok: boolean; detail: string }>("automation:testRule", { id: selected.id });
      if (r.ok) toast.success(`Test fire: ${r.detail}`);
      else toast.error(`Test fire failed: ${r.detail}`);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  async function remove() {
    // BOTH cue names in the question. A pair is two rules and two URLs, and
    // "Delete the projectors?" does not say that `projectors_off` goes with it.
    const ok = await confirm(
      isPair
        ? {
            title: `Delete ${target.pair.name}?`,
            message: `Deletes both cues, ${target.pair.onName} and ${target.pair.offName}. Anything calling either URL stops working.`,
            confirmLabel: "Delete both",
            destructive: true,
          }
        : {
            title: `Delete ${onDraft.name}?`,
            message: "The rule and its cue URL go with it.",
            confirmLabel: "Delete",
            destructive: true,
          },
    );
    if (!ok) return;
    setBusy(true);
    try {
      await invoke("automation:removeRule", { id: onDraft.id });
      if (offDraft) await invoke("automation:removeRule", { id: offDraft.id });
      onChanged();
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const halfLabel = half === "on" ? "turn on" : "turn off";

  return (
    <DialogRoot
      open
      onOpenChange={(o) => {
        // Escape and the overlay are a DISCARD, the same as Cancel: the drafts
        // live in this component and go with it.
        if (!o) onClose();
      }}
    >
      <DialogContent className="max-w-2xl" data-rule-editor={isPair ? target.pair.base : onDraft.id}>
        <DialogHeader>
          <div className="flex min-w-0 items-center gap-2 pr-8">
            <DialogTitle className="min-w-0 truncate">{title}</DialogTitle>
            {isPair && target.cueState && (
              <CuePairState base={target.pair.base} state={target.cueState} />
            )}
          </div>
          {isPair && (
            <p className="text-caption1 text-fg-subtle">
              {target.pair.onName} / {target.pair.offName}
            </p>
          )}
        </DialogHeader>

        {/* The BODY scrolls, not the page behind it: the editor is taller than
            most windows, and a footer pushed off the bottom is a Save nobody
            can reach. Not unit-tested — jsdom loads no stylesheet and reports
            every offsetHeight as 0, so a max height and an overflow are not
            observable in it at all. Driven in a browser at 1280x800. */}
        <div className="max-h-[80vh] overflow-y-auto pr-1">
          {isPair && (
            <div className="mb-3 flex flex-col gap-1 rounded-lg border border-line bg-surface p-3" data-pair-settings="">
              <span className="text-caption2 font-semibold uppercase tracking-wider text-fg-muted">
                This pair
              </span>
              <p className="pb-1 text-caption2 text-fg-subtle">
                One switch, both directions. These apply to the pair, not to one half of it.
              </p>
              <HomeVisibilityField
                hidden={pairHidden}
                pairName={target.pair.name}
                onChange={(hidden) => setPairParams(homeVisibilityParams(hidden))}
              />
              <ServiceGuardField allowed={pairAllowed} onChange={setPairAllowed} />
              <CueStateFields
                params={stateParams}
                base={target.pair.base}
                toggle={target.toggle}
                customVariables={customVariables}
                inferred={inferredFor(onDraft)}
                onAction={onDraft.action}
                appSources={appSources}
                onChange={setPairParams}
              />
              <Row label="Room" hint="Where the thing this pair drives is. Shown in the log; not used to route anything.">
                <Input
                  value={pairRoom}
                  onChange={(e) => setPairParams({ room: e.target.value })}
                  className="h-7 text-footnote"
                  aria-label="Room"
                />
              </Row>
            </div>
          )}

          {isPair && offDraft && (
            <div
              role="tablist"
              aria-label="Which half to edit"
              className="mb-3 flex gap-1 rounded-lg border border-line bg-field p-1"
            >
              {(["on", "off"] as const).map((which) => (
                <button
                  key={which}
                  type="button"
                  role="tab"
                  aria-selected={half === which}
                  onClick={() => setHalf(which)}
                  className={
                    "min-w-0 flex-1 truncate rounded-md px-2 py-1 text-footnote " +
                    (half === which ? "bg-surface font-medium text-fg shadow-sm" : "text-fg-muted hover:text-fg")
                  }
                >
                  {which === "on" ? "Turn on" : "Turn off"} · {which === "on" ? target.pair.onName : target.pair.offName}
                </button>
              ))}
            </div>
          )}

          <RuleEditorBody
            // One body per half. Keyed by the rule id so switching halves
            // remounts it — a field that kept the other half's uncommitted
            // KeyValueField rows would save them onto the wrong cue.
            key={selected.id}
            draft={selected}
            setDraft={(next) => setSelected(next)}
            registry={registry}
            dynamicOptions={dynamicOptions}
            customVariables={customVariables}
            appSources={appSources}
            inferredSource={inferredFor(selected)}
            pairBase={isPair ? target.pair.base : null}
            pairIsToggle={isPair ? target.toggle : false}
            pairFieldsElsewhere={isPair}
          />
        </div>

        <DialogFooter className="justify-between">
          <span className="flex shrink-0 items-center gap-2">
            <Button variant="transparent" size="small" onClick={() => void testFire()} aria-label="Test fire">
              <PlayIcon className="size-3.5" /> {isPair ? `Test ${halfLabel}` : "Test"}
            </Button>
            <Button variant="transparent" size="small" aria-label="Delete rule" onClick={() => void remove()} disabled={busy}>
              <Trash2Icon className="size-3.5 text-red-10" /> Delete
            </Button>
          </span>
          <span className="flex shrink-0 items-center gap-2">
            <Button variant="transparent" size="small" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button variant="accent" size="small" onClick={() => void save()} disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </span>
        </DialogFooter>
      </DialogContent>
    </DialogRoot>
  );
}
