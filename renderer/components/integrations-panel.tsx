import { errorMessage } from "@main/services/errors";
import { invoke, onNotification } from "../lib/api";
import { Tooltip } from "./ui/tooltip";
import { useStageState } from "../main/use-stage-state";
import { usePeopleCountState } from "../main/use-people-count-state";
import { usePropInstances } from "../main/use-dashboard-state";
import { useState, useEffect, useCallback, type ChangeEvent, type ReactNode } from "react";
import { useRevealNonce } from "../app/flash";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { WirelessConnectionsPanel } from "./wireless-connections-panel";
import { OscTargetsPanel } from "./osc-targets-panel";
import { ScoresTeamsPanel } from "../settings/panels/scores-teams-panel";
import { RossTalkTargetsPanel } from "./rosstalk-targets-panel";
import { CompanionInfoPanel } from "./companion-info-panel";
import { CaptionColorsPanel } from "./caption-colors-panel";
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
  Collapsible,
  NumberInput,
  toast,
  confirm,
  SkeletonRows,
  InfoHint,
  UnsavedBanner,
} from "../components/ui";
import { PlusIcon, TrashIcon, Loader2Icon, CheckCircle2Icon, XCircleIcon, RefreshCwIcon, EraserIcon } from "lucide-react";
import { cn } from "../lib/cn";
import { formatClock } from "../lib/clock-format";

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

function ConnectionBadge({
  connection,
  message,
  inbound,
}: {
  connection: ConnectionState;
  message?: string | null;
  /** Nothing dials out, so "disconnected" would name a fault where there is
   *  only an empty room. A listener with no client yet is waiting, not down. */
  inbound?: boolean;
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
        <Loader2Icon className="size-3.5 text-accent animate-spin shrink-0" />
        <span className="text-caption1 text-accent">Connecting…</span>
      </span>
    );
  }
  if (connection === "error") {
    // Truncate a long error (e.g. "Can't reach 192.168.x.x — ECONNREFUSED…") so it
    // never overflows its row; the full text shows on hover via the native title.
    return (
      <Tooltip label={message ?? "Error"}>
        <span className="flex items-center gap-1 min-w-0 max-w-[9rem] sm:max-w-md" aria-label={message ?? "Error"}>
          <XCircleIcon className="size-3.5 text-red-10 shrink-0" />
          <span className="text-caption1 text-red-10 truncate min-w-0">{message ?? "Error"}</span>
        </span>
      </Tooltip>
    );
  }
  // disconnected
  return (
    <span className="flex items-center gap-1">
      <Status variant={inbound ? "neutral" : "warning"} />
      <span className="text-caption1 text-gray-9">{inbound ? "No clients yet" : "Disconnected"}</span>
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
  return `Synced ${formatClock(d)}`;
}

/** The form's starting values for an integration — the saved config, with password
 *  fields masked and unset numbers prefilled from their default/placeholder.
 *  Hoisted out of the component so Discard can rebuild exactly the same thing. */
function initialConfig(
  descriptor: IntegrationDescriptor,
  state: IntegrationState,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of descriptor.configSchema) {
    const raw = state.config[field.key];
    if (field.type === "password" && typeof raw === "string" && raw !== "") {
      out[field.key] = MASKED_PASSWORD;
    } else if (field.type === "number") {
      // Unset numeric fields (e.g. an API port) prefill the integration's
      // default — field.default if declared, else the numeric placeholder
      // (the shown default) — so the field displays and saves the real port
      // instead of a bare 0.
      const fallback =
        field.default ?? (field.placeholder != null && field.placeholder !== "" ? Number(field.placeholder) : undefined);
      const rawNum = raw == null || raw === "" ? NaN : Number(raw);
      out[field.key] = Number.isFinite(rawNum) && rawNum > 0 ? rawNum : (fallback ?? "");
    } else {
      out[field.key] = raw ?? field.default ?? "";
    }
  }
  return out;
}

