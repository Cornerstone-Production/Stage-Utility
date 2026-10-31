import { errorMessage } from "@main/services/errors";
import { CALL_TRIGGER_ID, parseAliases, takenCueNames } from "@main/services/cue-aliases";
import { APP_STATE_SOURCES, appStateRef } from "@main/services/app-state-sources";
import {
  cuePairs,
  isHiddenFromHome,
  isTogglePair,
  spokenCueName,
} from "@main/services/cue-pairs";
import type { InferredStateSource } from "@main/services/companion-state-source";
import { hasServiceGuard } from "@main/services/service-guard";
// The server's own shapes, imported rather than restated. An OUTCOME and a RULE
// are both closed sets the server owns, and a second copy of either is a list
// that silently stops covering the thing it models: `skipped` had to be added
// to the outcome copy by hand, and nothing would have said so if it had not
// been. Type-only, so nothing these modules reach at runtime is bundled.
import type { AutomationOutcome, Rule } from "@main/types/automation";
import { fieldsNeedAttention, type RuleIssue } from "@main/services/automation-param-validation";
import type { CueStateRow } from "@main/services/cue-states";
import { labelFor, ruleMatchesSearch } from "./rule-search";
import { CUE_USAGE_KEY, screenNames, useCueUsage, usesOf, type CueUse } from "./cue-usage";
import { BelongsToButton, OwnedRows } from "./automation-owned";
import { HomeAssistantChip, UsedOn, VoiceChip } from "./automation-chips";
import { useOptionSources } from "./automation-option-sources";
import { joinWithAnd } from "../../lib/join-with-and";

/** A rule as GET /api/automation/rules sends it — its own fields plus the
 *  issues the server computed against the current registry. See
 *  automation-routes.ts and docs/automation.md. */
export type RuleWithIssues = Rule & {
  issues: RuleIssue[];
  /** Computed by the list route, never stored: the Button this rule belongs to is gone. */
  ownerMissing?: boolean;
};
// The editor itself, and the field shapes it and this list share. The list
// renders the collapsed rows; the dialog is the only thing that mounts an
// editor.
import {
  CuePairState,
  RuleEditorDialog,
  type PairRowData,
  type Registry,
  type RuleEditorTarget,
} from "./rule-editor-dialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStageState } from "../../main/use-stage-state";
import { useSearchParam } from "../../lib/use-search-param";
import { useConfiguredIntegrations } from "../../main/use-integration-states";
import { usePvpState } from "../../main/use-pvp-state";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { DownloadIcon, OctagonXIcon, PlayIcon, PlusIcon } from "lucide-react";

import { invoke, onNotification } from "../../lib/api";
import { automationRegistryQuery } from "../../lib/automation-registry";
import { Button, Switch, toast } from "../../components/ui";
import { formatClock } from "../../lib/clock-format";
import { logReadFailure } from "../../lib/client-log";
import { CueAccessCard, CueButtonStatus, ImportPairsDialog } from "./companion-cues";
import { PageSearchBox, PageTabBar } from "../../components/page-tabs";
import { usePageTabs } from "../../lib/use-page-tabs";
import {
  AUTOMATION_SEARCH_TAB_ID,
  AUTOMATION_TABS,
  DEFAULT_AUTOMATION_TAB,
  parseAutomationTab,
  type AutomationPageTab,
} from "./automation-tabs";
import { NewCueDialog } from "./new-cue-dialog";
import type { CueKind } from "./new-cue-flow";
import { plural } from "@main/services/plural";

/**
 * One row in a section: a pair, or a single rule.
 *
 * `sortBy` is carried rather than recomputed at sort time — a pair's is the
 * words it is called, a cue's is the same, and a rule with any other trigger
 * never reaches the comparison.
 */
