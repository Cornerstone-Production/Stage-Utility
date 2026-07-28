import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { OctagonXIcon, PlayIcon, PlusIcon, Trash2Icon } from "lucide-react";

import { invoke, onNotification } from "../../lib/api";
import {
  Button,
  Collapsible,
  InfoHint,
  Input,
  NumberInput,
  Separator,
  Switch,
  toast,
} from "../../components/ui";

// ── Registry shapes (functions are stripped server-side) ──────────────────────

interface ParamSpec {
  key: string;
  label: string;
  type: "number" | "string" | "enum" | "multi-enum";
  min?: number;
  max?: number;
  options?: { value: string; label: string }[];
  optionsFrom?: string;
  optional?: boolean;
  help?: string;
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
}

interface LogEntry {
  at: string;
  ruleName: string;
  triggerId: string;
  actionId: string;
  outcome: "fired" | "failed" | "simulated" | "suppressed" | "condition-not-met";
  detail: string;
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

const OUTCOME_STYLE: Record<LogEntry["outcome"], string> = {
  fired: "text-fg",
  simulated: "text-fg-muted",
  suppressed: "text-fg-subtle",
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
                {new Date(e.at).toLocaleTimeString()}
              </span>
              <span className="shrink-0 font-medium text-fg-muted">{e.ruleName}</span>
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

function RuleCard({
  rule,
  registry,
  dynamicOptions,
  onChanged,
}: {
  rule: Rule;
  registry: Registry;
  dynamicOptions: Record<string, { value: string; label: string }[]>;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Rule>(rule);
  const [busy, setBusy] = useState(false);

  useEffect(() => setDraft(rule), [rule]);

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
      toast.error(e instanceof Error ? e.message : String(e));
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
          <div className="truncate text-footnote font-medium text-fg">{rule.name}</div>
          <div className="truncate text-caption1 text-fg-muted">{summary}</div>
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
          {trigger?.params.map((p) => (
            <ParamField
              key={p.key}
              spec={p}
              value={draft.trigger.params[p.key]}
              dynamicOptions={dynamicOptions}
              onChange={(v) => setDraft({ ...draft, trigger: { ...draft.trigger, params: { ...draft.trigger.params, [p.key]: v } } })}
            />
          ))}

          <Separator />
          <span className="pt-1 text-caption2 font-semibold uppercase tracking-wider text-fg-muted">If</span>
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
          {action?.params.map((p) => (
            <ParamField
              key={p.key}
              spec={p}
              value={draft.action.params[p.key]}
              dynamicOptions={dynamicOptions}
              onChange={(v) => setDraft({ ...draft, action: { ...draft.action, params: { ...draft.action.params, [p.key]: v } } })}
            />
          ))}

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
  const dynamicOptions = useMemo(
    () => ({
      "rosstalk-targets": (rt?.targets ?? []).map((t) => ({ value: t.id, label: t.name })),
      "rosstalk-commands": (rtCmds ?? []).map((c) => ({ value: c.id, label: c.label })),
    }),
    [rt, rtCmds],
  );

  const rules = data?.rules ?? [];
  const settings = data?.settings ?? { simulate: true, disarmed: false };

  async function setSettings(patch: Record<string, boolean>) {
    await invoke("automation:setSettings", patch);
    refresh();
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-title3 font-semibold text-fg">Automation</h1>
        <p className="text-caption1 text-fg-muted">
          When something happens in Stage, do something to a device.
        </p>
      </div>

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
          {rules.length === 0 ? (
            <p className="text-caption1 text-fg-muted">
              No rules yet. Start with the <span className="font-medium text-fg">Write a log message</span> action —
              arm the rule, watch Activity through a service to confirm it fires when you expect, then swap in the
              real action.
            </p>
          ) : (
            rules.map((r) => (
              <RuleCard
                key={r.id}
                rule={r}
                registry={registry}
                dynamicOptions={dynamicOptions}
                onChanged={refresh}
              />
            ))
          )}
          <div>
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
          </div>
        </div>
      )}

      <ActivityLog />
    </div>
  );
}
