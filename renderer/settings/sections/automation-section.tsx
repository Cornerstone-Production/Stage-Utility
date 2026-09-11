import { errorMessage } from "@main/services/errors";
import { CALL_TRIGGER_ID, parseAliases } from "@main/services/cue-aliases";
import { APP_STATE_SOURCES, appStateRef } from "@main/services/app-state-sources";
import {
  cuePairs,
  isHiddenFromHome,
  isTogglePair,
  spokenCueName,
} from "@main/services/cue-pairs";
import type { InferredStateSource } from "@main/services/companion-state-source";
import { hasServiceGuard } from "@main/services/service-guard";
// The one main type imported rather than restated below. The wire shapes in
// this file are deliberately local — the renderer models what the API sends —
// but an OUTCOME is a closed set the server owns, and a second copy of it is a
// list that silently stops covering the log: `skipped` had to be added here by
// hand, and nothing would have said so if it had not been.
import type { AutomationOutcome } from "@main/types/automation";
import { labelFor, ruleMatchesSearch } from "./rule-search";
// The editor itself, and the field shapes it and this list share. The list
// renders the collapsed rows; the dialog is the only thing that mounts an
// editor.
import {
  CuePairState,
  RuleEditorDialog,
  type CueStateRow,
  type PairRowData,
  type Registry,
  type Rule,
  type RuleEditorTarget,
} from "./rule-editor-dialog";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useConfiguredIntegrations } from "../../main/use-integration-states";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { DownloadIcon, OctagonXIcon, PlusIcon, SearchIcon } from "lucide-react";

import { invoke, onNotification } from "../../lib/api";
import { Button, Collapsible, Input, Separator, Switch } from "../../components/ui";
import { formatClock } from "../../lib/clock-format";
import { CueAccessCard, CueButtonStatus, ImportPairsDialog } from "./companion-cues";

/**
 * One row in a section: a pair, or a single rule.
 *
 * `sortBy` is carried rather than recomputed at sort time — a pair's is the
 * words it is called, a cue's is the same, and a rule with any other trigger
 * never reaches the comparison.
 */
type RuleListEntry =
  | { kind: "pair"; key: string; sortBy: string; pair: PairRowData }
  | { kind: "rule"; key: string; sortBy: string; rule: Rule };
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
  onOpen,
  onChanged,
}: {
  rule: Rule;
  registry: Registry;
  onOpen: () => void;
  onChanged: () => void;
}) {
  const formerNames = rule.trigger.id === CALL_TRIGGER_ID ? parseAliases(rule.trigger.params) : [];
  const trigger = registry.triggers.find((t) => t.id === rule.trigger.id) ?? null;
  const action = registry.actions.find((a) => a.id === rule.action.id) ?? null;
  const isCue = rule.trigger.id === CALL_TRIGGER_ID;
  const hidden = isHiddenFromHome(rule.trigger.params);

  const summary = `When ${trigger?.label ?? rule.trigger.id}` +
    (rule.conditions.length ? ` · if ${rule.conditions.length} condition${rule.conditions.length > 1 ? "s" : ""}` : "") +
    ` · then ${action?.label ?? rule.action.id}`;

  return (
    <div className="rounded-lg border border-line bg-surface p-3">
      <div className="flex items-center gap-2">
        {/* The one control on the row that is NOT the editor: arming a rule is
            a thing an operator does down a list, and it writes at once. */}
        <Switch
          checked={rule.enabled}
          onCheckedChange={async (v) => {
            await invoke("automation:updateRule", { id: rule.id, patch: { enabled: v } });
            onChanged();
          }}
          aria-label="Enable rule"
        />
        <button type="button" className="min-w-0 flex-1 text-left" onClick={onOpen}>
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
            {isCue && <ServiceGuardBadge conditions={rule.conditions} />}
          </div>
          <div className="truncate text-caption1 text-fg-muted">{summary}</div>
          {/* What the last reconcile found about this rule's Companion button.
              Inside the row's own button, so the way to act on a `button
              missing` pill is to press the thing saying it — which opens the
              editor and its picker. Renders nothing for any other action, and
              nothing for a rule that has never been reconciled. */}
          {rule.action.id === "companion.press" && <CueButtonStatus params={rule.action.params} />}
        </button>
        {/* The same one word a pair's row carries, for a cue with no partner:
            which side of the Home Assistant / Everything else split this row is
            on, without reading the heading above it. */}
        {isCue && (
          <span
            data-cue-home={hidden ? "hidden" : "shown"}
            className={
              "shrink-0 rounded-md px-1.5 py-0.5 text-caption2 " +
              (hidden ? "text-fg-subtle" : "bg-field text-fg-muted")
            }
          >
            {hidden ? "voice only" : "Home"}
          </span>
        )}
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
  cueState,
  onOpen,
}: {
  base: string;
  name: string;
  onName: string;
  offName: string;
  hidden: boolean;
  cueState: CueStateRow | null;
  onOpen: () => void;
}) {
  return (
    <div className="rounded-lg border border-line bg-surface p-3" data-cue-pair-row={base}>
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          onClick={onOpen}
          aria-label={`${name} pair`}
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate text-footnote font-medium text-fg" data-cue-pair-name={name}>
              {name}
            </span>
            <span className="block truncate font-mono text-caption2 text-fg-subtle">
              {onName} / {offName}
            </span>
          </span>
          {cueState && <CuePairState base={base} state={cueState} />}
          {/* Compact, and only ever one word: the row is a summary, and the
              sentence explaining what hidden means is in the dialog. */}
          <span
            data-cue-home={hidden ? "hidden" : "shown"}
            className={
              "shrink-0 rounded-md px-1.5 py-0.5 text-caption2 " +
              (hidden ? "text-fg-subtle" : "bg-field text-fg-muted")
            }
          >
            {hidden ? "voice only" : "Home"}
          </span>
        </button>
      </div>
    </div>
  );
}