type RuleListEntry =
  | { kind: "pair"; key: string; sortBy: string; pair: PairRowData }
  | { kind: "rule"; key: string; sortBy: string; rule: RuleWithIssues };
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
    <div className="flex flex-col gap-2" data-automation-activity="">
      <p className="text-caption1 text-fg-muted">{entries.length} recent</p>
      <div className="rounded-lg border border-line bg-surface">
        {entries.length === 0 ? (
          <p className="px-3 py-3 text-caption1 text-fg-muted">
            Nothing yet. Rules log here when they fire — and when they are suppressed, with the reason.
          </p>
        ) : (
          entries.slice(0, 60).map((e, i) => (
            <div
              key={`${e.at}-${i}`}
              className="flex items-baseline gap-2 border-b border-line px-3 py-2 text-caption1 last:border-b-0"
            >
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
      </div>
      {entries.length > 0 && (
        <div>
          <Button
            variant="transparent"
            size="small"
            onClick={async () => {
              try {
                await invoke("automation:clearLog");
              } catch (e) {
                toast.error(`Could not clear the log: ${errorMessage(e)}`);
              }
              refresh();
            }}
          >
            Clear
          </Button>
        </div>
      )}
    </div>
  );
}

// ── One rule ──────────────────────────────────────────────────────────────────

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
 * "service-safe" (quiet) when the cue carries `service.is-not-live`, or a
 * clearly visible amber "any time" when it does not — so the cues that can
 * fire mid-service stand out in a long list rather than needing the editor
 * opened one at a time.
 *
 * Only for a cue (`call.by-name`): the condition means nothing on a rule that
 * cannot be called. A PAIR is guarded only when BOTH halves are — the engine
 * evaluates each half against its own conditions, so one unguarded half is a
 * pair that can fire mid-service.
 */
function ServiceGuardBadge({ guarded }: { guarded: boolean }) {
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
 * "Needs setup: N fields" — a rule whose stored params the current registry
 * calls invalid. `title` names them, so hovering (or a screen reader) says
 * which without opening the editor. See List.dc.html: this is that badge, in
 * the app's own amber pill (ServiceGuardBadge's, not the mockup's raw hex).
 */
function NeedsSetupBadge({ issues }: { issues: RuleIssue[] }) {
  return (
    <span
      data-needs-setup={issues.length}
      title={joinWithAnd(issues.map((i) => i.label))}
      className="inline-flex shrink-0 items-center rounded-md border border-amber-7 bg-amber-3 px-1.5 py-0.5 text-caption2 font-medium text-amber-11"
    >
      Needs setup: {plural(issues.length, "field")}
    </span>
  );
}
/** A small neutral pill on a row, for a fact about the rule that changes what Run does. */
function RowPill({ children, ...rest }: { children: React.ReactNode } & React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span {...rest} className="shrink-0 max-sm:hidden rounded-full bg-fill px-1.5 py-px text-caption2 font-medium text-fg-muted">
      {children}
    </span>
  );
}
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

/** The pause before a change to the views re-reads where commands are used. */
export const VIEWS_REREAD_MS = 400;

/** How long a first press on a confirm rule's Run waits for the second. */
const RUN_CONFIRM_MS = 5000;

/** What the last manual run of a rule did, kept by the section so a search that
 *  unmounts the row does not lose it. Until the next run or a reload. */
interface RunResult {
  at: number;
  outcome: "fired" | "simulated" | "failed";
  detail: string;
}

const RUN_TONE: Record<RunResult["outcome"], string> = {
  fired: "text-ok-11",
  simulated: "text-warn-11",
  failed: "text-danger-11",
};

function runResultText(r: RunResult): string {
  const at = formatClock(r.at, { seconds: true });
  if (r.outcome === "simulated") return `Simulated at ${at} · nothing was sent`;
  if (r.outcome === "failed") return `Run by hand at ${at} · failed: ${r.detail}`;
  return `Run by hand at ${at} · done`;
}

/**
 * One rule's Run, shared by a single rule's row and each half of a pair's.
 *
 * A confirm rule's first press arms the button; a second within RUN_CONFIRM_MS
 * fires. The timer is the only thing that resets it. Disarming while armed
 * cancels the question at once (`asking`), and the timer clears the state.
 */
function useRunByHand(
  rule: { id: string; confirmRequired?: boolean },
  disarmed: boolean,
  onRan: (id: string, r: RunResult) => void,
) {
  const [armed, setArmed] = useState(false);
  const [running, setRunning] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), RUN_CONFIRM_MS);
    return () => clearTimeout(t);
  }, [armed]);
  const asking = armed && !disarmed;

  async function run() {
    if (rule.confirmRequired && !asking) {
      setArmed(true);
      return;
    }
    setArmed(false);
    setRunning(true);
    try {
      const r = await invoke<{ outcome: RunResult["outcome"]; detail: string }>("automation:runRule", {
        id: rule.id,
        confirmed: rule.confirmRequired === true,
      });
      onRan(rule.id, { at: Date.now(), ...r });
    } catch (e) {
      // A refusal (disarmed from another tab, a stale confirm flag) reads the
      // same as an action that failed: the row says why nothing happened.
      onRan(rule.id, { at: Date.now(), outcome: "failed", detail: errorMessage(e) });
    } finally {
      setRunning(false);
    }
  }
  return { asking, running, run };
}

/** Fires the action once, now: not the trigger, the conditions, the cooldown or
 *  once-per-service, and not the rule's own switch. Simulate and the disarm
 *  switch still apply. A confirm rule asks first, by turning into "Run it?". */
function RunButton({
  rule,
  label,
  disarmed,
  onRan,
}: {
  rule: { id: string; name: string; confirmRequired?: boolean };
  /** The words on the button; a pair's halves say which half. */
  label: string;
  disarmed: boolean;
  onRan: (id: string, r: RunResult) => void;
}) {
  const { asking, running, run } = useRunByHand(rule, disarmed, onRan);
  return (
    <Button
      variant="filled"
      size="small"
      className={"h-7 shrink-0 text-footnote " + (asking ? "bg-amber-3 text-amber-11 hover:bg-amber-4" : "")}
      data-run-button={asking ? "armed" : "idle"}
      data-run-rule={rule.id}
      aria-label={`${label} ${rule.name}`}
      disabled={disarmed || running}
      tooltip={disarmed ? "Disarmed" : ""}
      onClick={() => void run()}
    >
      <PlayIcon className="size-3.5" />
      {asking ? "Run it?" : label}
    </Button>
  );
}

/** The result line, with an optional prefix naming a pair's half. */
function RunResultLine({ result, half }: { result: RunResult; half?: string }) {
  return (
    <div
      role="status"
      data-run-result={result.outcome}
      {...(half ? { "data-run-half": half } : {})}
      className={`text-caption1 ${RUN_TONE[result.outcome]}`}
    >
      {half ? `${half}: ` : ""}
      {runResultText(result)}
    </div>
  );
}

// ── One rule's row ────────────────────────────────────────────────────────────

