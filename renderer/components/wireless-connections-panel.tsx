import { invoke, onNotification } from "../lib/api";
import { useResyncOn } from "@renderer/lib/use-resync-on";
import { useState, useEffect, type ChangeEvent, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
  NumberInput,
  InfoHint,
  toast,
} from "../components/ui";
import {
  PlusIcon,
  TrashIcon,
  Loader2Icon,
  CheckCircle2Icon,
  XCircleIcon,
  ChevronRightIcon,
  ChevronDownIcon,
} from "lucide-react";
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

function WirelessConnectionBadge({
  connection,
  message,
}: {
  connection: ConnectionState;
  message: string | null;
}) {
  if (connection === "connected") {
    return (
      <span className="flex items-center gap-1">
        <CheckCircle2Icon className="size-3.5 text-green-10 shrink-0" />
        <span className="text-caption1 text-green-10">Connected</span>
      </span>
    );
  }
  if (connection === "connecting") {
    return (
      <span className="flex items-center gap-1">
        <Loader2Icon className="size-3.5 text-blue-10 animate-spin shrink-0" />
        <span className="text-caption1 text-blue-10">Connecting…</span>
      </span>
    );
  }
  if (connection === "error") {
    return (
      <span className="flex items-center gap-1">
        <XCircleIcon className="size-3.5 text-red-10 shrink-0" />
        <span className="text-caption1 text-red-10">{message ?? "Error"}</span>
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

// ---- single connection card -------------------------------------------------

interface ConnectionCardProps {
  conn: WirelessConnection;
  providers: IntegrationDescriptor[];
  onUpdate: (connections: WirelessConnection[]) => void;
  onRemove: (connections: WirelessConnection[]) => void;
}

function ConnectionCard({ conn, providers, onUpdate, onRemove }: ConnectionCardProps) {
  const provider = providers.find((p) => p.id === conn.providerId) ?? null;

  // Local config mirrors conn.config but tracks in-progress edits for password masking
  const [localConfig, setLocalConfig] = useState<Record<string, unknown>>(() => {
    if (!provider) return { ...conn.config };
    const out: Record<string, unknown> = {};
    for (const field of provider.configSchema) {
      const raw = conn.config[field.key];
      if (field.type === "password" && typeof raw === "string" && raw !== "") {
        out[field.key] = MASKED_PASSWORD;
      } else {
        out[field.key] = raw ?? "";
      }
    }
    return out;
  });

  const [localName, setLocalName] = useState(conn.name);
  const [testResult, setTestResult] = useState<{ ok: boolean; message?: string } | null>(null);
  const [isTesting, setIsTesting] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);

  // Collapse configured connections by default so the list stays compact — a
  // freshly-added one (no config yet) starts expanded so it's ready to edit.
  const isConfigured = !!provider && provider.configSchema.some((f) => {
    const v = conn.config[f.key];
    return v != null && v !== "" && !(Array.isArray(v) && v.length === 0);
  });
  const [expanded, setExpanded] = useState(!isConfigured);
  // A one-line summary of the configured target (e.g. host) for the collapsed row.
  const summary = provider?.configSchema
    .map((f) => conn.config[f.key])
    .find((v) => typeof v === "string" && v.trim()) as string | undefined;

  // Sync local name if the connection updates from outside (e.g. broadcast)
  useResyncOn([conn.name], () => {
    setLocalName(conn.name);
  });

  // Sync localConfig when provider changes (new schema) or connection data updates
  useResyncOn([conn.providerId, conn.config, provider], () => {
    if (!provider) {
      setLocalConfig({ ...conn.config });
      return;
    }
    const out: Record<string, unknown> = {};
    for (const field of provider.configSchema) {
      const raw = conn.config[field.key];
      if (field.type === "password" && typeof raw === "string" && raw !== "") {
        out[field.key] = MASKED_PASSWORD;
      } else {
        out[field.key] = raw ?? "";
      }
    }
    setLocalConfig(out);
  });

  async function handleNameBlur() {
    const trimmed = localName.trim();
    if (trimmed === conn.name) return;
    try {
      const next = await ipc<WirelessConnection[]>("wireless:updateConnection", {
        id: conn.id,
        patch: { name: trimmed || conn.name },
      });
      onUpdate(next);
    } catch (err) {
      console.error("[WirelessConnectionsPanel:updateName]", err);
      toast.error(`Failed to rename: ${String(err)}`);
      setLocalName(conn.name);
    }
  }

  async function handleProviderChange(providerId: string) {
    try {
      const next = await ipc<WirelessConnection[]>("wireless:updateConnection", {
        id: conn.id,
        patch: { providerId, config: {} },
      });
      onUpdate(next);
    } catch (err) {
      console.error("[WirelessConnectionsPanel:updateProvider]", err);
      toast.error(`Failed to change provider: ${String(err)}`);
    }
  }

  async function handleConfigFieldBlur(key: string) {
    if (!provider) return;
    const field = provider.configSchema.find((f) => f.key === key);
    if (!field) return;

    const v = localConfig[key];
    // Skip if password is still masked
    if (field.type === "password" && typeof v === "string" && isPasswordMasked(v)) return;

    try {
      const next = await ipc<WirelessConnection[]>("wireless:updateConnection", {
        id: conn.id,
        patch: { config: { ...conn.config, [key]: v } },
      });
      onUpdate(next);
    } catch (err) {
      console.error("[WirelessConnectionsPanel:updateConfig]", err);
      toast.error(`Failed to save: ${String(err)}`);
    }
  }

  async function handleConfigSelectChange(key: string, value: unknown) {
    setLocalConfig((prev) => ({ ...prev, [key]: value }));
    try {
      const next = await ipc<WirelessConnection[]>("wireless:updateConnection", {
        id: conn.id,
        patch: { config: { ...conn.config, [key]: value } },
      });
      onUpdate(next);
    } catch (err) {
      console.error("[WirelessConnectionsPanel:updateConfigSelect]", err);
      toast.error(`Failed to save: ${String(err)}`);
    }
  }

  async function handleIpListChange(key: string, value: string[]) {
    setLocalConfig((prev) => ({ ...prev, [key]: value }));
    try {
      const next = await ipc<WirelessConnection[]>("wireless:updateConnection", {
        id: conn.id,
        patch: { config: { ...conn.config, [key]: value } },
      });
      onUpdate(next);
    } catch (err) {
      console.error("[WirelessConnectionsPanel:updateIpList]", err);
      toast.error(`Failed to save: ${String(err)}`);
    }
  }

  async function handleEnabledChange(enabled: boolean) {
    try {
      const next = await ipc<WirelessConnection[]>("wireless:updateConnection", {
        id: conn.id,
        patch: { enabled },
      });
      onUpdate(next);
    } catch (err) {
      toast.error(`Failed to ${enabled ? "enable" : "disable"}: ${String(err)}`);
    }
  }

  async function handleTest() {
    setIsTesting(true);
    setTestResult(null);
    try {
      const result = await ipc<{ ok: boolean; message?: string }>("wireless:testConnection", {
        id: conn.id,
      });
      setTestResult(result);
    } catch (err) {
      setTestResult({ ok: false, message: String(err) });
    } finally {
      setIsTesting(false);
    }
  }

  async function handleRemove() {
    setIsRemoving(true);
    try {
      const next = await ipc<WirelessConnection[]>("wireless:removeConnection", { id: conn.id });
      onRemove(next);
    } catch (err) {
      toast.error(`Failed to remove: ${String(err)}`);
      setIsRemoving(false);
    }
  }

  // Build a config-change handler that routes select/ip-list immediately and
  // text/password/number on blur
  function handleConfigChange(key: string, value: unknown) {
    setLocalConfig((prev) => ({ ...prev, [key]: value }));
  }

  // Render schema but intercept select and ip-list with immediate-save handlers
  function renderConfigFields() {
    if (!provider || provider.configSchema.length === 0) return null;

    return (
      <FieldSet>
        <FieldGroup>
          {provider.configSchema.map((field) => {
            const value = localConfig[field.key];

            return (
              <Field key={field.key} orientation="horizontal">
                <FieldContent>
                  <FieldLabel className="flex items-center gap-1.5">
                    {field.label}
                    {field.help && <InfoHint>{field.help}</InfoHint>}
                  </FieldLabel>
                  {field.placeholder && (
                    <FieldDescription>{field.placeholder}</FieldDescription>
                  )}
                </FieldContent>

                {field.type === "select" ? (
                  <Select
                    value={typeof value === "string" ? value : ""}
                    onValueChange={(v: string) => handleConfigSelectChange(field.key, v)}
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
                    onChange={(v) => handleIpListChange(field.key, v)}
                    placeholder={field.placeholder}
                  />
                ) : field.type === "number" ? (
                  <NumberInput
                    value={typeof value === "number" ? value : Number(value) || 0}
                    onChange={(n) => handleConfigChange(field.key, String(n))}
                    onCommit={() => handleConfigFieldBlur(field.key)}
                    className="w-44"
                    aria-label={field.label}
                  />
                ) : (
                  <Input
                    type={field.type === "password" ? "password" : "text"}
                    value={
                      typeof value === "string" || typeof value === "number" ? String(value) : ""
                    }
                    onChange={(e: ChangeEvent<HTMLInputElement>) =>
                      handleConfigChange(field.key, e.target.value)
                    }
                    onBlur={() => handleConfigFieldBlur(field.key)}
                    placeholder={field.placeholder ?? ""}
                    className="w-44"
                  />
                )}
              </Field>
            );
          })}
        </FieldGroup>
      </FieldSet>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Header: collapse toggle + name input + provider select + enable + remove */}
      <div className="flex items-center gap-2">
        <Button
          variant="transparent"
          size="small"
          iconOnly
          onClick={() => setExpanded((v) => !v)}
          aria-label={expanded ? "Collapse" : "Expand"}
        >
          {expanded ? (
            <ChevronDownIcon className="size-4 text-gray-9" />
          ) : (
            <ChevronRightIcon className="size-4 text-gray-9" />
          )}
        </Button>
        <Input
          value={localName}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setLocalName(e.target.value)}
          onBlur={handleNameBlur}
          placeholder="Connection name"
          className="w-36 min-w-0"
          aria-label="Connection name"
        />

        <Select value={conn.providerId} onValueChange={handleProviderChange}>
          <SelectTrigger className="w-40">
            <SelectValue placeholder="Select provider…" />
          </SelectTrigger>
          <SelectContent>
            {providers.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="flex-1 min-w-0" />

        <WirelessConnectionBadge connection={conn.connection} message={conn.message} />
        <Switch
          checked={conn.enabled}
          onCheckedChange={handleEnabledChange}
          aria-label={`Enable ${conn.name}`}
        />

        <Button
          variant="transparent"
          size="small"
          iconOnly
          onClick={handleRemove}
          disabled={isRemoving}
          aria-label="Remove connection"
        >
          {isRemoving ? (
            <Loader2Icon className="size-3.5 text-gray-9 animate-spin" />
          ) : (
            <TrashIcon className="size-3.5 text-red-10" />
          )}
        </Button>
      </div>

      {expanded ? (
        <>
          {/* Type-specific config */}
          {renderConfigFields()}

          {/* Test row */}
          <div className="flex items-center gap-2">
            <Button variant="transparent" size="small" onClick={handleTest} disabled={isTesting}>
              {isTesting ? <Loader2Icon className="size-3.5 text-gray-9 animate-spin" /> : null}
              Test
            </Button>
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
                {testResult.ok
                  ? (testResult.message ?? "OK")
                  : (testResult.message ?? "Failed")}
              </span>
            )}
            {conn.message && !testResult && (
              <span className="text-caption1 text-gray-9">{conn.message}</span>
            )}
          </div>
        </>
      ) : (
        summary && <span className="pl-9 text-caption2 text-gray-9">{summary}</span>
      )}
    </div>
  );
}

