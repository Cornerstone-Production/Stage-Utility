import { invoke, onNotification } from "../lib/api";
import { useStageState } from "../main/use-stage-state";
import { useState, useEffect, useCallback, type ChangeEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { WirelessConnectionsPanel } from "./wireless-connections-panel";
import { CaptionColorsPanel } from "./caption-colors-panel";
import { CompanionInfoPanel } from "./companion-info-panel";
import {
  Button,
  Field,
  FieldSet,
  FieldGroup,
  FieldContent,
  FieldLabel,
  FieldDescription,
  Input,
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
  Switch,
  Status,
  Separator,
  toast,
} from "../components/ui";
import { PlusIcon, TrashIcon, Loader2Icon, CheckCircle2Icon, XCircleIcon, RefreshCwIcon } from "lucide-react";
import { cn } from "../lib/cn";

// ---- helpers ----------------------------------------------------------------

function ipc<T>(channel: string, ...args: unknown[]): Promise<T> {
  return invoke<T>(channel, args[0] as Record<string, unknown> | undefined);
}

const MASKED_PASSWORD = "••••••••";

function isPasswordMasked(value: string): boolean {
  return /^•+$/.test(value);
}

// ---- sub-components ---------------------------------------------------------

interface IpListFieldProps {
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
}

function IpListField({ value, onChange, placeholder }: IpListFieldProps) {
  function update(idx: number, v: string) {
    const next = [...value];
    next[idx] = v;
    onChange(next);
  }
  function remove(idx: number) {
    onChange(value.filter((_, i) => i !== idx));
  }
  function add() {
    onChange([...value, ""]);
  }

  return (
    <div className="flex flex-col gap-1 w-full">
      {value.map((ip, idx) => (
        <div key={idx} className="flex items-center gap-1">
          <Input
            value={ip}
            onChange={(e: ChangeEvent<HTMLInputElement>) => update(idx, e.target.value)}
            placeholder={placeholder ?? "192.168.1.x"}
            className="flex-1 min-w-0"
          />
          <Button
            variant="transparent"
            size="small"
            iconOnly
            onClick={() => remove(idx)}
            aria-label="Remove"
          >
            <TrashIcon className="size-3.5 text-gray-9" />
          </Button>
        </div>
      ))}
      <Button variant="transparent" size="small" onClick={add} className="self-start">
        <PlusIcon className="size-3.5 text-gray-9" />
        Add IP
      </Button>
    </div>
  );
}

// ---- connection badge -------------------------------------------------------

function ConnectionBadge({ state }: { state: IntegrationState }) {
  if (state.connection === "connected") {
    return (
      <span className="flex items-center gap-1">
        <CheckCircle2Icon className="size-3.5 text-green-10 shrink-0" />
        <span className="text-caption1 text-green-10">Connected</span>
      </span>
    );
  }
  if (state.connection === "connecting") {
    return (
      <span className="flex items-center gap-1">
        <Loader2Icon className="size-3.5 text-blue-10 animate-spin shrink-0" />
        <span className="text-caption1 text-blue-10">Connecting…</span>
      </span>
    );
  }
  if (state.connection === "error") {
    return (
      <span className="flex items-center gap-1">
        <XCircleIcon className="size-3.5 text-red-10 shrink-0" />
        <span className="text-caption1 text-red-10">{state.message ?? "Error"}</span>
      </span>
    );
  }
  // disconnected
  return (
    <span className="flex items-center gap-1">
      <Status variant="warning" />
      <span className="text-caption1 text-gray-9">Disconnected</span>
    </span>
  );
}

// ---- single integration card ------------------------------------------------

interface IntegrationCardProps {
  descriptor: IntegrationDescriptor;
  state: IntegrationState;
  onStateChange: (s: IntegrationState) => void;
  /** ISO timestamp of the last successful PCO sync (planning-center card only). */
  lastRefreshedAt?: string | null;
}

// "Synced 12:52 PM" for the PCO Refresh-now row; "Never synced" when null/invalid.
function fmtSynced(iso: string | null | undefined): string {
  if (!iso) return "Never synced";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Never synced";
  return `Synced ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

function IntegrationCard({ descriptor, state, onStateChange, lastRefreshedAt }: IntegrationCardProps) {
  // Local config mirrors state.config but tracks in-progress edits
  const [localConfig, setLocalConfig] = useState<Record<string, unknown>>(() => {
    // Mask password fields coming from backend
    const out: Record<string, unknown> = {};
    for (const field of descriptor.configSchema) {
      const raw = state.config[field.key];
      if (field.type === "password" && typeof raw === "string" && raw !== "") {
        out[field.key] = MASKED_PASSWORD;
      } else {
        out[field.key] = raw ?? "";
      }
    }
    return out;
  });

  const [testResult, setTestResult] = useState<{ ok: boolean; message?: string } | null>(null);
  const [isTesting, setIsTesting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isTogglingEnabled, setIsTogglingEnabled] = useState(false);

  function setField(key: string, value: unknown) {
    setLocalConfig((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSave() {
    setIsSaving(true);
    try {
      // Build config — skip password fields that still show the mask
      const config: Record<string, unknown> = {};
      for (const field of descriptor.configSchema) {
        const v = localConfig[field.key];
        if (field.type === "password" && typeof v === "string" && isPasswordMasked(v)) {
          // User hasn't changed this password — omit so the backend keeps the original
          continue;
        }
        config[field.key] = v;
      }
      console.log("[IntegrationsPanel:save]", descriptor.id, Object.keys(config));
      const next = await ipc<IntegrationState>("integrations:setConfig", { id: descriptor.id, config });
      onStateChange(next);
      toast.success(`${descriptor.label} settings saved.`);
    } catch (err) {
      console.error("[IntegrationsPanel:save] error", err);
      toast.error(`Failed to save: ${String(err)}`);
    } finally {
      setIsSaving(false);
    }
  }

  async function handleRefresh() {
    setIsRefreshing(true);
    try {
      await ipc("stage:refresh");
      toast.success("Plan refreshed from PCO.");
    } catch (err) {
      toast.error(`Refresh failed: ${String(err)}`);
    } finally {
      setIsRefreshing(false);
    }
  }

  async function handleTest() {
    setIsTesting(true);
    setTestResult(null);
    try {
      const result = await ipc<{ ok: boolean; message?: string }>("integrations:test", { id: descriptor.id });
      console.log("[IntegrationsPanel:test]", descriptor.id, result);
      setTestResult(result);
    } catch (err) {
      console.error("[IntegrationsPanel:test] error", err);
      setTestResult({ ok: false, message: String(err) });
    } finally {
      setIsTesting(false);
    }
  }

  async function handleToggleEnabled(enabled: boolean) {
    setIsTogglingEnabled(true);
    try {
      const next = await ipc<IntegrationState>("integrations:setEnabled", { id: descriptor.id, enabled });
      onStateChange(next);
    } catch (err) {
      toast.error(`Failed to ${enabled ? "enable" : "disable"}: ${String(err)}`);
    } finally {
      setIsTogglingEnabled(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Header row: label + enabled switch + connection badge */}
      <div className="flex items-center gap-3">
        <span className="text-headline font-semibold text-gray-12 flex-1 min-w-0 truncate">
          {descriptor.label}
        </span>
        <ConnectionBadge state={state} />
        <Switch
          checked={state.enabled}
          onCheckedChange={handleToggleEnabled}
          disabled={isTogglingEnabled}
          aria-label={`Enable ${descriptor.label}`}
        />
      </div>

      {/* Schema-driven form */}
      <FieldSet>
        <FieldGroup>
          {descriptor.configSchema.map((field) => {
            const value = localConfig[field.key];

            return (
              <Field key={field.key} orientation="horizontal">
                <FieldContent>
                  <FieldLabel>{field.label}</FieldLabel>
                  {field.placeholder && (
                    <FieldDescription>{field.placeholder}</FieldDescription>
                  )}
                </FieldContent>

                {field.type === "select" ? (
                  <Select
                    value={typeof value === "string" ? value : ""}
                    onValueChange={(v: string) => setField(field.key, v)}
                  >
                    <SelectTrigger className="w-44">
                      <SelectValue placeholder="Select…" />
                    </SelectTrigger>
                    <SelectContent>
                      {(field.options ?? []).map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : field.type === "ip-list" ? (
                  <IpListField
                    value={Array.isArray(value) ? (value as string[]) : []}
                    onChange={(v) => setField(field.key, v)}
                    placeholder={field.placeholder}
                  />
                ) : (
                  <Input
                    type={field.type === "password" ? "password" : field.type === "number" ? "number" : "text"}
                    value={typeof value === "string" || typeof value === "number" ? String(value) : ""}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => setField(field.key, e.target.value)}
                    placeholder={field.placeholder ?? ""}
                    className="w-44"
                  />
                )}
              </Field>
            );
          })}
        </FieldGroup>
      </FieldSet>

      {/* Actions row */}
      <div className="flex items-center gap-2">
        <Button variant="filled" size="small" onClick={handleSave} disabled={isSaving}>
          {isSaving ? <Loader2Icon className="size-3.5 text-gray-9 animate-spin" /> : null}
          Save
        </Button>
        <Button variant="transparent" size="small" onClick={handleTest} disabled={isTesting}>
          {isTesting ? <Loader2Icon className="size-3.5 text-gray-9 animate-spin" /> : null}
          Test connection
        </Button>
        {descriptor.id === "planning-center" && (
          <>
            <Button variant="transparent" size="small" onClick={handleRefresh} disabled={isRefreshing}>
              {isRefreshing
                ? <Loader2Icon className="size-3.5 text-gray-9 animate-spin" />
                : <RefreshCwIcon className="size-3.5 text-gray-9" />}
              Refresh now
            </Button>
            <span className="text-caption1 text-gray-9 tabular-nums">{fmtSynced(lastRefreshedAt)}</span>
          </>
        )}
        {testResult !== null && (
          <span
            className={cn(
              "text-caption1 flex items-center gap-1",
              testResult.ok ? "text-green-10" : "text-red-10",
            )}
          >
            {testResult.ok ? (
              <CheckCircle2Icon className="size-3.5 text-green-10 shrink-0" />
            ) : (
              <XCircleIcon className="size-3.5 text-red-10 shrink-0" />
            )}
            {testResult.ok ? (testResult.message ?? "OK") : (testResult.message ?? "Failed")}
          </span>
        )}
      </div>
    </div>
  );
}

// ---- main export ------------------------------------------------------------

interface IntegrationsPanelProps {
  className?: string;
}

export function IntegrationsPanel({ className }: IntegrationsPanelProps) {
  const queryClient = useQueryClient();
  const { state: stageState } = useStageState();

  const { data, isLoading, error } = useQuery({
    queryKey: ["integrations:list"],
    queryFn: () =>
      ipc<{ descriptors: IntegrationDescriptor[]; states: IntegrationState[] }>("integrations:list"),
  });

  // Live state updates from backend broadcasts
  useEffect(() => {
    const unsub = onNotification(
      "integrations:state-changed",
      (payload: unknown) => {
        const states = payload as IntegrationState[];
        queryClient.setQueryData(
          ["integrations:list"],
          (prev: { descriptors: IntegrationDescriptor[]; states: IntegrationState[] } | undefined) => {
            if (!prev) return prev;
            return { ...prev, states };
          },
        );
      },
    );
    return unsub;
  }, [queryClient]);

  const handleStateChange = useCallback(
    (updated: IntegrationState) => {
      queryClient.setQueryData(
        ["integrations:list"],
        (prev: { descriptors: IntegrationDescriptor[]; states: IntegrationState[] } | undefined) => {
          if (!prev) return prev;
          return {
            ...prev,
            states: prev.states.map((s) => (s.id === updated.id ? updated : s)),
          };
        },
      );
    },
    [queryClient],
  );

  if (isLoading) {
    return (
      <div className={cn("flex items-center justify-center py-8", className)}>
        <Loader2Icon className="size-5 text-gray-9 animate-spin" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className={cn("flex items-center justify-center py-8", className)}>
        <span className="text-body text-red-10">Failed to load integrations.</span>
      </div>
    );
  }

  const { descriptors, states } = data;
  const stateMap = new Map(states.map((s) => [s.id, s]));

  return (
    <div className={cn("flex flex-col gap-0", className)}>
      {descriptors.map((descriptor, idx) => {
        const state = stateMap.get(descriptor.id);
        if (!state) return null;
        return (
          <div key={descriptor.id}>
            {idx > 0 && <Separator className="my-4" />}
            {descriptor.kind === "wireless" ? (
              <div className="flex flex-col gap-3">
                <span className="text-headline font-semibold text-gray-12">
                  {descriptor.label}
                </span>
                <WirelessConnectionsPanel />
              </div>
            ) : descriptor.id === "companion" ? (
              // Companion connects TO this app — there's nothing to enable, save,
              // or test here, so skip the card chrome and just show the status +
              // the connect-info panel.
              <div className="flex flex-col gap-3">
                <div className="flex items-center gap-3">
                  <span className="text-headline font-semibold text-gray-12 flex-1 min-w-0 truncate">
                    {descriptor.label}
                  </span>
                  <ConnectionBadge state={state} />
                </div>
                <CompanionInfoPanel state={state} />
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                <IntegrationCard
                  descriptor={descriptor}
                  state={state}
                  onStateChange={handleStateChange}
                  lastRefreshedAt={stageState?.lastRefreshedAt ?? null}
                />
                {/* Per-channel caption colors, tucked under the ProdCom card. */}
                {descriptor.id === "prodcom" && <CaptionColorsPanel />}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