/**
 * One rule, as a SUMMARY row. Pressing it opens the editor in a dialog.
 *
 * The row carries only what is worth reading in a list of two hundred: whether
 * the rule is enabled, what it is called, what it used to be called, whether it
 * can fire mid-service, whether Home Assistant has an entity for it, and the
 * one-line "When … then …". Everything else — every field, Test and Delete — is
 * in the dialog, which is the only thing that mounts the editor at all.
 */
function RuleRow({
  rule,
  registry,
  disarmed,
  lastRun,
  onRan,
  onOpen,
  onChanged,
  uses,
}: {
  /** The Buttons that name this command, or null while they are unread. Only a command shows them. */
  uses: readonly CueUse[] | null;
  rule: RuleWithIssues;
  registry: Registry;
  /** The panic switch is on: nothing runs, by trigger or by hand. */
  disarmed: boolean;
  lastRun: RunResult | undefined;
  onRan: (id: string, r: RunResult) => void;
  onOpen: () => void;
  onChanged: () => void;
}) {
  const formerNames = rule.trigger.id === CALL_TRIGGER_ID ? parseAliases(rule.trigger.params) : [];
  const trigger = registry.triggers.find((t) => t.id === rule.trigger.id) ?? null;
  const action = registry.actions.find((a) => a.id === rule.action.id) ?? null;
  const isCue = rule.trigger.id === CALL_TRIGGER_ID;
  const cueName = String(rule.trigger.params.name ?? "");
  const hidden = isHiddenFromHome(rule.trigger.params);
  const spoken = String(rule.trigger.params.says ?? "").trim() !== "";
  // `?? []`: a kiosk tab left open across an update, or a test fixture written
  // before this field existed, is a server or a stub that never sends `issues`
  // at all — read as "nothing to report" rather than throwing and blanking the
  // whole list, the same reasoning ParamField's optionSources fallback uses.
  const issues = rule.issues ?? [];
  const needsSetup = issues.length > 0;

  const summary = `When ${trigger?.label ?? rule.trigger.id}` +
    (rule.conditions.length ? ` · if ${plural(rule.conditions.length, "condition")}` : "") +
    ` · then ${action?.label ?? rule.action.id}`;

  return (
    <div data-rule-row={rule.id} className="border-b border-line px-3 py-2.5 last:border-b-0 hover:bg-fill">
      <div className="flex items-center gap-2">
        {/* The one control on the row that is NOT the editor: arming a rule is
            a thing an operator does down a list, and it writes at once — except
            turning ON a rule that still needs setup, which this refuses without
            a round trip: the server would refuse it anyway (automation-routes.ts),
            and the toast says the same thing either way. See List.dc.html. */}
        <Switch
          checked={rule.enabled}
          aria-label={needsSetup && !rule.enabled ? `${rule.name} needs setup before it can turn on` : "Enable rule"}
          onCheckedChange={async (v) => {
            if (v && needsSetup) {
              toast.error(
                `Can't turn on "${rule.name}": ${fieldsNeedAttention(issues.length)}. Open it to fix them.`,
              );
              return;
            }
            try {
              await invoke("automation:updateRule", { id: rule.id, patch: { enabled: v } });
            } catch (e) {
              // The authoritative backstop for a stale tab: the server refused
              // the same request this client-side check would have. Same
              // wording either way.
              toast.error(errorMessage(e));
            }
            onChanged();
          }}
        />
        <div className="min-w-0 flex-1">
        <button type="button" className="block w-full min-w-0 text-left" onClick={onOpen}>
          <div className="flex min-w-0 items-baseline gap-2">
            <span data-rule-name={rule.name} className="truncate text-footnote font-medium text-fg">{rule.name}</span>
            {isCue && cueName !== rule.name && (
              <span className="min-w-0 truncate font-mono text-caption2 text-fg-subtle">{cueName}</span>
            )}
            {needsSetup && <NeedsSetupBadge issues={issues} />}
            {/* Two quiet pills from the Run mockup: a rule that is off can still
                be run by hand, and a confirm rule's Run asks first. Hidden on a phone,
                where they would crush the name; the switch and the button say the same. */}
            {!rule.enabled && <RowPill data-rule-pill="off">Off</RowPill>}
            {rule.confirmRequired && <RowPill data-rule-pill="confirm">Confirm first</RowPill>}
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
            {isCue && !hidden && <HomeAssistantChip />}
            {isCue && spoken && <VoiceChip />}
            {isCue && <ServiceGuardBadge guarded={hasServiceGuard(rule.conditions)} />}
          </div>
          <div className="truncate text-caption1 text-fg-muted">{summary}</div>
          {/* What the last reconcile found about this rule's Companion button.
              Inside the row's own button, so the way to act on a `button
              missing` pill is to press the thing saying it — which opens the
              editor and its picker. Renders nothing for any other action, and
              nothing for a rule that has never been reconciled. */}
          {rule.action.id === "companion.press" && <CueButtonStatus params={rule.action.params} />}
        </button>
        {isCue && <UsedOn uses={uses} />}
        {lastRun && <RunResultLine result={lastRun} />}
        </div>
        <RunButton rule={rule} label="Run" disarmed={disarmed} onRan={onRan} />
      </div>
    </div>
  );
}