// ---- main export ------------------------------------------------------------

interface WirelessConnectionsPanelProps {
  className?: string;
}

export function WirelessConnectionsPanel({ className }: WirelessConnectionsPanelProps) {
  const queryClient = useQueryClient();

  const providersQuery = useQuery({
    queryKey: ["wireless:listProviders"],
    queryFn: () => ipc<IntegrationDescriptor[]>("wireless:listProviders"),
    retry: 1,
  });
  const connectionsQuery = useQuery({
    queryKey: ["wireless:listConnections"],
    queryFn: () => ipc<WirelessConnection[]>("wireless:listConnections"),
    retry: 1,
  });

  const providers = providersQuery.data ?? [];
  const connections = connectionsQuery.data ?? [];
  const isLoading = providersQuery.isLoading || connectionsQuery.isLoading;
  const loadError = providersQuery.error ?? connectionsQuery.error;
  function retryLoad() {
    void providersQuery.refetch();
    void connectionsQuery.refetch();
  }

  // Global polling/metering interval (ms), applied to all wireless gear.
  const { data: meterData } = useQuery({
    queryKey: ["wireless:getMeterRate"],
    queryFn: () => ipc<{ ms: number }>("wireless:getMeterRate"),
  });
  const [meterInput, setMeterInput] = useState<string>("1000");
  useResyncOn([meterData], () => {
    if (meterData) setMeterInput(String(meterData.ms));
  });

  async function commitMeterRate() {
    const ms = parseInt(meterInput, 10);
    if (!Number.isFinite(ms) || ms < 0) {
      setMeterInput(String(meterData?.ms ?? 1000));
      return;
    }
    if (ms === meterData?.ms) return;
    try {
      const next = await ipc<{ ms: number }>("wireless:setMeterRate", { ms });
      queryClient.setQueryData(["wireless:getMeterRate"], next);
      setMeterInput(String(next.ms));
      toast.success(`Polling interval set to ${next.ms} ms`);
    } catch (err) {
      toast.error(`Failed to set polling interval: ${String(err)}`);
      setMeterInput(String(meterData?.ms ?? 1000));
    }
  }

  // Live updates from backend
  useEffect(() => {
    const unsub = onNotification(
      "wireless:connections-changed",
      (payload: unknown) => {
        queryClient.setQueryData(["wireless:listConnections"], payload as WirelessConnection[]);
        // Also invalidate the channels list so slot editor stays in sync
        queryClient.invalidateQueries({ queryKey: ["wireless:listChannels"] });
      },
    );
    return unsub;
  }, [queryClient]);

  function applyUpdate(next: WirelessConnection[]) {
    queryClient.setQueryData(["wireless:listConnections"], next);
    queryClient.invalidateQueries({ queryKey: ["wireless:listChannels"] });
  }

  async function handleAdd() {
    try {
      const next = await ipc<WirelessConnection[]>("wireless:addConnection", {});
      applyUpdate(next);
    } catch (err) {
      toast.error(`Failed to add connection: ${String(err)}`);
    }
  }

  // Polling-interval control — shown above the connection list regardless of state.
  const meterRateField = (
    <div className="flex items-center gap-2 pb-3 mb-1 border-b border-gray-a3">
      <div className="flex flex-col flex-1 min-w-0">
        <span className="text-body text-gray-12">Polling interval</span>
        <span className="text-caption1 text-gray-9">
          How often all wireless gear is queried for status.
        </span>
      </div>
      <NumberInput
        value={Number(meterInput) || 0}
        onChange={(n) => setMeterInput(String(n))}
        onCommit={commitMeterRate}
        step={100}
        min={0}
        suffix="ms"
        className="w-44"
        aria-label="Polling interval in milliseconds"
      />
    </div>
  );

  let body: ReactNode;
  if (loadError && !isLoading) {
    body = (
      <div className="flex flex-col items-start gap-2 py-3">
        <span className="flex items-center gap-1.5 text-body text-red-10">
          <XCircleIcon className="size-4 shrink-0" />
          Couldn’t load wireless connections.
        </span>
        <span className="text-caption1 text-gray-9">
          {loadError instanceof Error ? loadError.message : String(loadError)}
        </span>
        <Button variant="filled" size="small" onClick={retryLoad} className="mt-1">
          Retry
        </Button>
      </div>
    );
  } else if (isLoading) {
    body = (
      <div className="flex items-center justify-center py-6">
        <Loader2Icon className="size-5 text-gray-9 animate-spin" />
      </div>
    );
  } else if (connections.length === 0) {
    body = (
      <div className="flex flex-col items-start gap-2 py-1">
        <span className="text-body text-gray-11">No wireless connections</span>
        <span className="text-caption1 text-gray-9">
          Add a connection to monitor wireless microphone status.
        </span>
        <Button variant="filled" size="small" onClick={handleAdd} className="mt-1">
          <PlusIcon className="size-3.5 text-gray-9" />
          Add connection
        </Button>
      </div>
    );
  } else {
    body = (
      <div className="flex flex-col gap-0">
        {connections.map((conn, idx) => (
          <div key={conn.id}>
            {idx > 0 && <Separator className="my-4" />}
            <ConnectionCard
              conn={conn}
              providers={providers}
              onUpdate={applyUpdate}
              onRemove={applyUpdate}
            />
          </div>
        ))}
        <Separator className="my-4" />
        <Button variant="filled" size="small" onClick={handleAdd} className="self-start">
          <PlusIcon className="size-3.5 text-gray-9" />
          Add connection
        </Button>
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col gap-0", className)}>
      {meterRateField}
      {body}
    </div>
  );
}