function IntegrationCard({ descriptor, state, onStateChange, lastRefreshedAt }: IntegrationCardProps) {
  // Local config mirrors state.config but tracks in-progress edits
  const [localConfig, setLocalConfig] = useState<Record<string, unknown>>(() =>
    initialConfig(descriptor, state),
  );

  const [testResult, setTestResult] = useState<{ ok: boolean; message?: string } | null>(null);
  const [isTesting, setIsTesting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  // Compare against the saved config rather than tracking a flag, so Save/Discard
  // appear only for genuine edits — and disappear again on their own after a save.
  const pristine = initialConfig(descriptor, state);
  const dirty = JSON.stringify(localConfig) !== JSON.stringify(pristine);
  const [isRefreshing, setIsRefreshing] = useState(false);

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
      // Re-seed the form from what was actually saved. `dirty` compares the form
      // against initialConfig(state), and that is not always what was typed: a
      // password comes back MASKED, and any value the backend normalises comes
      // back in its own form. Leaving the typed value in place made the two
      // permanently unequal, so "Unsaved changes" stayed up after a successful
      // save — most visibly after changing a secret.
      setLocalConfig(initialConfig(descriptor, next));
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

  const [isClearing, setIsClearing] = useState(false);
  /**
   * Empty the transcript on every display at once.
   *
   * Here because a line CAN get stuck with nothing an operator can do: a partial
   * whose channel was renamed mid-service has no final coming to clear it, and
   * before this the only way out was restarting the server. That case is fixed,
   * but "the board is showing something I do not want on it, right now" deserves
   * a control regardless.
   */
  async function handleClearTranscript() {
    if (!(await confirm({
      title: "Clear the transcript?",
      message: "Every transcription display goes empty. New lines carry on arriving from ProdCom.",
      confirmLabel: "Clear",
    }))) return;
    setIsClearing(true);
    try {
      await invoke("prodcom:clearTranscript");
      toast.success("Transcript cleared.");
    } catch (err) {
      toast.error(`Could not clear the transcript: ${errorMessage(err)}`);
    } finally {
      setIsClearing(false);
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

  return (
    // Getting-started sends "Connect Planning Center" straight at this card's form.
    <div
      className="flex flex-col gap-3"
      data-flash-id={integrationFlashId(descriptor.id)}
    >
      {/* Schema-driven form */}
      <FieldSet flat>
        <FieldGroup>
          {descriptor.configSchema.map((field) => {
            const value = localConfig[field.key];
            // A field that belongs to the other way of connecting. Hidden rather
            // than disabled: it is not a control you could use, it is one this
            // setup has no question for. Its saved value is untouched.
            if (field.showIf && String(localConfig[field.showIf.key] ?? "") !== field.showIf.equals) {
              return null;
            }

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
                    onValueChange={(v: string) => setField(field.key, v)}
                  >
                    <SelectTrigger className="w-44" aria-label={field.label}>
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
                ) : field.type === "number" ? (
                  <NumberInput
                    value={typeof value === "number" ? value : Number(value) || 0}
                    onChange={(n) => setField(field.key, String(n))}
                    className="w-44"
                    aria-label={field.label}
                  />
                ) : (
                  <Input
                    type={field.type === "password" ? "password" : "text"}
                    value={typeof value === "string" || typeof value === "number" ? String(value) : ""}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => setField(field.key, e.target.value)}
                    placeholder={field.placeholder ?? ""}
                    className="w-44"
                    aria-label={field.label}
                  />
                )}
              </Field>
            );
          })}
        </FieldGroup>
      </FieldSet>

      {descriptor.id === "sensource" && (
        <SenSourceScopePicker state={state} onStateChange={onStateChange} />
      )}

      {descriptor.id === "ross-tsl" && (
        <RossTslFeedsPanel state={state} onStateChange={onStateChange} />
      )}

      {descriptor.id === "propresenter" && (
        <ProPresenterInstancesPanel state={state} onStateChange={onStateChange} />
      )}

      {/* Unsaved changes — same bar as the patch sheet and the layout editor, so
          "you have edits" reads identically everywhere in the app. */}
      {dirty && (
        <UnsavedBanner
          compact
          className="self-start"
          saving={isSaving}
          onSave={handleSave}
          onDiscard={() => setLocalConfig(initialConfig(descriptor, state))}
        />
      )}

      {/* Actions row */}
      <div className="flex items-center gap-2">
        <Button variant="transparent" size="small" onClick={handleTest} disabled={isTesting}>
          {isTesting ? <Loader2Icon className="size-3.5 text-gray-9 animate-spin" /> : null}
          Test connection
        </Button>
        {descriptor.id === "prodcom" && (
          <Button variant="transparent" size="small" onClick={handleClearTranscript} disabled={isClearing}>
            {isClearing
              ? <Loader2Icon className="size-3.5 text-gray-9 animate-spin" />
              : <EraserIcon className="size-3.5 text-gray-9" />}
            Clear transcript
          </Button>
        )}
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

// ---- SenSource scope picker -------------------------------------------------

interface VeaZone {
  zoneId: string;
  name: string;
  locationId: string | null;
}

// Scopes the people count. The Vea /data/traffic endpoint has NO working
// server-side location/zone filter (confirmed against the public API + every
// reference client), so the *reliable* filter is an explicit zone selection that
// the backend enforces client-side. Location is an optional convenience: it
// narrows which zones are offered (when the API exposes a zone→location link)
// and the backend will map it to its zones when no zones are picked. With nothing
// selected, every visible zone is counted. Persists locationId + zoneIds as
// non-secret config.
function SenSourceScopePicker({
  state,
  onStateChange,
}: {
  state: IntegrationState;
  onStateChange: (next: IntegrationState) => void;
}) {
  const current = typeof state.config.locationId === "string" ? state.config.locationId : "";
  const selectedZoneIds = Array.isArray(state.config.zoneIds)
    ? (state.config.zoneIds as unknown[]).filter((z): z is string => typeof z === "string")
    : [];
  // Whether the lists load themselves on mount, so a saved location/zone renders
  // by name rather than as a bare id. Decided once, and it seeds the spinners —
  // starting them on is what lets the mount load do all its state updates after
  // the await, rather than flipping a flag on the way in.
  const autoLoad = state.configured || !!current || selectedZoneIds.length > 0;

  const [locations, setLocations] = useState<{ locationId: string; name: string }[]>([]);
  const [zones, setZones] = useState<VeaZone[]>([]);
  const [loading, setLoading] = useState(autoLoad);
  const [zonesLoading, setZonesLoading] = useState(autoLoad);
  const [error, setError] = useState<string | null>(null);

  const loadLocations = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setLocations(await invoke<{ locationId: string; name: string }[]>("sensource:listLocations"));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadZones = useCallback(async () => {
    setZonesLoading(true);
    setError(null);
    try {
      setZones(await invoke<VeaZone[]>("sensource:listZones"));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setZonesLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!autoLoad) return;
    let cancelled = false;
    void (async () => {
      try {
        const [locs, zs] = await Promise.all([
          invoke<{ locationId: string; name: string }[]>("sensource:listLocations"),
          invoke<VeaZone[]>("sensource:listZones"),
        ]);
        if (cancelled) return;
        setLocations(locs);
        setZones(zs);
      } catch (err) {
        if (!cancelled) setError(errorMessage(err));
      } finally {
        if (!cancelled) {
          setLoading(false);
          setZonesLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function save(patch: Record<string, unknown>) {
    try {
      const next = await invoke<IntegrationState>("integrations:setConfig", { id: "sensource", config: patch });
      onStateChange(next);
    } catch (err) {
      toast.error(`Could not save: ${String(err)}`);
    }
  }

  function toggleZone(zoneId: string) {
    const set = new Set(selectedZoneIds);
    if (set.has(zoneId)) set.delete(zoneId);
    else set.add(zoneId);
    void save({ zoneIds: [...set] });
  }

  // When zones expose their parent location, offer only the selected location's
  // zones; otherwise (no mapping) offer all and let the operator pick directly.
  const mappedToLocation = current ? zones.filter((z) => z.locationId === current) : [];
  const offered = current && mappedToLocation.length ? mappedToLocation : zones;
  const mappingMissing = !!current && zones.length > 0 && mappedToLocation.length === 0;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <span className="flex w-44 shrink-0 items-center gap-1.5 text-caption1 text-gray-11">
            Location
            <InfoHint>
              Optional convenience — narrows the zone list below to one location. Vea doesn&apos;t always
              expose a zone-to-location link; if it can&apos;t match, every zone is listed and you pick the
              ones you want. The zone selection is what actually scopes the count.
            </InfoHint>
          </span>
          <Select value={current} onValueChange={(v: string) => void save({ locationId: v })}>
            <SelectTrigger className="w-44">
              <SelectValue placeholder={locations.length ? "All locations" : "Load to choose"} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">All locations</SelectItem>
              {locations.map((l) => (
                <SelectItem key={l.locationId} value={l.locationId}>{l.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="transparent" size="small" onClick={loadLocations} disabled={loading}>
            {loading ? <Loader2Icon className="size-3.5 text-gray-9 animate-spin" /> : <RefreshCwIcon className="size-3.5 text-gray-9" />}
            Load
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <span className="text-caption1 text-gray-11">Zones</span>
            <InfoHint>
              The reliable way to scope the count. Vea&apos;s API ignores server-side location filters, so the count is summed from exactly the zones you select here (enforced in-app). Leave all unchecked to count every visible zone.
            </InfoHint>
          </div>
          <div className="flex items-center gap-1">
            {selectedZoneIds.length > 0 && (
              <Button variant="transparent" size="small" onClick={() => void save({ zoneIds: [] })}>Clear</Button>
            )}
            <Button variant="transparent" size="small" onClick={loadZones} disabled={zonesLoading}>
              {zonesLoading ? <Loader2Icon className="size-3.5 text-gray-9 animate-spin" /> : <RefreshCwIcon className="size-3.5 text-gray-9" />}
              {zones.length ? "Reload" : "Load zones"}
            </Button>
          </div>
        </div>

        {offered.length > 0 ? (
          <div className="flex flex-col gap-0.5 max-h-48 overflow-y-auto rounded-lg border border-gray-5 bg-gray-2 p-1">
            {offered.map((z) => {
              const on = selectedZoneIds.includes(z.zoneId);
              return (
                <button
                  key={z.zoneId}
                  type="button"
                  onClick={() => toggleZone(z.zoneId)}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-gray-3 transition-colors"
                >
                  {on ? (
                    <CheckCircle2Icon className="size-4 shrink-0 text-accent" />
                  ) : (
                    <span className="size-4 shrink-0 rounded-full border border-gray-6" />
                  )}
                  <span className={cn("text-caption1 truncate", on ? "text-gray-12" : "text-gray-11")}>{z.name}</span>
                </button>
              );
            })}
          </div>
        ) : (
          <span className="text-caption2 text-gray-9">
            {zonesLoading ? "Loading zones…" : "Load zones to choose which ones to count."}
          </span>
        )}

        {mappingMissing && (
          <span className="text-caption2 text-amber-11">
            This location&apos;s zones couldn&apos;t be matched automatically — all zones are listed; pick the ones for this location.
          </span>
        )}
        <span className="text-caption2 text-gray-9">
          {selectedZoneIds.length === 0
            ? "Counting all visible zones. Select specific zones to scope the count to your room."
            : `Counting ${selectedZoneIds.length} selected zone${selectedZoneIds.length === 1 ? "" : "s"}.`}
        </span>
      </div>
      {error && <span className="text-caption2 text-red-10">{error}</span>}
    </div>
  );
}

// ---- Ross TSL feeds editor --------------------------------------------------

interface TslFeed {
  id: string;
  metric: "attendance" | "occupancy";
  zoneId: string | null;
  displayIndex: number;
  prefix?: string;
  suffix?: string;
}

// crypto.randomUUID needs a secure context (kiosk runs plain HTTP) — fall back.
function feedId(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `feed-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Maps each people count (attendance/occupancy, building total or a zone) to a
// TSL display address on the Ross multiviewer. Stored as non-secret config.feeds.
function RossTslFeedsPanel({
  state,
  onStateChange,
}: {
  state: IntegrationState;
  onStateChange: (next: IntegrationState) => void;
}) {
  const people = usePeopleCountState();
  const zones = people?.zones ?? [];
  const initial = Array.isArray(state.config.feeds) ? (state.config.feeds as TslFeed[]) : [];
  const [feeds, setFeeds] = useState<TslFeed[]>(initial);
  const [saving, setSaving] = useState(false);

  function update(idx: number, patch: Partial<TslFeed>) {
    setFeeds((prev) => prev.map((f, i) => (i === idx ? { ...f, ...patch } : f)));
  }
  function remove(idx: number) {
    setFeeds((prev) => prev.filter((_, i) => i !== idx));
  }
  function add() {
    setFeeds((prev) => [
      ...prev,
      { id: feedId(), metric: "attendance", zoneId: null, displayIndex: prev.length, prefix: "", suffix: "" },
    ]);
  }

  async function save() {
    setSaving(true);
    try {
      const next = await invoke<IntegrationState>("integrations:setConfig", {
        id: "ross-tsl",
        config: { feeds },
      });
      onStateChange(next);
      toast.success("TSL feeds saved.");
    } catch (err) {
      toast.error(`Could not save feeds: ${String(err)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <span className="flex items-center gap-1.5 text-caption2 font-semibold uppercase tracking-wider text-gray-9">
        Multiviewer feeds
        <InfoHint>
          Each feed drives one multiviewer tile. Pick the metric (Attendance = total counted; In room =
          occupancy) and a zone (or building total), set TSL # to the tile&apos;s UMD address on the Ross
          (0–126, must match the tile), and optional prefix/suffix wrap the number (e.g. &quot;In room: &quot; … &quot; ppl&quot;).
        </InfoHint>
      </span>
      {feeds.length === 0 && (
        <span className="text-caption2 text-gray-9">
          Add a feed to drive a multiviewer tile&apos;s text. Set the same TSL address on the Ross tile.
        </span>
      )}
      {feeds.map((f, i) => (
        <div key={f.id} className="flex flex-wrap items-center gap-1.5">
          <Select value={f.metric} onValueChange={(v: string) => update(i, { metric: v as TslFeed["metric"] })}>
            <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="attendance">Attendance</SelectItem>
              <SelectItem value="occupancy">In room</SelectItem>
            </SelectContent>
          </Select>
          <Select value={f.zoneId ?? ""} onValueChange={(v: string) => update(i, { zoneId: v || null })}>
            <SelectTrigger className="w-36"><SelectValue placeholder="Building total" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="">Building total</SelectItem>
              {zones.map((z) => <SelectItem key={z.id} value={z.id}>{z.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <div className="flex items-center gap-1">
            <span className="text-caption2 text-gray-9">TSL #</span>
            <NumberInput value={f.displayIndex} step={1} min={0} max={126} onChange={(v) => update(i, { displayIndex: Math.round(v) })} className="w-24" />
          </div>
          <Input value={f.prefix ?? ""} onChange={(e: ChangeEvent<HTMLInputElement>) => update(i, { prefix: e.target.value })} placeholder="prefix" className="w-20" />
          <Input value={f.suffix ?? ""} onChange={(e: ChangeEvent<HTMLInputElement>) => update(i, { suffix: e.target.value })} placeholder="suffix" className="w-20" />
          <Button variant="transparent" size="small" iconOnly onClick={() => remove(i)} aria-label="Remove feed">
            <TrashIcon className="size-3.5" />
          </Button>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <Button variant="transparent" size="small" onClick={add}>
          <PlusIcon className="size-3.5" /> Add feed
        </Button>
        <Button variant="filled" size="small" onClick={save} disabled={saving}>
          {saving ? <Loader2Icon className="size-3.5 animate-spin" /> : null} Save feeds
        </Button>
      </div>
    </div>
  );
}

// ---- ProPresenter extra instances -------------------------------------------

interface PropInstanceRow {
  id: string;
  name: string;
  host: string;
  port: number;
  pollMs?: number;
}

// Per-instance connection status. Driven by the live `propresenter:instances`
// snapshot, which now carries the same connected/connecting/error/disconnected
// state the primary uses — so we delegate to the very same ConnectionBadge for a
// pixel-identical line. Rows not yet saved aren't known to the backend → "Not saved".
function InstanceStatusBadge({ conn, saved }: { conn: PropInstanceConn | undefined; saved: boolean }) {
  if (!saved || !conn) {
    return (
      <span className="flex items-center gap-1">
        <Status variant="neutral" />
        <span className="text-caption1 text-gray-9">Not saved</span>
      </span>
    );
  }
  return <ConnectionBadge connection={conn.state} message={conn.message} />;
}

// Extra ProPresenter machines beyond the primary (e.g. a second auditorium).
// Stored as non-secret config.instances; a layout object then picks which one to
// read. The primary is the host/port fields above (instance id "default").
//
// Each instance renders with the same field layout as the main ProPresenter card
// (Name / Host / API Port / Poll interval as horizontal Fields) plus a live
// connection badge, so the two read identically.
function ProPresenterInstancesPanel({
  state,
  onStateChange,
}: {
  state: IntegrationState;
  onStateChange: (next: IntegrationState) => void;
}) {
  const initial = Array.isArray(state.config.instances) ? (state.config.instances as PropInstanceRow[]) : [];
  const [rows, setRows] = useState<PropInstanceRow[]>(initial);
  const [saving, setSaving] = useState(false);
  // Live per-instance status from the backend (keyed by instance id).
  const propInstances = usePropInstances();
  // Ids the backend currently knows about — i.e. rows that have been saved.
  const savedIds = new Set((state.config.instances as PropInstanceRow[] | undefined)?.map((r) => r.id) ?? []);

  function update(idx: number, patch: Partial<PropInstanceRow>) {
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }
  function remove(idx: number) {
    setRows((prev) => prev.filter((_, i) => i !== idx));
  }
  function add() {
    setRows((prev) => [...prev, { id: feedId(), name: `Auditorium ${prev.length + 2}`, host: "", port: 1025 }]);
  }
  async function save() {
    setSaving(true);
    try {
      const next = await invoke<IntegrationState>("integrations:setConfig", {
        id: "propresenter",
        config: { instances: rows },
      });
      onStateChange(next);
      toast.success("ProPresenter instances saved.");
    } catch (err) {
      toast.error(`Could not save instances: ${String(err)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <span className="flex items-center gap-1.5 text-caption2 font-semibold uppercase tracking-wider text-gray-9">
        Additional instances (auditoriums)
        <InfoHint>
          Each card is another ProPresenter machine (the primary is the Host/Port fields above). Give it a
          Name, its IP, and API port (default 1025). A custom-layout object can then pick which instance it
          reads from — handy when two rooms run separate ProPresenters.
        </InfoHint>
      </span>
      {rows.length === 0 && (
        <span className="text-caption2 text-gray-9">
          Add another ProPresenter machine to read it in a custom view. A layout object then picks which instance it shows.
        </span>
      )}
      {rows.map((r, i) => {
        const saved = savedIds.has(r.id);
        const conn = propInstances?.conn?.[r.id];
        return (
          <div key={r.id} className="flex flex-col gap-2 rounded-lg border border-gray-5 p-3">
            {/* Header: live status + remove, mirroring the main card's header */}
            <div className="flex items-center justify-between gap-2">
              <InstanceStatusBadge conn={conn} saved={saved} />
              <Button variant="transparent" size="small" iconOnly onClick={() => remove(i)} aria-label="Remove instance">
                <TrashIcon className="size-3.5 text-gray-9" />
              </Button>
            </div>
            <FieldSet flat>
              <FieldGroup>
                <Field orientation="horizontal">
                  <FieldContent>
                    <FieldLabel className="flex items-center gap-1.5">
                      Name
                    </FieldLabel>
                    <FieldDescription>SA (e.g. Auditorium 2)</FieldDescription>
                  </FieldContent>
                  <Input
                    value={r.name}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => update(i, { name: e.target.value })}
                    placeholder="Auditorium 2"
                    className="w-44"
                    aria-label="Instance name"
                  />
                </Field>
                <Field orientation="horizontal">
                  <FieldContent>
                    <FieldLabel className="flex items-center gap-1.5">
                      ProPresenter Host
                    </FieldLabel>
                    <FieldDescription>192.168.1.101</FieldDescription>
                  </FieldContent>
                  <Input
                    value={r.host}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => update(i, { host: e.target.value })}
                    placeholder="192.168.1.101"
                    className="w-44"
                    aria-label="Instance host"
                  />
                </Field>
                <Field orientation="horizontal">
                  <FieldContent>
                    <FieldLabel className="flex items-center gap-1.5">
                      API Port
                    </FieldLabel>
                    <FieldDescription>1025</FieldDescription>
                  </FieldContent>
                  <NumberInput
                    value={r.port}
                    step={1}
                    min={1}
                    max={65535}
                    onChange={(v) => update(i, { port: Math.round(v) })}
                    className="w-44"
                    aria-label="Instance API port"
                  />
                </Field>
                <Field orientation="horizontal">
                  <FieldContent>
                    <FieldLabel className="flex items-center gap-1.5">
                      Poll interval (ms)
                    </FieldLabel>
                    <FieldDescription>500 (lower = snappier, more requests)</FieldDescription>
                  </FieldContent>
                  <NumberInput
                    value={r.pollMs ?? 500}
                    step={100}
                    min={200}
                    max={10000}
                    onChange={(v) => update(i, { pollMs: Math.round(v) })}
                    className="w-44"
                    aria-label="Instance poll interval"
                  />
                </Field>
              </FieldGroup>
            </FieldSet>
          </div>
        );
      })}
      <div className="flex items-center gap-2">
        <Button variant="transparent" size="small" onClick={add}>
          <PlusIcon className="size-3.5" /> Add instance
        </Button>
        <Button variant="filled" size="small" onClick={save} disabled={saving}>
          {saving ? <Loader2Icon className="size-3.5 animate-spin" /> : null} Save instances
        </Button>
      </div>
    </div>
  );
}

// ---- collapsible row + categories -------------------------------------------

// Groups the growing integration list by purpose so the page stays scannable.
/**
 * Cards that Getting Started can point at, by integration id.
 *
 * Named here rather than inline so the reveal listener below and the attribute
 * that emits it cannot drift — a flash id with no card, or a card whose id
 * changed, would silently stop highlighting.
 */
const FLASH_IDS: Record<string, string | undefined> = {
  "planning-center": "pco-credentials",
};

/**
 * The `data-flash-id` for one integration's card.
 *
 * Every integration needs one, not just the two something happened to point at:
 * the context bar's "N disconnected" now sends you straight at whichever is
 * down, and that is any of them. Exported so the sender and the target derive
 * the same string from the same function — a hand-written id on one side is how
 * a highlight silently lands nowhere.
 */
export function integrationFlashId(id: string): string {
  return FLASH_IDS[id] ?? `integration-${id}`;
}

const CATEGORY_ORDER: { title: string; ids: string[] }[] = [
  { title: "Service & plan", ids: ["planning-center", "prodcom"] },
  { title: "Presentation", ids: ["propresenter"] },
  { title: "Audio", ids: ["smaart"] },
  { title: "People", ids: ["sensource"] },
  { title: "Wireless", ids: ["wireless"] },
  { title: "Streaming", ids: ["resi", "youtube"] },
  { title: "Control & output", ids: ["obs", "reaper", "osc", "rosstalk", "ross-tsl"] },
  // Its own group rather than "Control & output": scores are something the app
  // READS and shows, and nothing here controls a device. "People" is the only
  // other read-only feed and it is named for what it counts, so a general
  // heading is the honest place for this one.
  { title: "Information", ids: ["scores"] },
];

/** Two integrations that present as one card. RossTalk (commands, TCP 7788) and
 *  Ross MultiViewer (TSL UMD) are different protocols that usually address the
 *  same Carbonite, so two separate cards read as clutter. This is presentation
 *  only — each keeps its own id, enable flag, config and connection state, so
 *  layout buttons and automation actions referencing "rosstalk" are untouched. */
const PAIRS: { title: string; ids: [string, string] }[] = [
  { title: "Ross", ids: ["rosstalk", "ross-tsl"] },
];

/** One integration as a collapsible card: header (name · status · enable) that
 *  expands to the config body. Configured integrations start collapsed; ones that
 *  still need setup start open, so the page opens on what needs attention. */
function IntegrationRow({
  descriptor,
  state,
  onStateChange,
  body,
}: {
  descriptor: IntegrationDescriptor;
  state: IntegrationState;
  onStateChange: (s: IntegrationState) => void;
  body: ReactNode;
}) {
  const [toggling, setToggling] = useState(false);
  async function toggleEnabled(enabled: boolean) {
    setToggling(true);
    try {
      const next = await ipc<IntegrationState>("integrations:setEnabled", { id: descriptor.id, enabled });
      onStateChange(next);
    } catch (err) {
      toast.error(`Failed to ${enabled ? "enable" : "disable"}: ${String(err)}`);
    } finally {
      setToggling(false);
    }
  }
  return (
    <div className="su-card px-3 py-2">
      <IntegrationEntry
        descriptor={descriptor}
        state={state}
        body={body}
        toggling={toggling}
        onToggle={toggleEnabled}
      />
    </div>
  );
}

/** The collapsible header + body for one integration, without a card wrapper —
 *  so it can sit alone in its own card or beside a sibling inside a pair card. */
function IntegrationEntry({
  descriptor,
  state,
  body,
  toggling,
  onToggle,
}: {
  descriptor: IntegrationDescriptor;
  state: IntegrationState;
  body: ReactNode;
  toggling: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  // A CONFIGURED integration is collapsed, so the card the context bar's
  // "N disconnected" aims a highlight at is not in the DOM — the highlight had
  // nothing to land on and did nothing at all. Remounting with defaultOpen
  // reveals it, and the operator can still close it again afterwards.
  const revealNonce = useRevealNonce((id) => id === integrationFlashId(descriptor.id));
  return (
    <Collapsible
      key={revealNonce}
      defaultOpen={!state.configured || revealNonce > 0}
      label={<span className="text-callout font-semibold text-fg truncate">{descriptor.label}</span>}
      afterLabel={descriptor.description ? <InfoHint>{descriptor.description}</InfoHint> : undefined}
      right={
        <div className="flex items-center gap-3 shrink-0">
          <ConnectionBadge connection={state.connection} message={state.message} inbound={descriptor.inbound} />
          {/* No switch for an integration that dials US. There was one, and
              nothing was gated on it: turning Companion off left the module
              connecting and controlling the app exactly as before, while the
              row said it was disabled. */}
          {!descriptor.inbound && (
            <Switch
              checked={state.enabled}
              onCheckedChange={onToggle}
              disabled={toggling}
              aria-label={`Enable ${descriptor.label}`}
            />
          )}
        </div>
      }
    >
      <div className="pt-1">{body}</div>
    </Collapsible>
  );
}

/** One card holding two related integrations as sections. Each section keeps its
 *  own status badge and enable switch — this groups them visually, it does not
 *  merge them. */
function IntegrationPairRow({
  title,
  entries,
  onStateChange,
}: {
  title: string;
  entries: { descriptor: IntegrationDescriptor; state: IntegrationState; body: ReactNode }[];
  onStateChange: (id: string, s: IntegrationState) => void;
}) {
  const [togglingId, setTogglingId] = useState<string | null>(null);

  async function toggle(id: string, label: string, enabled: boolean) {
    setTogglingId(id);
    try {
      const next = await ipc<IntegrationState>("integrations:setEnabled", { id, enabled });
      onStateChange(id, next);
    } catch (err) {
      toast.error(`Failed to ${enabled ? "enable" : "disable"} ${label}: ${String(err)}`);
    } finally {
      setTogglingId(null);
    }
  }

  return (
    <div className="su-card flex flex-col gap-1 px-3 py-2">
      <span className="text-caption2 font-semibold uppercase tracking-wider text-gray-9">{title}</span>
      {entries.map(({ descriptor, state, body }, i) => (
        <div key={descriptor.id} className={i > 0 ? "border-t border-line pt-1" : undefined}>
          <IntegrationEntry
            descriptor={descriptor}
            state={state}
            body={body}
            toggling={togglingId === descriptor.id}
            onToggle={(enabled) => toggle(descriptor.id, descriptor.label, enabled)}
          />
        </div>
      ))}
    </div>
  );
}

// ---- main export ------------------------------------------------------------

interface IntegrationsPanelProps {
  className?: string;
}

export function IntegrationsPanel({ className }: IntegrationsPanelProps) {
  // Getting Started points at a specific card, and an unconfigured integration
  // lives inside the collapsed "Not set up" group — which is exactly where a
  // first-run operator's PCO card is, so the highlight had nothing to land on.
  //
  // A nonce rather than a boolean: it remounts the group with defaultOpen, so
  // the operator can still close it afterwards, and there is no setState in an
  // effect to cascade renders. Declared here, above every early return, because
  // hooks must run in the same order on every render.
  // The "Not set up" group opens when the target is one of the cards inside it.
  // Same hook the rows use — this was the only copy of the pattern until the
  // rows needed it too.
  const revealNonce = useRevealNonce((flashId) => Object.values(FLASH_IDS).includes(flashId));

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
      <div className={cn("py-2", className)}>
        <SkeletonRows rows={4} />
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

  const { descriptors: allDescriptors, states } = data;
  const stateMap = new Map(states.map((s) => [s.id, s]));
  // Companion is listed here like everything else.
  //
  // It used to be filtered OUT, on the grounds that there is nothing to
  // configure — it dials in to us rather than the other way round. But "nothing
  // to configure" is not the same as "should not appear": this is the one page
  // whose job is to answer "what can this talk to", and the one integration
  // people go looking for was the one it did not mention.
  const descriptors = allDescriptors;
  const byId = new Map(descriptors.map((d) => [d.id, d]));

  // The body content for one integration: a bespoke panel (wireless/osc) or the
  // generic schema form (+ caption colors under ProdCom).
  const bodyFor = (descriptor: IntegrationDescriptor, state: IntegrationState): ReactNode => {
    if (descriptor.kind === "wireless") return <WirelessConnectionsPanel />;
    if (descriptor.id === "osc") return <OscTargetsPanel />;
    // Its own panel: the only setting is WHICH TEAMS, and a searchable
    // multi-league team picker is not expressible as a ConfigField.
    if (descriptor.id === "scores") return <ScoresTeamsPanel />;
    if (descriptor.id === "rosstalk") return <RossTalkTargetsPanel />;
    // Its own panel: what Companion needs is an address to dial and the module
    // to dial it with, not a form.
    if (descriptor.id === "companion") return <CompanionInfoPanel state={state} />;
    return (
      <>
        <IntegrationCard
          descriptor={descriptor}
          state={state}
          onStateChange={handleStateChange}
          lastRefreshedAt={stageState?.lastRefreshedAt ?? null}
        />
        {descriptor.id === "prodcom" && <CaptionColorsPanel />}
      </>
    );
  };

  // Summary strip + category groups (uncategorized descriptors fall into "Other").
  const connectedCount = descriptors.filter((d) => stateMap.get(d.id)?.connection === "connected").length;
  const needsSetup = descriptors.filter((d) => stateMap.get(d.id)?.configured === false).length;
  const categorized = new Set(CATEGORY_ORDER.flatMap((c) => c.ids));
  /**
   * An integration is "in use" if it is enabled or has been configured. Everything
   * else is noise on this page — a site running three integrations should not scroll
   * past eleven. Nothing is hidden permanently and there is no preference to store:
   * the state already says which are in use, so the list reorganizes itself as soon
   * as one is set up. An ERRORING integration always stays in the main list, since an
   * error is exactly what you want to see.
   */
  const inUse = (d: IntegrationDescriptor) => {
    const st = stateMap.get(d.id);
    return !!st && (st.enabled || st.configured !== false || st.connection === "error");
  };
  const dormant = descriptors.filter((d) => !inUse(d));
  const dormantIds = new Set(dormant.map((d) => d.id));

  const groups = [
    ...CATEGORY_ORDER.map((c) => ({
      title: c.title,
      items: c.ids
        .map((id) => byId.get(id))
        .filter((d): d is IntegrationDescriptor => !!d && !dormantIds.has(d.id)),
    })),
    { title: "Other", items: descriptors.filter((d) => !categorized.has(d.id) && !dormantIds.has(d.id)) },
  ].filter((g) => g.items.length > 0);

  return (
    <div className={cn("flex flex-col gap-5", className)}>
      <p className="text-caption1 text-fg-subtle">
        <span className="font-medium text-accent">{connectedCount} connected</span>
        {needsSetup > 0 ? ` · ${needsSetup} to set up` : ""}
      </p>
      {groups.length === 0 && dormant.length > 0 && (
        <p className="text-caption1 text-fg-muted">
          Nothing set up yet — pick one below to get started.
        </p>
      )}
      {groups.map((g) => (
        <div key={g.title} className="flex flex-col gap-2">
          <span className="text-caption2 font-semibold uppercase tracking-wider text-gray-9">{g.title}</span>
          {g.items.map((descriptor) => {
            const state = stateMap.get(descriptor.id);
            if (!state) return null;

            // Paired integrations render once, as a single card, in the position of
            // whichever id comes first; the sibling is skipped where it would have
            // rendered on its own.
            const pair = PAIRS.find((p) => p.ids.includes(descriptor.id));
            if (pair) {
              // Anchor to the first id actually in this group, not ids[0] — when one
              // half is dormant the card must still render for the half that isn't.
              const anchor = pair.ids.find((id) => g.items.some((d) => d.id === id));
              if (descriptor.id !== anchor) return null;
              const entries = pair.ids
                .map((id) => {
                  const d = byId.get(id);
                  const s = stateMap.get(id);
                  return d && s ? { descriptor: d, state: s, body: bodyFor(d, s) } : null;
                })
                .filter((e): e is { descriptor: IntegrationDescriptor; state: IntegrationState; body: ReactNode } => e !== null);
              return (
                <IntegrationPairRow
                  key={pair.title}
                  title={pair.title}
                  entries={entries}
                  onStateChange={(_id, s) => handleStateChange(s)}
                />
              );
            }

            return (
              <IntegrationRow
                key={descriptor.id}
                descriptor={descriptor}
                state={state}
                onStateChange={handleStateChange}
                body={bodyFor(descriptor, state)}
              />
            );
          })}
        </div>
      ))}

      {dormant.length > 0 && (
        <Collapsible
          key={revealNonce}
          defaultOpen={revealNonce > 0}
          label={`Not set up (${dormant.length})`}
          summary="integrations you are not using"
        >
          <div className="flex flex-col gap-2 pt-2">
            {dormant.map((descriptor) => {
              const state = stateMap.get(descriptor.id);
              if (!state) return null;
              return (
                <IntegrationRow
                  key={descriptor.id}
                  descriptor={descriptor}
                  state={state}
                  onStateChange={handleStateChange}
                  body={bodyFor(descriptor, state)}
                />
              );
            })}
          </div>
        </Collapsible>
      )}
    </div>
  );
}