/**
 * One ON/OFF pair, as ONE row.
 *
 * A pair is one thing — one switch in Home Assistant, one thing an operator
 * turns on and off — and two rows for it is the list saying otherwise. Pressing
 * it opens ONE dialog holding both halves: the pair's own settings once, and a
 * Turn on / Turn off control for the fields that differ.
 */
function PairRow({
  base,
  name,
  onName,
  offName,
  hidden,
  guarded,
  cueState,
  issues,
  on,
  off,
  disarmed,
  lastRuns,
  onRan,
  onOpen,
  uses,
}: {
  /** The Buttons that name this pair (by its base or either half), or null while unread. */
  uses: readonly CueUse[] | null;
  base: string;
  name: string;
  onName: string;
  offName: string;
  hidden: boolean;
  /** BOTH halves carry `service.is-not-live`. See ServiceGuardBadge. */
  guarded: boolean;
  cueState: CueStateRow | null;
  /** Both halves' issues, combined — either half needing setup is the pair
   *  needing setup, the same as RuleRow's own badge one field down. */
  issues: RuleIssue[];
  /** The two halves, each run by its own button. */
  on: Rule;
  off: Rule;
  disarmed: boolean;
  lastRuns: ReadonlyMap<string, RunResult>;
  onRan: (id: string, r: RunResult) => void;
  onOpen: () => void;
}) {
  const onResult = lastRuns.get(on.id);
  const offResult = lastRuns.get(off.id);
  // A spoken name on either half: the pair's own settings live on the ON half, with the OFF half read as a fallback.
  const spoken = [on, off].some((r) => String(r.trigger.params.says ?? "").trim() !== "");
  return (
    <div className="border-b border-line px-3 py-2.5 last:border-b-0 hover:bg-fill" data-cue-pair-row={base}>
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
        <button
          type="button"
          className="flex w-full min-w-0 items-center gap-2 text-left"
          onClick={onOpen}
          aria-label={`${name} pair`}
        >
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="truncate text-footnote font-medium text-fg" data-cue-pair-name={name}>
                {name}
              </span>
              {issues.length > 0 && <NeedsSetupBadge issues={issues} />}
            </span>
            <span className="block truncate font-mono text-caption2 text-fg-subtle">
              {onName} / {offName}
            </span>
          </span>
          {/* The pair's, over both halves. It was on each half's card, which
              is a badge nobody saw: the halves are only rendered inside the
              dialog now, and a cue that can fire mid-service has to be
              spottable down a list of two hundred. */}
          {!hidden && <HomeAssistantChip />}
          {spoken && <VoiceChip />}
          <ServiceGuardBadge guarded={guarded} />
          {cueState && <CuePairState base={base} state={cueState} />}
        </button>
        <UsedOn uses={uses} />
        {onResult && <RunResultLine result={onResult} half="On" />}
        {offResult && <RunResultLine result={offResult} half="Off" />}
        </div>
        {/* One Run per half: a pair is two rules, and each is run, confirmed
            and disarmed on its own. Stacked on a phone, where two buttons
            beside the name would crush it. */}
        <div className="flex shrink-0 flex-col gap-1 sm:flex-row">
          <RunButton rule={on} label="Run on" disarmed={disarmed} onRan={onRan} />
          <RunButton rule={off} label="Run off" disarmed={disarmed} onRan={onRan} />
        </div>
      </div>
    </div>
  );
}

/** Whether a row's rule (either half, for a pair) is among the ids a search matched. */
function entryMatches(e: RuleListEntry, ids: ReadonlySet<string>): boolean {
  return e.kind === "pair" ? ids.has(e.pair.on.id) || ids.has(e.pair.off.id) : ids.has(e.rule.id);
}

// ── The deep link ─────────────────────────────────────────────────────────────

/** The `new` search value that opens the New cue dialog on a manual cue. */
export const NEW_CUE_PARAM = "new";
export const NEW_MANUAL_CUE = "manual";

/**
 * `/automation?new=manual` opens the New cue dialog at the manual kind, for a link
 * from another page. Read on arrival and on every resolved navigation, so a link
 * pressed while this page is already showing works too. The parameter is DROPPED
 * once it has opened the dialog, so a reload (or Back) does not open it a second
 * time: it is a command, not state worth keeping in the URL.
 */
function useNewCueLink(open: (kind: CueKind) => void) {
  const [asked, setAsked] = useSearchParam(NEW_CUE_PARAM);
  useEffect(() => {
    if (asked !== NEW_MANUAL_CUE) return;
    open("manual");
    setAsked(null, { replace: true });
  }, [asked, open, setAsked]);
}

// ── Section ───────────────────────────────────────────────────────────────────

