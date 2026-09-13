import { errorMessage } from "@main/services/errors";
import { isSecretStored } from "@main/services/mask";
import { invoke } from "../lib/api";
import { useState, useEffect, useCallback } from "react";
import {
  Button,
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
  InfoHint,
  toast,
} from "./ui";
import { Loader2Icon, CheckCircle2Icon, RefreshCwIcon, AlertTriangleIcon } from "lucide-react";
import { cn } from "../lib/cn";

/**
 * SafeSpace is switched on and has no space id — say so where the fix is.
 *
 * The id is a bearer capability, so it lives in secrets.bin and a config
 * snapshot deliberately does not carry it. The bundle DOES carry the fact that
 * SafeSpace was on, and that is the whole point: restore one onto another box
 * and this is the state it lands in. The occupancy goes back to Vea, which is
 * correct and which is also exactly what a site that never had SafeSpace looks
 * like — a green badge over a number a minute and a half older than the one the
 * site was set up for.
 *
 * `safeSpaceEnabled` is non-secret config the server maintains; `safeSpaceId` in
 * the state map is the MASK, so it reads "••••" when one is stored and "" when
 * none is. Three surfaces say this — the /log line, the integration row's
 * message and this — because the first two are transient and this one is beside
 * the field the operator has to retype.
 *
 * THE WAY OUT IS A BUTTON, not a save. This block used to say "save with that
 * field left empty to turn SafeSpace off", and the server obliged — for EVERY
 * save, because with no id stored the dialog seeds the field as "" and posts
 * that on every save whatever the operator came to change. So an operator
 * editing the Vea poll interval switched SafeSpace off by accident, and one who
 * meant to switch it off could not be told apart from them. Two intents, one
 * gesture. The server now only reads a save as "off" when a stored id really
 * went, and the deliberate one is this.
 */
function SafeSpaceIdMissingNotice({
  state,
  onStateChange,
}: {
  state: IntegrationState;
  onStateChange: (next: IntegrationState) => void;
}) {
  const [turningOff, setTurningOff] = useState(false);
  const on = state.config.safeSpaceEnabled === true;
  const stored = isSecretStored(state.config.safeSpaceId);
  if (!on || stored) return null;

  async function turnOff() {
    setTurningOff(true);
    try {
      // `safeSpaceEnabled: false` is a COMMAND to the server, not a value it
      // stores — see the marker block in integration-manager.setConfig. It is
      // the only thing a body may say about this key, and it can only remove.
      onStateChange(
        await invoke<IntegrationState>("integrations:setConfig", {
          id: "sensource",
          config: { safeSpaceEnabled: false },
        }),
      );
      toast.success("SafeSpace turned off. The occupancy comes from Vea.");
    } catch (err) {
      // Surfaced, not swallowed: the notice stays up either way, and without
      // this the button would read as a control that does nothing.
      toast.error(`Could not turn SafeSpace off: ${errorMessage(err)}`);
    } finally {
      setTurningOff(false);
    }
  }

  return (
    <div
      data-testid="safespace-id-missing"
      className="flex items-start gap-2 rounded-lg border border-amber-6 bg-amber-2/60 px-3 py-2"
    >
      <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-amber-11" />
      <div className="flex min-w-0 flex-col items-start gap-2">
        <span className="text-caption2 text-amber-11">
          SafeSpace is on but has no space ID. The occupancy is coming from Vea, which refreshes
          about every 78 seconds instead of every few. A config snapshot never carries the ID —
          paste it into <strong className="font-medium">SafeSpace space ID</strong> above, or turn
          SafeSpace off.
        </span>
        <Button
          size="small"
          variant="filled"
          disabled={turningOff}
          onClick={() => void turnOff()}
          data-testid="safespace-turn-off"
        >
          {turningOff ? "Turning off…" : "Turn SafeSpace off"}
        </Button>
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
export function SenSourceScopePicker({
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
      <SafeSpaceIdMissingNotice state={state} onStateChange={onStateChange} />
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