/**
 * A list section's heading — the name, how many ROWS are under it (a pair is
 * one), and one sentence saying what lands here.
 *
 * The sentence is not decoration: "Everything else" holding both a hidden cue
 * and a PCO-triggered rule is not something a title can say.
 */
function ListSection({
  title,
  blurb,
  count,
  children,
}: {
  title: string;
  blurb: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2" data-rule-section={title}>
      <div className="pt-1">
        <div className="flex items-baseline gap-2">
          <span className="text-caption2 font-semibold uppercase tracking-wider text-fg-muted">{title}</span>
          <span className="text-caption2 text-fg-subtle" data-rule-section-count={String(count)}>
            {count}
          </span>
        </div>
        <p className="text-caption2 text-fg-subtle">{blurb}</p>
      </div>
      {children}
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

  /**
   * The two sections, in the order they render.
   *
   * A PAIR IS ONE ROW and shows whenever EITHER half matches the query — the
   * two halves are one thing, and a search for the off cue that hid the row it
   * lives on would be a pair that cannot be found by half its own names.
   *
   * Ordering: pairs first, then single cues, each alphabetical by the words the
   * cue is called; rules with any other trigger keep their stored order after
   * the cues, because that order is the operator's own and nothing about a
   * trigger name is worth sorting by.
   */
  const sections = useMemo(() => {
    const matched = new Set(filteredRules.map((r) => r.id));
    const home: RuleListEntry[] = [];
    const other: RuleListEntry[] = [];

    const byName = (a: { sortBy: string }, b: { sortBy: string }) => a.sortBy.localeCompare(b.sortBy);
    const pairEntries = pairRows
      .filter((p) => matched.has(p.on.id) || matched.has(p.off.id))
      .map((p) => ({ kind: "pair" as const, key: p.on.id, sortBy: p.name, pair: p }))
      .sort(byName);
    const singles = filteredRules
      .filter((r) => r.trigger.id === CALL_TRIGGER_ID && !pairedRuleIds.has(r.id))
      .map((r) => ({
        kind: "rule" as const,
        key: r.id,
        sortBy: spokenCueName(r.trigger.params, String(r.trigger.params.name ?? r.name)),
        rule: r,
      }))
      .sort(byName);

    for (const e of pairEntries) (e.pair.hidden ? other : home).push(e);
    for (const e of singles) (isHiddenFromHome(e.rule.trigger.params) ? other : home).push(e);
    // Everything that is not a cue at all, in the order the operator has them.
    for (const r of filteredRules) {
      if (r.trigger.id === CALL_TRIGGER_ID) continue;
      other.push({ kind: "rule", key: r.id, sortBy: r.name, rule: r });
    }
    return { home, other };
  }, [filteredRules, pairRows, pairedRuleIds]);

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

  /** One row. A pair is ONE row holding both halves; everything else is a rule. */
  const renderEntry = (entry: RuleListEntry) => {
    if (entry.kind === "rule") {
      return (
        <RuleRow
          key={entry.key}
          rule={entry.rule}
          registry={registry!}
          onOpen={() => setEditing({ kind: "rule", id: entry.rule.id })}
          onChanged={refresh}
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
        cueState={cueStateFor(cueStateData?.states, p.base)}
        onOpen={() => setEditing({ kind: "pair", id: p.on.id })}
      />
    );
  };

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
              {/* PINNED. The app has exactly one scroller — the shell's
                  `<main>`; `html`, `body` and `#root` are all `overflow:
                  hidden` (see renderer/app/shell.tsx) — and this list is
                  rendered directly inside it, so `sticky top-0` sticks to the
                  top of the pane rather than to a window that never scrolls.
                  The background is the page's own, with a hairline under it, so
                  rows pass beneath it instead of showing through.
                  NOT unit-tested: jsdom loads no stylesheet, so `position:
                  sticky` and a background are not observable in it at all and a
                  test could only assert the class string is spelled how it is
                  spelled. Driven in a browser. */}
              <div
                className={
                  "sticky top-0 z-10 flex items-center gap-2 border-b border-line bg-bg py-2 " +
                  // The pane has 16px of its own top padding, and `sticky
                  // top-0` sticks BELOW it — leaving a strip at the top of the
                  // pane that rows scrolled through, half a row of text
                  // hanging above the bar. This paints that strip in the page
                  // background. A negative `top` would cover it too and would
                  // hang the field off the top of the pane whenever the
                  // padding is not there (it is dropped with the top band).
                  "relative before:pointer-events-none before:absolute before:inset-x-0 " +
                  "before:bottom-full before:h-4 before:bg-bg before:content-['']"
                }
              >
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
              {sections.home.length === 0 && sections.other.length === 0 ? (
                <p className="text-caption1 text-fg-muted">No rules match.</p>
              ) : (
                <>
                  {sections.home.length > 0 && (
                    <ListSection
                      title="Home Assistant"
                      blurb="Cues shown in Home Assistant and Apple Home. Pairs are switches, singles are buttons."
                      count={sections.home.length}
                    >
                      {sections.home.map(renderEntry)}
                    </ListSection>
                  )}
                  {sections.other.length > 0 && (
                    <ListSection
                      title="Everything else"
                      blurb="Cues kept out of Home Assistant, and rules with other triggers."
                      count={sections.other.length}
                    >
                      {sections.other.map(renderEntry)}
                    </ListSection>
                  )}
                </>
              )}
            </>
          )}
          <div className="flex items-center gap-2">
            <Button
              variant="filled"
              size="small"
              onClick={async () => {
                // The new rule's own editor, at once. A rule called "Rule 7"
                // with a log action and no trigger params is not a rule
                // anybody wanted — it is the start of one, and an operator left
                // looking at it in a list of two hundred has to find it again
                // to say what it does.
                const created = await invoke<Rule>("automation:addRule", {
                  name: `Rule ${rules.length + 1}`,
                  enabled: false,
                  trigger: { id: registry.triggers[0]?.id ?? "", params: {} },
                  conditions: [],
                  action: { id: "log.message", params: { message: "rule matched" } },
                  cooldownSec: 30,
                  oncePerService: false,
                });
                refresh();
                setEditing({ kind: "rule", id: created.id });
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
          dynamicOptions={dynamicOptions}
          customVariables={companionPairs?.customVariables ?? []}
          appSources={appSources}
          inferredFor={inferredFor}
          onChanged={refresh}
        />
      )}

      <ImportPairsDialog open={importing} onOpenChange={setImporting} onImported={refresh} />
      <CueAccessCard />
      <ActivityLog />
    </div>
  );
}