export function AutomationSection({
  tab: tabSegment,
  onTabChange,
}: {
  /** The URL's tab segment. Anything that is not a tab shows Commands. */
  tab?: string;
  /** Called when the operator picks a tab, which the URL then hands back as `tab`. Without it the page keeps its own tab, starting at `tab`. */
  onTabChange?: (tab: AutomationPageTab) => void;
}) {
  const qc = useQueryClient();
  const { tab, goTo, searchRef } = usePageTabs<AutomationPageTab>({
    segment: tabSegment,
    onTabChange,
    parse: parseAutomationTab,
    fallback: DEFAULT_AUTOMATION_TAB,
    searchId: AUTOMATION_SEARCH_TAB_ID,
  });
  const [importing, setImporting] = useState(false);
  // The New cue dialog: null while closed, and `kind` set when a link already says
  // which. NOTHING is saved by opening it — see new-cue-dialog.tsx.
  const [creating, setCreating] = useState<{ kind: CueKind | null } | null>(null);
  const openNewCue = useCallback((kind: CueKind | null) => setCreating({ kind }), []);
  useNewCueLink(openNewCue);
  const { data: registry } = useQuery(automationRegistryQuery);
  const { data } = useQuery({
    queryKey: ["automation:rules"],
    queryFn: () =>
      invoke<{ rules: RuleWithIssues[]; settings: { simulate: boolean; disarmed: boolean } }>("automation:rules"),
  });
  const refreshRules = useCallback(() => void qc.invalidateQueries({ queryKey: ["automation:rules"] }), [qc]);
  // After a write of this page's own: the rules, and where the commands are used, because a
  // save can rename a command and its Buttons with it. A broadcast refreshes the rules only:
  // usage is read from the views file on each request, so it is not re-read for every rule event.
  const refresh = useCallback(() => {
    refreshRules();
    void qc.invalidateQueries({ queryKey: CUE_USAGE_KEY });
  }, [qc, refreshRules]);
  useEffect(() => onNotification("automation:rules", refreshRules), [refreshRules]);
  useEffect(() => onNotification("automation:settings", refreshRules), [refreshRules]);

  // Runtime option sources, so a param declaring optionsFrom resolves to real
  // things. One record over the closed set main/types/automation.ts declares —
  // see automation-option-sources.ts for why it is a whole module.
  const optionSources = useOptionSources();

  // Which app state sources there is anything to read. An integration that is
  // not set up has no state, so offering it would be offering a binding that
  // reads unknown forever — the source's own integration id is the question,
  // and `configured` (not "connected") is the right half of it: a REAPER that
  // is set up and currently unreachable is still the right thing to bind to.
  const configuredIntegrations = useConfiguredIntegrations();
  const appSources = useMemo(
    () =>
      [...APP_STATE_SOURCES]
        .filter(([, def]) => configuredIntegrations.has(def.integrationId))
        .map(([id]) => appStateRef(id)),
    [configuredIntegrations],
  );

  // The layers behind the PARAMETERISED sources — `app:pvp.layer-hidden:<name>`
  // is one ref per layer, so the picker is built from what PVP currently has
  // rather than from the registry.
  //
  // GATED on PVP being set up, and not merely because there would be nothing to
  // offer: this hook's `enabled` is what registers demand on the channel, and an
  // ungated one would hold an unconfigured PVP's poll open for anybody who
  // opened the Automation page.
  const pvp = usePvpState(configuredIntegrations.has("pvp"));
  const pvpLayers = useMemo(() => (pvp?.layers ?? []).map((l) => l.name), [pvp]);

  // Memoised because the pair resolution below depends on it: `data?.rules ?? []`
  // is a new array on every render, which would re-resolve every pair each time.
  const rules = useMemo(() => data?.rules ?? [], [data]);
  const settings = data?.settings ?? { simulate: true, disarmed: false };

  // A rule a Button made for itself is listed under "Belongs to a button", not
  // with the commands somebody wrote, and is not a half of a pair: its name is
  // derived (`btn_…`), never `_on`/`_off`.
  const ownedRules = useMemo(() => rules.filter((r) => r.ownedBy), [rules]);
  const listed = useMemo(() => rules.filter((r) => !r.ownedBy), [rules]);

  // Where each command is used: the Buttons that name it. Undefined until read.
  const { usage, error: usageError } = useCueUsage();
  // Where a command is used goes stale when anybody edits a layout: this page, the layout
  // editor, another client. The stage state carries every view's revision and name, so a change
  // to any of them re-reads the usage, after a pause so a burst of saves is one read. The first
  // state is the baseline, not a change.
  const { state: stage } = useStageState();
  const viewsSignature = stage?.views?.map((v) => `${v.id}:${v.layoutRev ?? 0}:${v.name}`).join("|") ?? null;
  const lastViews = useRef<string | null>(null);
  useEffect(() => {
    if (viewsSignature === null) return;
    const before = lastViews.current;
    lastViews.current = viewsSignature;
    if (before === null || before === viewsSignature) return;
    const t = setTimeout(() => void qc.invalidateQueries({ queryKey: CUE_USAGE_KEY }), VIEWS_REREAD_MS);
    return () => clearTimeout(t);
  }, [viewsSignature, qc]);
  // A failed read says so on the page and on /log, so a command that reads as
  // unused over an unreadable usage is never the only evidence there was.
  useEffect(() => {
    if (usageError) logReadFailure("automation", "where each command is used", usageError);
  }, [usageError]);

  // The ON/OFF pairs among the rules, resolved by the same module the server
  // generates the Home Assistant config from — so the row that offers a state
  // binding is exactly the row that would get one.
  const pairs = useMemo(() => cuePairs(listed), [listed]);
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

  /**
   * The pairs as ROWS, holding this component's own rule objects.
   *
   * `cuePairs` answers with the rules it was given, which are these — but
   * looked up again by id rather than cast, because the module's `Rule` is the
   * server's and this file deliberately models the wire shape itself.
   */
  const pairRows = useMemo(() => {
    const byId = new Map(rules.map((r) => [r.id, r] as const));
    const out: PairRowData[] = [];
    for (const p of pairs) {
      const on = byId.get(p.on.id);
      const off = byId.get(p.off.id);
      if (!on || !off) continue;
      out.push({
        base: p.base,
        name: spokenCueName(on.trigger.params, p.base),
        onName: p.onName,
        offName: p.offName,
        hidden: p.hiddenFromHome,
        on,
        off,
      });
    }
    return out;
  }, [pairs, rules]);

  /** Every rule that is half of a pair, so the singles are what is left. */
  const pairedRuleIds = useMemo(
    () => new Set(pairRows.flatMap((p) => [p.on.id, p.off.id])),
    [pairRows],
  );

  // The Search tab's query, in page state only: it outlives a move between tabs
  // (the page is not remounted by one) and is not worth restoring on the next visit.
  const [query, setQuery] = useState("");

  /**
   * The Buttons that name each rule's command, by rule id, or null while the usage is unread.
   *
   * A pair's two halves share one answer: a Button stores the pair's BASE, and may
   * name either half. A single command is looked up by its name and its former
   * names, the names a Button still resolves through.
   */
  const usesByRuleId = useMemo(() => {
    if (!usage) return null;
    const out = new Map<string, CueUse[]>();
    const paired = new Set<string>();
    for (const p of pairRows) {
      const names = [p.base, p.onName, p.offName, ...parseAliases(p.on.trigger.params), ...parseAliases(p.off.trigger.params)];
      const uses = usesOf(usage, names);
      out.set(p.on.id, uses);
      out.set(p.off.id, uses);
      paired.add(p.on.id);
      paired.add(p.off.id);
    }
    for (const r of rules) {
      if (paired.has(r.id) || r.trigger.id !== CALL_TRIGGER_ID) continue;
      out.set(r.id, usesOf(usage, [String(r.trigger.params.name ?? ""), ...parseAliases(r.trigger.params)]));
    }
    return out;
  }, [usage, pairRows, rules]);

  /** The rows of the Commands and Rules tabs, in the order they render. */
  const { commandEntries, ruleEntries } = useMemo(() => {
    const byName = (a: { sortBy: string }, b: { sortBy: string }) => a.sortBy.localeCompare(b.sortBy);
    // Pairs first, then single commands, each alphabetical by the words the
    // command is called. Rules with any other trigger keep their stored order:
    // that order is the operator's own and nothing about a trigger name is worth
    // sorting by.
    const pairEntries: RuleListEntry[] = pairRows
      .map((p) => ({ kind: "pair" as const, key: p.on.id, sortBy: p.name, pair: p }))
      .sort(byName);
    const singles: RuleListEntry[] = listed
      .filter((r) => r.trigger.id === CALL_TRIGGER_ID && !pairedRuleIds.has(r.id))
      .map((r) => ({
        kind: "rule" as const,
        key: r.id,
        sortBy: spokenCueName(r.trigger.params, String(r.trigger.params.name ?? r.name)),
        rule: r,
      }))
      .sort(byName);
    const others: RuleListEntry[] = listed
      .filter((r) => r.trigger.id !== CALL_TRIGGER_ID)
      .map((r) => ({ kind: "rule" as const, key: r.id, sortBy: r.name, rule: r }));
    return { commandEntries: [...pairEntries, ...singles], ruleEntries: others };
  }, [listed, pairRows, pairedRuleIds]);

  /**
   * The Search tab: every rule the query matches, then which entries show.
   *
   * A PAIR IS ONE ROW and shows whenever EITHER half matches — the two halves are
   * one thing, and a search for the off command that hid the row it lives on would
   * be a pair that cannot be found by half its own names. The screens a command is
   * used on, and its Buttons' labels, are part of what a rule is found by.
   */
  const searching = query.trim() !== "";
  const matchedIds = useMemo(() => {
    if (!searching) return new Set<string>();
    const out = new Set<string>();
    for (const r of rules) {
      const uses = usesByRuleId?.get(r.id) ?? [];
      const onScreens = [...screenNames(uses), ...uses.map((u) => u.label).filter((l) => l !== "")];
      if (
        ruleMatchesSearch(
          r,
          query,
          labelFor(registry?.triggers ?? [], r.trigger.id),
          labelFor(registry?.actions ?? [], r.action.id),
          onScreens,
        )
      ) {
        out.add(r.id);
      }
    }
    return out;
  }, [rules, query, searching, registry, usesByRuleId]);
  const found = useMemo(
    () => ({
      commands: commandEntries.filter((e) => entryMatches(e, matchedIds)),
      rules: ruleEntries.filter((e) => entryMatches(e, matchedIds)),
      owned: ownedRules.filter((r) => matchedIds.has(r.id)),
    }),
    [commandEntries, ruleEntries, ownedRules, matchedIds],
  );

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

  /**
   * Which rule or pair is being EDITED, by id — never the rule object itself.
   *
   * The dialog resolves its target out of the live query on every render, so a
   * save, an SSE refresh or a rename lands in the open editor rather than
   * leaving it holding a rule that no longer exists. A target that has gone —
   * deleted, or a pair broken by a rename — resolves to null and the dialog
   * unmounts, which is the only correct thing to show for it.
   */
  const [editing, setEditing] = useState<{ kind: "rule" | "pair"; id: string } | null>(null);
  const editorTarget = useMemo<RuleEditorTarget | null>(() => {
    if (!editing) return null;
    if (editing.kind === "pair") {
      const pair = pairRows.find((p) => p.on.id === editing.id);
      return pair
        ? {
            kind: "pair",
            pair,
            toggle: togglePairs.has(pair.on.id),
            cueState: cueStateFor(cueStateData?.states, pair.base),
          }
        : null;
    }
    const rule = rules.find((r) => r.id === editing.id);
    return rule ? { kind: "rule", rule } : null;
  }, [editing, pairRows, rules, togglePairs, cueStateData]);

  // Every cue name in use, with former names and the built-ins: what Make it manual
  // must not derive a name equal to. The server refuses a clash either way.
  const cueNamesTaken = useMemo(
    () => takenCueNames(rules, registry?.reservedCueNames),
    [rules, registry],
  );

  // The last manual run of each rule, until the next one or a reload.
  // A Map, not a record: the key is a rule id, which arrives over the wire.
  const [lastRuns, setLastRuns] = useState<ReadonlyMap<string, RunResult>>(new Map());
  const noteRan = useCallback(
    (id: string, r: RunResult) => setLastRuns((cur) => new Map(cur).set(id, r)),
    [],
  );

  /** One row. A pair is ONE row holding both halves; everything else is a rule. */
  const renderEntry = (entry: RuleListEntry) => {
    if (entry.kind === "rule") {
      return (
        <RuleRow
          key={entry.key}
          rule={entry.rule}
          registry={registry!}
          disarmed={settings.disarmed}
          lastRun={lastRuns.get(entry.rule.id)}
          onRan={noteRan}
          onOpen={() => setEditing({ kind: "rule", id: entry.rule.id })}
          onChanged={refresh}
          uses={usesByRuleId?.get(entry.rule.id) ?? null}
        />
      );
    }
    const p = entry.pair;
    return (
      <PairRow
        key={entry.key}
        base={p.base}
        name={p.name}
        onName={p.onName}
        offName={p.offName}
        hidden={p.hidden}
        guarded={hasServiceGuard(p.on.conditions) && hasServiceGuard(p.off.conditions)}
        cueState={cueStateFor(cueStateData?.states, p.base)}
        issues={[...(p.on.issues ?? []), ...(p.off.issues ?? [])]}
        on={p.on}
        off={p.off}
        disarmed={settings.disarmed}
        lastRuns={lastRuns}
        onRan={noteRan}
        onOpen={() => setEditing({ kind: "pair", id: p.on.id })}
        uses={usesByRuleId?.get(p.on.id) ?? null}
      />
    );
  };

  const counts: Record<string, number> = { commands: commandEntries.length, rules: ruleEntries.length };
  const note = settings.disarmed
    ? { text: "All rules disarmed. No rule will run, whatever its own switch says.", tone: "text-red-11" }
    : settings.simulate
      ? { text: "Simulate mode: rules evaluate and log what they would do. Nothing reaches a device.", tone: "text-amber-11" }
      : { text: "Rules armed and acting on your devices.", tone: "text-fg-muted" };

  const commandsTab = (
    <div className="flex flex-col gap-3" data-automation-tab="commands">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="accent" size="small" onClick={() => openNewCue("manual")}>
          <PlusIcon className="size-3.5" /> New command
        </Button>
        <Button variant="filled" size="small" onClick={() => setImporting(true)}>
          <DownloadIcon className="size-3.5" /> Import from Companion
        </Button>
        <span className="text-caption1 text-fg-muted">
          Fire when something calls them: a console button, a Home tile, Home Assistant, voice or Run.
        </span>
      </div>
      {cueStateError !== null && anyBinding && (
        // The route itself failed — not a pair reading unknown, which has its own
        // pill and its own reason. Without this the pills simply stopped appearing,
        // which looks exactly like a set of pairs with no bindings. One muted line
        // above the list, because it is about all of them at once.
        <p className="text-caption1 text-fg-muted" data-cue-state-error="">
          Cue state unavailable: {errorMessage(cueStateError)}
        </p>
      )}
      {usageError !== null && (
        <p className="text-caption1 text-fg-muted" data-cue-usage-error="">
          Where each command is used could not be read: {errorMessage(usageError)}
        </p>
      )}
      {commandEntries.length === 0 ? (
        <p className="text-caption1 text-fg-muted" data-empty="commands">
          No commands yet. New command makes one; Import from Companion brings in the buttons Companion already has.
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-line bg-surface">{commandEntries.map(renderEntry)}</div>
      )}
      <BelongsToButton rules={ownedRules} usage={usage} onChanged={refresh} />
    </div>
  );

  const rulesTab = (
    <div className="flex flex-col gap-3" data-automation-tab="rules">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="accent" size="small" onClick={() => openNewCue("auto")}>
          <PlusIcon className="size-3.5" /> New rule
        </Button>
        <span className="text-caption1 text-fg-muted">Fire on their own when something happens. New ones start off.</span>
      </div>
      {ruleEntries.length === 0 ? (
        <p className="text-caption1 text-fg-muted" data-empty="rules">
          No automatic rules yet. Start with the <span className="font-medium text-fg">Write a log message</span> action —
          arm the rule, watch Activity through a service to confirm it fires when you expect, then swap in the real
          action.
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-line bg-surface">{ruleEntries.map(renderEntry)}</div>
      )}
    </div>
  );

  const found_n = found.commands.length + found.rules.length + found.owned.length;
  const searchTab = (
    <div className="flex flex-col gap-3" data-automation-tab="search">
      <PageSearchBox
        value={query}
        onChange={setQuery}
        inputRef={searchRef}
        name="automation-search"
        label="Search automation"
        placeholder="Search commands, rules, button labels and consoles"
      />
      {!searching ? (
        <p className="text-caption1 text-fg-muted">
          Matches command names, spoken names, Companion button labels, rule triggers and actions, and the consoles a
          button sits on.
        </p>
      ) : found_n === 0 ? (
        <p className="text-caption1 text-fg-muted" data-empty="search">
          Nothing matches “{query.trim()}”.
        </p>
      ) : (
        <>
          <p className="text-caption1 text-fg-muted" aria-live="polite" data-rule-search-count="">
            {plural(found_n, "match", "matches")} of {plural(rules.length, "rule")}
          </p>
          <div className="overflow-hidden rounded-lg border border-line bg-surface">
            {found.commands.length > 0 && (
              <>
                <SearchGroupLabel>Commands</SearchGroupLabel>
                {found.commands.map(renderEntry)}
              </>
            )}
            {found.rules.length > 0 && (
              <>
                <SearchGroupLabel>Rules</SearchGroupLabel>
                {found.rules.map(renderEntry)}
              </>
            )}
            {found.owned.length > 0 && (
              <>
                <SearchGroupLabel>Belongs to a button</SearchGroupLabel>
                <OwnedRows rules={found.owned} usage={usage} onChanged={refresh} />
              </>
            )}
          </div>
        </>
      )}
    </div>
  );

  const panel =
    tab === "commands" ? commandsTab : tab === "rules" ? rulesTab : tab === "activity" ? <ActivityLog /> : tab === "access" ? <CueAccessCard /> : searchTab;

  return (
    // The same wrapper every other section uses. This one had no horizontal or
    // vertical padding at all, so its cards ran to the pane edges while every
    // neighbouring tab inset them.
    <div className="flex flex-col gap-4 pt-5 max-sm:pt-4 pb-[50vh] max-sm:pb-24">
      {/* Safety first, above the tabs: these are the controls that decide whether
          anything real happens, and they stay in reach on every tab. */}
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="mr-auto text-title3 font-semibold text-fg">Automation</h1>
        <label className="flex items-center gap-2 text-footnote font-medium text-fg">
          <Switch
            checked={settings.simulate}
            onCheckedChange={(v) => void setSettings({ simulate: v })}
            aria-label="Simulate mode"
          />
          Simulate
        </label>
        <Button
          variant={settings.disarmed ? "accent" : "filled"}
          size="small"
          onClick={() => void setSettings({ disarmed: !settings.disarmed })}
        >
          <OctagonXIcon className="size-3.5" />
          {settings.disarmed ? "Re-arm" : "Disarm all"}
        </Button>
      </div>
      <p className={`-mt-2 text-caption1 ${note.tone}`} data-automation-note="">
        {note.text}
      </p>

      <PageTabBar<AutomationPageTab>
        label="Automation"
        tabs={AUTOMATION_TABS}
        searchId={AUTOMATION_SEARCH_TAB_ID}
        tab={tab}
        onSelect={goTo}
        onMove={(next) => goTo(next, false)}
        idPrefix="automation-tab"
        panelId="automation-tab-panel"
        markFor={(id) =>
          id in counts
            ? {
                said: String(counts[id]),
                mark: (
                  <span aria-hidden="true" className="font-mono text-caption2 font-normal tabular-nums text-fg-subtle">
                    {counts[id]}
                  </span>
                ),
              }
            : {}
        }
      />

      <div role="tabpanel" id="automation-tab-panel" aria-labelledby={`automation-tab-${tab}`} className="flex flex-col gap-3">
        {registry ? panel : null}
      </div>

      {/* The editor, over the list. Mounted only while something is being
          edited, so its drafts are seeded on open and discarded on close —
          Escape, the overlay and Cancel are the same thing. */}
      {registry && editorTarget && (
        <RuleEditorDialog
          // KEYED BY WHAT IS BEING EDITED. The drafts are seeded when the
          // dialog mounts, so a second rule opened into a living instance
          // would be edited through the first one's draft. Nothing on screen
          // can do that today — the overlay swallows the press that would —
          // but the failure is a rule saved over another rule's fields, which
          // is not something to leave resting on a modal overlay.
          key={`${editorTarget.kind}:${editing?.id ?? ""}`}
          target={editorTarget}
          onClose={() => setEditing(null)}
          registry={registry}
          optionSources={optionSources}
          customVariables={companionPairs?.customVariables ?? []}
          appSources={appSources}
          pvpLayers={pvpLayers}
          inferredFor={inferredFor}
          cueNamesTaken={cueNamesTaken}
          usage={usage}
          onChanged={refresh}
        />
      )}

      {/* Mounted only while open, so its draft is a fresh one each time and goes
          with it on close — Cancel, Escape and the overlay create nothing. */}
      {registry && creating && (
        <NewCueDialog
          registry={registry}
          optionSources={optionSources}
          rules={rules}
          initialKind={creating.kind}
          onClose={() => setCreating(null)}
          onCreated={refresh}
        />
      )}

      <ImportPairsDialog open={importing} onOpenChange={setImporting} onImported={refresh} />
    </div>
  );
}

function SearchGroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-fill px-3 py-1 text-caption2 font-semibold uppercase tracking-wider text-fg-subtle">{children}</div>
  );
}
