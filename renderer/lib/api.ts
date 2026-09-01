// api.ts — Backend client for the renderer.
//
// invoke<T>(channel, params?) maps logical channels to HTTP fetch calls.
// onNotification(channel, cb)  subscribes to SSE push events.
//
// The renderer is always served from the same origin as the HTTP server
// (port 8788), so all paths here are relative.

import { HYDRATED_CHANNELS, HYDRATED_SET } from "./sse-channels";

type Params = Record<string, unknown> | undefined;

// ── HTTP helpers ──────────────────────────────────────────────────────────────

// Hard ceiling so a request that never settles (e.g. a stalled backend route)
// surfaces as an error instead of hanging a query in its loading state forever.
const REQUEST_TIMEOUT_MS = 15000;

/** An HTTP error carrying its status and the server's machine-readable `code`. */
export interface ApiError extends Error {
  status?: number;
  code?: string;
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: { "Content-Type": "application/json", ...init?.headers },
      signal: init?.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new Error(`Request to ${path} timed out`, { cause: err });
    }
    throw err;
  }
  if (!res.ok) {
    let msg = res.statusText;
    let body: { error?: string; code?: string } | null = null;
    try {
      body = await res.json();
      if (typeof body?.error === "string") msg = body.error;
    } catch { /* ignore */ }
    // Carry the status and any machine-readable `code` on the Error. Callers that
    // only interpolate the message are unaffected, but one that has to tell a
    // conflict from a failure (a 409 is a choice, not an error) now can.
    const err = new Error(msg) as ApiError;
    err.status = res.status;
    if (typeof body?.code === "string") err.code = body.code;
    throw err;
  }
  return res.json() as Promise<T>;
}

function post<T>(path: string, body?: unknown): Promise<T> {
  return apiFetch<T>(path, {
    method: "POST",
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function patch<T>(path: string, body?: unknown): Promise<T> {
  return apiFetch<T>(path, {
    method: "PATCH",
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function del<T>(path: string): Promise<T> {
  return apiFetch<T>(path, { method: "DELETE" });
}

// ── Channel → HTTP mapping ────────────────────────────────────────────────────

export async function invoke<T>(channel: string, params?: Params): Promise<T> {
  const p = params ?? {};

  switch (channel) {
    // ── Stage state ────────────────────────────────────────────────────
    case "stage:getState":
      return apiFetch<T>("/api/state");

    case "prodcom:getTranscript":
      return apiFetch<T>("/api/prodcom/transcript");
    case "prodcom:clearTranscript":
      return post<T>("/api/prodcom/transcript/clear");

    case "stage:listServiceTypes":
      return apiFetch<T>("/api/service-types");

    case "stage:listPlans": {
      const id = p.serviceTypeId as string;
      return apiFetch<T>(`/api/plans?serviceTypeId=${encodeURIComponent(id)}`);
    }

    case "stage:listTeamPositions":
      return apiFetch<T>("/api/team-positions");

    // ── ScriptView (in-app ScriptViewer replacement) ────────────────────
    case "scriptview:listLayouts":
      return apiFetch<T>("/api/scriptview/layouts");

    case "scriptview:saveLayouts":
      return post<T>("/api/scriptview/layouts", { layouts: p.layouts });

    case "scriptview:getConfig":
      return apiFetch<T>("/api/scriptview/config");

    case "scriptview:setConfig":
      return post<T>("/api/scriptview/config", { serviceTypeIds: p.serviceTypeIds });

    case "scriptview:listRoles":
      return apiFetch<T>("/api/scriptview/roles");

    case "scriptview:saveRoles":
      return post<T>("/api/scriptview/roles", { roles: p.roles });

    // Adds a role for any category this service type defines that no role covers.
    // Only ever adds — never merges, never removes.
    case "scriptview:noteCategories": {
      const id = p.serviceTypeId as string;
      return apiFetch<T>(`/api/scriptview/note-categories?serviceTypeId=${encodeURIComponent(id)}`);
    }

    // ── Stage patch sheet ───────────────────────────────────────────────
    case "patch:get":
      return apiFetch<T>("/api/patch");

    case "patch:save":
      return post<T>("/api/patch", { file: p.file });

    case "patch:parseXlsx":
      return post<T>("/api/patch/parse-xlsx", { xlsx: p.xlsx });

    case "scriptview:rundown": {
      const id = p.serviceTypeId as string;
      const qs = p.planId ? `&planId=${encodeURIComponent(p.planId as string)}` : "";
      return apiFetch<T>(`/api/scriptview/rundown?serviceTypeId=${encodeURIComponent(id)}${qs}`);
    }

    case "stage:setServiceType":
      return post<T>("/api/service-type", p);

    case "stage:setPlan":
      return post<T>("/api/plan", p);

    case "stage:selectNextPlan":
      return post<T>("/api/plan/next");

    case "stage:setPlanMode":
      return post<T>("/api/plan/mode", p);

    case "stage:refresh":
      return post<T>("/api/refresh");

    case "pco:liveNext":
      return post<T>("/api/live/next");

    case "pco:livePrevious":
      return post<T>("/api/live/previous");

    case "pco:getLive":
      return apiFetch<T>("/api/pco/live");

    case "pco:getPlanItems":
      return apiFetch<T>("/api/pco/plan-items");

    // The month grid, already bucketed into days in the app time zone. The
    // browser is never given raw instants to bucket — see calendar-grid.ts.
    case "calendar:getGrid": {
      const viewId = typeof p.viewId === "string" ? p.viewId : null;
      // `month` is YYYY-MM and is omitted for the current month, which is the
      // only one the pushed channel carries.
      const month = typeof p.month === "string" ? p.month : null;
      const qs = new URLSearchParams();
      if (viewId) qs.set("viewId", viewId);
      if (month) qs.set("month", month);
      const q = qs.toString();
      return apiFetch<T>(`/api/pco/calendar${q ? `?${q}` : ""}`);
    }
    // The org's calendars and tags, for a calendar View's two pickers.
    case "calendar:sources":
      return apiFetch<T>("/api/pco/calendar-sources");

    // The pre-service checklist, read from the plan's notes in Planning Center.
    case "checklist:get":
      return apiFetch<T>("/api/pco/checklist");
    case "checklist:sources":
      return apiFetch<T>("/api/pco/checklist-sources");
    // Both writes answer with the whole list as it now stands, so the caller
    // renders what the server says rather than applying its own optimism.
    case "checklist:tick":
      return post<T>("/api/pco/checklist/tick", p);
    case "checklist:clear":
      return post<T>("/api/pco/checklist/clear");

    case "propresenter:getStatus":
      return apiFetch<T>("/api/propresenter/status");
    case "propresenter:getInstances":
      return apiFetch<T>("/api/propresenter/instances");

    case "spl:getMetrics":
      return apiFetch<T>("/api/spl/metrics");

    case "obs:getStatus":
      return apiFetch<T>("/api/obs/status");
    case "reaper:getStatus":
      return apiFetch<T>("/api/reaper/status");
    case "pvp:getStatus":
      return apiFetch<T>("/api/pvp/status");

    case "scores:getStatus":
      return apiFetch<T>("/api/scores/status");
    case "scores:getFavourites":
      return apiFetch<T>("/api/scores/favourites");
    case "scores:setFavourites":
      return post<T>("/api/scores/favourites", p);
    case "scores:listTeams":
      return apiFetch<T>(`/api/scores/teams?league=${encodeURIComponent(String(p.league))}`);

    case "resi:getStatus":
      return apiFetch<T>("/api/resi/status");
    case "youtube:getStatus":
      return apiFetch<T>("/api/youtube/status");

    case "spl:getHistoryCurrent":
      return apiFetch<T>("/api/spl/history/current");

    case "spl:listHistory":
      return apiFetch<T>("/api/spl/history");

    case "spl:getSummary":
      return apiFetch<T>("/api/spl/summary");

    case "spl:getTrendPrefs":
      return apiFetch<T>("/api/spl/trend");
    case "spl:setTrendPrefs":
      return post<T>("/api/spl/trend", p);

    case "people:getCount":
      return apiFetch<T>("/api/people/count");

    case "sensource:listLocations":
      return apiFetch<T>("/api/sensource/locations");

    case "sensource:listZones":
      return apiFetch<T>("/api/sensource/zones");

    case "spl:getHistory": {
      const key = p.serviceKey as string;
      return apiFetch<T>(`/api/spl/history/${encodeURIComponent(key)}`);
    }

    case "spl:deleteHistory": {
      const key = p.serviceKey as string;
      return del<T>(`/api/spl/history/${encodeURIComponent(key)}`);
    }

    case "attendance:getHistoryCurrent":
      return apiFetch<T>("/api/attendance/history/current");

    case "attendance:listHistory":
      return apiFetch<T>("/api/attendance/history");

    case "attendance:getHistory": {
      const key = p.serviceKey as string;
      return apiFetch<T>(`/api/attendance/history/${encodeURIComponent(key)}`);
    }

    case "attendance:deleteHistory": {
      const key = p.serviceKey as string;
      return del<T>(`/api/attendance/history/${encodeURIComponent(key)}`);
    }

    case "serviceTimeline:getCurrent":
      return apiFetch<T>("/api/service-timeline/current");

    case "serviceTimeline:list":
      return apiFetch<T>("/api/service-timeline");

    case "serviceTimeline:get": {
      const key = p.serviceKey as string;
      return apiFetch<T>(`/api/service-timeline/${encodeURIComponent(key)}`);
    }

    case "serviceTimeline:delete": {
      const key = p.serviceKey as string;
      return del<T>(`/api/service-timeline/${encodeURIComponent(key)}`);
    }

    case "baptism:get":
      return apiFetch<T>("/api/baptism");
    case "baptism:sessions":
      return apiFetch<T>("/api/baptism/sessions");
    case "baptism:start":
      return post<T>("/api/baptism/start");
    case "baptism:baptized":
      return post<T>("/api/baptism/baptized");
    case "baptism:startBaptisms":
      return post<T>("/api/baptism/start-baptisms");
    case "baptism:next":
      return post<T>("/api/baptism/next");
    case "baptism:setMode":
      return post<T>("/api/baptism/mode", { mode: p.mode });
    case "baptism:undo":
      return post<T>("/api/baptism/undo");
    case "baptism:finish":
      return post<T>("/api/baptism/finish");
    case "baptism:reset":
      return post<T>("/api/baptism/reset");
    case "baptism:deleteSession": {
      const id = p.id as string;
      return del<T>(`/api/baptism/sessions/${encodeURIComponent(id)}`);
    }
    case "baptism:getTriggers":
      return apiFetch<T>(`/api/baptism/triggers?planId=${encodeURIComponent(String(p.planId ?? ""))}`);
    case "baptism:setTriggers":
      return post<T>("/api/baptism/triggers", {
        planId: p.planId,
        testimonyItemId: p.testimonyItemId,
        baptismItemId: p.baptismItemId,
      });

    case "spl:getVisibleMetrics":
      return apiFetch<T>("/api/spl/visible-metrics");

    case "spl:setVisibleMetrics":
      return post<T>("/api/spl/visible-metrics", p);

    case "stage:setAllowedServiceTypes":
      return post<T>("/api/allowed-service-types", p);

    case "stage:setShowQr":
      return post<T>("/api/show-qr", p);

    case "stage:setOnboardingDismissed":
      return post<T>("/api/onboarding-dismissed", p);

    case "stage:setNdiEnabled":
      return post<T>("/api/ndi-enabled", p);

    case "stage:setPublicUrl":
      return post<T>("/api/public-url", p);

    case "captions:setChannelColor":
      return post<T>("/api/caption-colors", p);

    // ── In-app self-update ───────────────────────────────────────────────
    case "update:status":
      return apiFetch<T>("/api/update/status");

    case "update:check":
      return post<T>("/api/update/check");

    case "update:apply":
      return post<T>("/api/update/apply", p);

    case "update:lock":
      return apiFetch<T>("/api/update/lock");

    case "update:setAuto":
      return post<T>("/api/update/auto", p);

    case "settings:setReconnectSchedule":
      return post<T>("/api/reconnect-schedule", p);

    case "settings:setBaptismAutoStart":
      return post<T>("/api/baptism-auto-start", {
        enabled: p.enabled,
        testimonyKeyword: p.testimonyKeyword,
      });
    case "settings:setTaperWindow":
      return post<T>("/api/taper-window", p);
    case "settings:setChecklistSources":
      return post<T>("/api/checklist-sources", p);
    case "settings:setTimezone":
      return post<T>("/api/timezone", p);
    case "settings:setHourCycle":
      return post<T>("/api/hour-cycle", p);

    case "update:setTrack":
      return post<T>("/api/update/track", p);

    case "update:restart":
      return post<T>("/api/update/restart");

    // ── Config snapshot (backup / restore) ───────────────────────────────
    case "backup:getSchedule":
      return apiFetch<T>("/api/backup/schedule");

    case "backup:setSchedule":
      return post<T>("/api/backup/schedule", p);

    case "backup:runNow":
      return post<T>("/api/backup/run", {});

    case "config:listSnapshots":
      return apiFetch<T>("/api/config/snapshots");

    case "config:saveSnapshot":
      return post<T>("/api/config/snapshots", { name: p.name });

    case "config:recallSnapshot": {
      const id = p.id as string;
      return post<T>(`/api/config/snapshots/${encodeURIComponent(id)}/recall`);
    }

    case "config:deleteSnapshot": {
      const id = p.id as string;
      return del<T>(`/api/config/snapshots/${encodeURIComponent(id)}`);
    }

    case "config:import":
      return post<T>("/api/config/import", { bundle: p.bundle });

    case "displays:refresh":
      return post<T>("/api/displays/refresh", p);

    // Which outputs have a browser attached right now. The "displays:presence"
    // SSE channel broadcasts only on CHANGE, so a subscriber that mounts into a
    // quiet building needs one read to know where it stands.
    case "displays:getPresence":
      return apiFetch<T>("/api/displays/presence");

    // ── Kiosk devices ─────────────────────────────────────────────────────
    case "stage:setKioskDiscovery":
      return post<T>("/api/kiosk-discovery", p);

    case "devices:list":
      return apiFetch<T>("/api/devices");
    case "devices:scan":
      return post<T>("/api/devices/scan", p);
    case "devices:claim":
      return post<T>("/api/devices/claim", p);
    case "devices:release":
      return post<T>("/api/devices/release", p);

    case "stage:setBranding":
      return post<T>("/api/branding", p);

    case "stage:getBrandingSource": {
      const target = p.target === "empty" ? "empty" : p.target === "avatar" ? "avatar" : "app";
      return apiFetch<T>(`/api/branding/source?target=${target}`);
    }

    case "stage:getRemoteUrl": {
      const state = await apiFetch<{ remoteUrl: string | null }>("/api/state");
      return state.remoteUrl as unknown as T;
    }

    // ── Presets ────────────────────────────────────────────────────────
    case "presets:list":
      return apiFetch<T>("/api/presets");

    case "presets:save":
      return post<T>("/api/presets", p);

    case "presets:apply": {
      const id = p.id as string;
      return post<T>(`/api/presets/${encodeURIComponent(id)}/apply`, {
        viewId: p.viewId,
        displayId: p.displayId,
      });
    }

    case "presets:delete": {
      const id = p.id as string;
      return del<T>(`/api/presets/${encodeURIComponent(id)}`);
    }

    case "presets:import":
      return post<T>("/api/presets/import", p);

    case "presets:reorder":
      return post<T>("/api/presets/reorder", { ids: p.ids });

    case "presets:rename": {
      const id = p.id as string;
      return patch<T>(`/api/presets/${encodeURIComponent(id)}`, { name: p.name });
    }

    case "presets:overwrite": {
      const id = p.id as string;
      // Pass explicit `slots` (inline mic-slots) when present, else overwrite from a view.
      return patch<T>(`/api/presets/${encodeURIComponent(id)}`, p.slots ? { slots: p.slots } : { overwriteFromDisplayId: p.displayId });
    }

    // ── Views (content) ──────────────────────────────────────────────────
    case "views:add":
      return post<T>("/api/views", p);

    case "views:rename": {
      const id = p.id as string;
      return patch<T>(`/api/views/${encodeURIComponent(id)}`, { name: p.name });
    }

    case "views:setKind": {
      const id = p.id as string;
      return patch<T>(`/api/views/${encodeURIComponent(id)}`, { kind: p.kind });
    }


    case "views:setLayout": {
      const id = p.id as string;
      // layoutRev omitted = save unconditionally (the explicit overwrite path).
      const body: Record<string, unknown> = { layout: p.layout };
      if (typeof p.layoutRev === "number") body.layoutRev = p.layoutRev;
      return patch<T>(`/api/views/${encodeURIComponent(id)}`, body);
    }

    case "views:setSlotsLayout": {
      const id = p.id as string;
      return patch<T>(`/api/views/${encodeURIComponent(id)}`, { slotsLayout: p.slotsLayout });
    }

    case "views:setScriptViewLayout": {
      const id = p.id as string;
      return patch<T>(`/api/views/${encodeURIComponent(id)}`, { scriptViewLayoutId: p.scriptViewLayoutId });
    }

    case "views:setHideChrome": {
      const id = p.id as string;
      return patch<T>(`/api/views/${encodeURIComponent(id)}`, { hideChrome: p.hideChrome });
    }

    // Both lists, always together: the server refuses one without the other,
    // because a request carrying half of them is a client that has lost state
    // rather than a partial update.
    case "views:setCalendarFilters": {
      const id = p.id as string;
      return patch<T>(`/api/views/${encodeURIComponent(id)}`, {
        calendarSources: p.calendarSources,
        calendarTags: p.calendarTags,
      });
    }

    case "views:setSlots": {
      const id = p.id as string;
      return post<T>(`/api/views/${encodeURIComponent(id)}/slots`, { slots: p.slots });
    }

    case "views:resolveSlots":
      // Resolve draft slots against live team + device state WITHOUT saving —
      // powers the Views live draft preview. Returns resolved Slot[].
      return post<T>("/api/views/resolve-slots", { slots: p.slots });

    case "layoutObjects:setSlots": {
      const id = p.id as string;
      return post<T>(`/api/layout-objects/${encodeURIComponent(id)}/slots`, { slots: p.slots });
    }

    case "views:duplicate": {
      const id = p.id as string;
      return post<T>(`/api/views/${encodeURIComponent(id)}/duplicate`, { name: p.name });
    }

    case "update:notices":
      return apiFetch<T>("/api/update/notices");
    case "update:dismissNotice":
      return post<T>("/api/update/notices/dismiss", p);

    // The bundle IS the payload — a view export file, posted verbatim.
    case "views:import":
      return post<T>("/api/views/import", p.bundle);

    case "views:reorder":
      return post<T>("/api/views/reorder", { ids: p.ids });

    case "views:copySlots": {
      const id = p.id as string;
      return post<T>(`/api/views/${encodeURIComponent(id)}/copy-slots`, { fromViewId: p.fromViewId });
    }

    case "views:remove": {
      const id = p.id as string;
      return del<T>(`/api/views/${encodeURIComponent(id)}`);
    }

    // ── Layout templates ──────────────────────────────────────────────────
    case "layoutTemplates:list":
      return apiFetch<T>("/api/layout-templates");

    case "layoutTemplates:save":
      return post<T>("/api/layout-templates", { name: p.name, layout: p.layout });

    case "layoutTemplates:update": {
      const id = p.id as string;
      const bodyPatch: Record<string, unknown> = {};
      if (p.name !== undefined) bodyPatch.name = p.name;
      if (p.layout !== undefined) bodyPatch.layout = p.layout;
      return patch<T>(`/api/layout-templates/${encodeURIComponent(id)}`, bodyPatch);
    }

    case "layoutTemplates:delete": {
      const id = p.id as string;
      return del<T>(`/api/layout-templates/${encodeURIComponent(id)}`);
    }

    // ── Layout groups (reusable object/container library) ──────────────────
    case "layoutGroups:list":
      return apiFetch<T>("/api/layout-groups");

    case "layoutGroups:save":
      return post<T>("/api/layout-groups", { name: p.name, object: p.object });

    case "layoutGroups:delete": {
      const id = p.id as string;
      return del<T>(`/api/layout-groups/${encodeURIComponent(id)}`);
    }

    // ── Outputs (physical screens + routing) ──────────────────────────────
    case "outputs:add":
      return post<T>("/api/outputs", p);

    case "outputs:rename": {
      const id = p.id as string;
      return patch<T>(`/api/outputs/${encodeURIComponent(id)}`, { name: p.name });
    }

    // "" clears the friendly URL. Rejections come back as a 400 with the reason
    // (reserved page, already taken, bad characters) — the caller surfaces it.
    // Icon tint for a display id or tool path; "" clears it.
    case "icons:setColor":
      return post<T>("/api/icon-color", { key: p.key, color: p.color });

    // Icon glyph for the same key; "" restores the item's built-in icon.
    case "icons:setIcon":
      return post<T>("/api/icon-glyph", { key: p.key, glyph: p.glyph });

    case "outputs:setSlug": {
      const id = p.id as string;
      return patch<T>(`/api/outputs/${encodeURIComponent(id)}`, { slug: p.slug });
    }

    case "outputs:setView": {
      const id = p.id as string;
      return patch<T>(`/api/outputs/${encodeURIComponent(id)}`, { viewId: p.viewId });
    }

    case "outputs:setLocked": {
      const id = p.id as string;
      return patch<T>(`/api/outputs/${encodeURIComponent(id)}`, { locked: p.locked });
    }

    case "outputs:setHideTopBar": {
      const id = p.id as string;
      return patch<T>(`/api/outputs/${encodeURIComponent(id)}`, { hideTopBar: p.hideTopBar });
    }

    case "history:editWindow":
      return post<T>("/api/history/window", p);

    case "history:recalcAttendance":
      return post<T>("/api/history/recalc", p);

    case "history:setItemCounted":
      return post<T>("/api/history/item-counted", p);

    case "history:merge":
      return post<T>("/api/history/merge", p);

    case "layout:uploadImage":
      return post<T>("/api/layout-images", { dataUrl: p.dataUrl });

    case "outputs:remove": {
      const id = p.id as string;
      return del<T>(`/api/outputs/${encodeURIComponent(id)}`);
    }

    case "outputs:reorder":
      return post<T>("/api/outputs/reorder", { ids: p.ids });

    case "outputs:openWindow":
      // No native windows in standalone mode — no-op.
      return { ok: true } as unknown as T;

    // ── Integrations ───────────────────────────────────────────────────
    case "integrations:list":
      return apiFetch<T>("/api/integrations");

    case "integrations:setConfig": {
      const id = p.id as string;
      return post<T>(`/api/integrations/${encodeURIComponent(id)}/config`, { config: p.config });
    }

    case "integrations:setEnabled": {
      const id = p.id as string;
      return post<T>(`/api/integrations/${encodeURIComponent(id)}/enabled`, { enabled: p.enabled });
    }

    case "integrations:test": {
      const id = p.id as string;
      return post<T>(`/api/integrations/${encodeURIComponent(id)}/test`);
    }

    // ── Wireless ───────────────────────────────────────────────────────
    case "wireless:listProviders":
      return apiFetch<T>("/api/wireless/providers");

    case "wireless:listConnections":
      return apiFetch<T>("/api/wireless/connections");

    case "wireless:addConnection":
      return post<T>("/api/wireless/connections", p);

    case "wireless:updateConnection": {
      const id = p.id as string;
      return patch<T>(`/api/wireless/connections/${encodeURIComponent(id)}`, { patch: p.patch });
    }

    case "wireless:removeConnection": {
      const id = p.id as string;
      return del<T>(`/api/wireless/connections/${encodeURIComponent(id)}`);
    }

    case "wireless:testConnection": {
      const id = p.id as string;
      return post<T>(`/api/wireless/connections/${encodeURIComponent(id)}/test`);
    }

    // The picker list (id + label, including channels that have never reported).
    case "wireless:listChannels":
      return apiFetch<T>("/api/integrations/wireless/channels");

    // Live telemetry per channel. Deliberately NOT the same call as the picker —
    // see use-wireless-channels.ts for what conflating them cost.
    case "wireless:channelStatuses":
      return apiFetch<T>("/api/integrations/wireless/statuses");

    case "wireless:getMeterRate":
      return apiFetch<T>("/api/wireless/meter-rate");

    case "wireless:setMeterRate":
      return post<T>("/api/wireless/meter-rate", p);

    // ── OSC ──────────────────────────────────────────────────────────────
    case "osc:listTargets":
      return apiFetch<T>("/api/osc/targets");

    case "osc:addTarget":
      return post<T>("/api/osc/targets", p);

    case "osc:updateTarget": {
      const id = p.id as string;
      return patch<T>(`/api/osc/targets/${encodeURIComponent(id)}`, { patch: p.patch });
    }

    case "osc:removeTarget": {
      const id = p.id as string;
      return del<T>(`/api/osc/targets/${encodeURIComponent(id)}`);
    }

    case "osc:testTarget": {
      const id = p.id as string;
      return post<T>(`/api/osc/targets/${encodeURIComponent(id)}/test`);
    }

    case "automation:registry": return apiFetch("/api/automation/registry");
    case "automation:rules": return apiFetch("/api/automation/rules");
    case "automation:plan-items": return apiFetch("/api/automation/plan-items");
    case "automation:addRule": return post("/api/automation/rules", params);
    case "automation:updateRule": return patch(`/api/automation/rules/${(params as { id: string }).id}`, (params as { patch: unknown }).patch);
    case "automation:removeRule": return del(`/api/automation/rules/${(params as { id: string }).id}`);
    case "automation:testRule": return post(`/api/automation/rules/${(params as { id: string }).id}/test`);
    case "automation:settings": return apiFetch("/api/automation/settings");
    case "automation:setSettings": return post("/api/automation/settings", params);
    case "automation:log": return apiFetch("/api/automation/log");
    case "automation:clearLog": return del("/api/automation/log");
    case "rosstalk:targets": return apiFetch("/api/rosstalk/targets");
    case "rosstalk:addTarget": return post("/api/rosstalk/targets", params);
    case "rosstalk:updateTarget": return patch(`/api/rosstalk/targets/${(params as { id: string }).id}`, (params as { patch: unknown }).patch);
    case "rosstalk:removeTarget": return del(`/api/rosstalk/targets/${(params as { id: string }).id}`);
    case "rosstalk:test": return post(`/api/rosstalk/targets/${(params as { id: string }).id}/test`);
    case "rosstalk:commands": return apiFetch("/api/rosstalk/commands");
    case "rosstalk:send": return post("/api/rosstalk/send", params);
    case "rosstalk:setSimulate": return post("/api/rosstalk/simulate", params);
    case "osc:send":
      return post<T>("/api/osc/send", p);

    case "action:invoke":
      return post<T>("/api/action/invoke", p);

    case "outputs:setMode":
      return patch<T>(`/api/outputs/${encodeURIComponent(String(p.id))}`, { mode: p.mode });

    case "barItems:set":
      return post<T>("/api/bar-items", p);

    case "savedColors:set":
      return post<T>("/api/saved-colors", p);

    case "notes:set":
      return post<T>("/api/notes", p);

    case "views:setSurface":
      return patch<T>(`/api/views/${encodeURIComponent(String(p.id))}`, { surface: p.surface });

    case "osc:getFeedback":
      return apiFetch<T>("/api/osc/feedback");

    case "osc:getFeedbackPort":
      return apiFetch<T>("/api/osc/feedback-port");

    case "osc:setFeedbackPort":
      return post<T>("/api/osc/feedback-port", p);

    // ── Window / app ───────────────────────────────────────────────────
    case "window:closeSettings":
      window.close();
      return undefined as unknown as T;

    case "app:getInfo":
      return { version: "standalone", name: "Stage Utility" } as unknown as T;

    default:
      throw new Error(`[api] Unknown IPC channel: "${channel}"`);
  }
}

// ── SSE subscription ──────────────────────────────────────────────────────────

interface SseListener {
  channel: string;
  handler: (e: MessageEvent) => void;
}

let eventSource: EventSource | null = null;
const sseListeners: SseListener[] = [];

/**
 * Channels the server pushes a snapshot of the moment a stream connects.
 *
 * That hydrate fires once, at connect — so a component that mounts later (any
 * settings tab, for instance) misses it and then only hears about *changes*. In a
 * steady state there are none, which is how the Screens page could sit on
 * "Offline" while the server knew the screen was connected.
 *
 * The last payload for each of these is kept and replayed to a late subscriber.
 * Every one is a state snapshot, so replaying it is what the subscriber would have
 * received had it been listening. Command channels (display:refresh) are
 * deliberately absent — replaying one of those would re-fire the command.
 *
 * `hydrated-channels.test.ts` reads remote-server.ts and fails if the two lists
 * drift, so a new hydrated channel cannot silently reintroduce the bug.
 */
// The canonical list moved to sse-channels.ts so the shared SSE worker can share
// it — that module imports nothing, which is what makes it safe in a worker.
// Re-exported here because this is the import path everything already uses,
// including hydrated-channels.test.ts, which pins the list against the server.
export { HYDRATED_CHANNELS };

const hydratedSet = HYDRATED_SET;
/** Last payload seen per hydrated channel, for replay to late subscribers. */
const lastPayload = new Map<string, unknown>();

/**
 * Test seam — forget the replay cache, so a case can model a COLD page.
 *
 * The cache is module-level and a test file shares one module registry across
 * every case in it, so a frame emitted by one case is replayed into the next
 * one's first subscriber. That is right in a browser and wrong in a suite: a
 * case whose premise is "the server was down at page load" would be handed a
 * state frame from the case above it, and pass or fail on test ORDER.
 */
export function __resetReplayCacheForTests(): void {
  lastPayload.clear();
}

// Stable per-context client id, sent on the SSE URL so the server can scope this
// stream's channel filter to us. crypto.randomUUID is unavailable in an insecure
// context (prod is plain HTTP), so guard it and fall back.
function genClientId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch {
    /* insecure context — fall through */
  }
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
const CLIENT_ID = genClientId();

// Tell the server exactly which channels this client renders so it can skip the
// rest (e.g. a mic display never gets the 4 Hz spl:metrics firehose). Debounced to
// batch the burst of subscribes when a view mounts. A failed report just means the
// server keeps sending everything — filtering is an optimization, never required.
let reportTimer: ReturnType<typeof setTimeout> | null = null;
function reportChannels(): void {
  if (reportTimer) return;
  reportTimer = setTimeout(() => {
    reportTimer = null;
    const channels = [...new Set(sseListeners.map((l) => l.channel))];
    void post("/api/events/subscribe", { cid: CLIENT_ID, channels }).catch(() => {});
  }, 200);
}

// ── Shared-worker SSE relay ─────────────────────────────────────────────────
// ON by default. One EventSource shared across all of this machine's tabs, and
// across every iframe in them. Browsers cap concurrent connections at ~6 per
// origin over HTTP/1.1 and each stream is held permanently, so without the relay
// the sixth tab could not load AT ALL: nothing was left for its /api/state, which
// then died at REQUEST_TIMEOUT_MS. The Screens page renders a live preview iframe
// per display, so a machine reaches the cap on one page — with eight displays the
// seventh onward never loaded. Measured: three tabs hold three connections direct
// and one through the worker.
//
// It was opt-in until the tab-to-WORKER gap was closed. Worker-to-SERVER breaks
// were already covered by reconnect with backoff, hydrate replay and a wake nudge,
// but `ensureWorker` built the worker once and nothing watched the port
// afterwards: when the shared stream broke, every already-open tab was orphaned
// silently — observed on an 8-tab machine through a server restart as three tabs
// sitting on a title three state-changes stale, while a reloaded tab picked up the
// next change immediately. That was worse than the per-tab path it replaces, where
// a dead stream costs one tab and self-heals. The port heartbeat below (tab pings,
// worker pongs, `abandonWorker` falls back to a direct EventSource when the pong
// stops) is what closed it and what makes defaulting this on safe.
//
//   Opt out: localStorage.setItem("stage:sharedSse", "0")  (then reload)
let sharedSse = (() => {
  try {
    return typeof SharedWorker !== "undefined" && localStorage.getItem("stage:sharedSse") !== "0";
  } catch {
    return false;
  }
})();

/** Wrappers added to the direct stream while the worker is unavailable, so a
 *  recovery can remove exactly these and leave real direct listeners alone. */
const fallbackWrappers: SseListener[] = [];

/** Test seam for the worker fallback/recovery bookkeeping. */
export const __sseFallback = {
  wrapperCount: () => fallbackWrappers.length,
  listenerCount: () => sseListeners.length,
  handlerChannels: () => [...workerHandlers.keys()],
  abandon: (why: string) => abandonWorker(why),
  /** Re-enter the "worker is live" state, as a retry does just before it calls
   *  ensureWorker(). Without this a test cannot reach the failed-retry path,
   *  because abandonWorker early-returns once already abandoned. */
  simulateRetryStart: () => { sharedSse = true; },
  /** Put a callback in the worker registry, as a tab running ON the worker
   *  would have. jsdom has no SharedWorker, so without this the registry is
   *  empty, no wrappers are ever built, and every assertion about them passes
   *  vacuously. */
  seedWorkerHandler: (channel: string) => {
    const set = workerHandlers.get(channel) ?? new Set();
    set.add(() => {});
    workerHandlers.set(channel, set);
  },
  reset: () => {
    fallbackWrappers.length = 0;
    sseListeners.length = 0;
    workerHandlers.clear();
  },
};

/** How often a tab checks the worker is still delivering. */
const WORKER_PING_MS = 15_000;
/** How long a missed pong is tolerated before abandoning the worker. */
const WORKER_PONG_TIMEOUT_MS = 5_000;
let workerPingTimer: ReturnType<typeof setInterval> | null = null;
let workerPongTimer: ReturnType<typeof setTimeout> | null = null;
const workerHandlers = new Map<string, Set<(payload: unknown, replayed: boolean) => void>>();
let sseWorker: SharedWorker | null = null;

function ensureWorker(): boolean {
  if (sseWorker) return true;
  try {
    sseWorker = new SharedWorker(new URL("./sse-shared-worker.ts", import.meta.url), { type: "module" });
    sseWorker.port.onmessage = (ev: MessageEvent) => {
      const msg = ev.data as { type?: string; streamOpen?: boolean; channel?: string; data?: unknown };
      if (msg.type === "pong") {
        // Answered: the worker is alive. Whether its STREAM is alive is a
        // separate question, and a worker with a dead stream is the failure
        // that kept this off by default - so that counts as no answer.
        if (workerPongTimer) { clearTimeout(workerPongTimer); workerPongTimer = null; }
        if (msg.streamOpen === false) abandonWorker("its event stream is closed");
        return;
      }
      // `replay` is the worker's word for "this is the cached snapshot, not
      // something the server just sent" — the same distinction the direct path
      // draws, so a subscriber cannot tell which transport it is on.
      const { channel, data, replay } = msg as { channel: string; data: unknown; replay?: boolean };
      const set = workerHandlers.get(channel);
      if (set) for (const cb of set) {
        try { cb(data, replay === true); } catch (err) { console.error(`[api] SSE handler error for "${channel}":`, err); }
      }
    };
    sseWorker.port.start();
    startWorkerHeartbeat();
    addEventListener("pagehide", () => {
      try { sseWorker?.port.postMessage({ type: "bye" }); } catch { /* ignore */ }
    });
    return true;
  } catch (err) {
    console.warn("[api] SharedWorker SSE unavailable — falling back to direct EventSource", err);
    sseWorker = null;
    sharedSse = false; // permanent fallback for this session
    return false;
  }
}

/**
 * Stop trusting the worker and reconnect this tab directly.
 *
 * The whole reason the shared worker was off by default: a worker can be
 * orphaned, or keep running with a dead stream, and a tab had no way to notice.
 * Three tabs sat three state-changes stale with nothing reporting it. This is
 * the escape hatch - noisy in the console on purpose, because a machine falling
 * back to per-tab streams is worth knowing about.
 */
function abandonWorker(why: string): void {
  if (!sharedSse && !sseWorker) return;
  console.warn(`[api] shared SSE worker abandoned (${why}) — falling back to a direct stream`);
  stopWorkerHeartbeat();
  scheduleWorkerRetry();
  try { sseWorker?.port.postMessage({ type: "bye" }); } catch { /* it may already be gone */ }
  sseWorker = null;
  sharedSse = false; // until a retry succeeds — see scheduleWorkerRetry
  // Re-establish everything the worker was carrying, directly.
  //
  // Only build the fallback wrappers once. A failed RETRY re-enters here while
  // the previous fallback is still wired up, and rebuilding then would leave two
  // wrappers per channel - every event handled twice, every list rendered twice.
  if (fallbackWrappers.length > 0) {
    ensureEventSource();
    reportChannels();
    return;
  }
  // workerHandlers is KEPT, not drained: it is the canonical registry of
  // parsed-payload callbacks, and a later recovery needs it intact. The two
  // transports disagree about shape — sseListeners holds MessageEvent handlers
  // while the worker delivers already-parsed data — so each callback gets a
  // wrapper, and the wrappers are remembered so recovery can unhook exactly
  // them rather than guessing.
  for (const [channel, callbacks] of workerHandlers) {
    for (const cb of callbacks) {
      const handler = (e: MessageEvent) => {
        try {
          // A frame off the wire, never a replay — this is the direct
          // EventSource path standing in for the abandoned worker.
          cb(JSON.parse(e.data), false);
        } catch (err) {
          console.error(`[api] SSE handler error for "${channel}":`, err);
        }
      };
      fallbackWrappers.push({ channel, handler });
      sseListeners.push({ channel, handler });
    }
  }
  ensureEventSource();
  for (const w of fallbackWrappers) eventSource?.addEventListener(w.channel, w.handler);
  reportChannels();
}

/**
 * Try the worker again later, and keep trying.
 *
 * Without this, "fall back to a direct stream" is a ONE-WAY door: a transient
 * hiccup — a worker restart, a laptop waking — would push a tab onto its own
 * connection permanently, and tab by tab a machine would drift back to one
 * stream per tab. That is precisely the exhaustion the shared worker exists to
 * prevent, arrived at slowly instead of immediately, which is worse because
 * nothing looks wrong until the sixth preview stops loading.
 *
 * Backs off so a genuinely broken worker is not retried every few seconds
 * forever, and caps rather than giving up: the machine may be fine again in an
 * hour and nobody is going to reload eight wall displays to find out.
 */
const WORKER_RETRY_MIN_MS = 30_000;
const WORKER_RETRY_MAX_MS = 10 * 60_000;
let workerRetryDelayMs = WORKER_RETRY_MIN_MS;
let workerRetryTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleWorkerRetry(): void {
  if (workerRetryTimer) return;
  workerRetryTimer = setTimeout(() => {
    workerRetryTimer = null;
    workerRetryDelayMs = Math.min(workerRetryDelayMs * 2, WORKER_RETRY_MAX_MS);
    if (typeof SharedWorker === "undefined") return; // nothing to go back to
    try {
      if (localStorage.getItem("stage:sharedSse") === "0") return; // opted out
    } catch { /* storage unavailable — keep trying */ }
    sharedSse = true;
    if (!ensureWorker()) return; // ensureWorker already fell back and rescheduled
    console.log("[api] shared SSE worker recovered — moving this tab back onto it");
    // Unhook only the wrappers this fallback added. Anything else on the direct
    // stream was registered elsewhere and is not ours to remove.
    for (const w of fallbackWrappers) {
      eventSource?.removeEventListener(w.channel, w.handler);
      const i = sseListeners.indexOf(w);
      if (i >= 0) sseListeners.splice(i, 1);
    }
    fallbackWrappers.length = 0;
    // workerHandlers still holds every callback, so the worker picks up exactly
    // what it was carrying before.
    workerReport();
    // Close this tab's own stream, so the connection is actually returned rather
    // than left open and idle — which would defeat the point of going back.
    if (eventSource && sseListeners.length === 0) {
      eventSource.close();
      eventSource = null;
    }
    workerRetryDelayMs = WORKER_RETRY_MIN_MS;
  }, workerRetryDelayMs);
}

function startWorkerHeartbeat(): void {
  stopWorkerHeartbeat();
  workerPingTimer = setInterval(() => {
    if (!sseWorker) return;
    // A missed pong means the worker is gone or wedged. Only one timer is armed
    // at a time, so a slow answer does not stack up abandonments.
    if (workerPongTimer) return;
    workerPongTimer = setTimeout(() => {
      workerPongTimer = null;
      abandonWorker("no pong");
    }, WORKER_PONG_TIMEOUT_MS);
    try {
      sseWorker.port.postMessage({ type: "ping" });
    } catch {
      abandonWorker("port is dead");
    }
  }, WORKER_PING_MS);
}

function stopWorkerHeartbeat(): void {
  if (workerPingTimer) { clearInterval(workerPingTimer); workerPingTimer = null; }
  if (workerPongTimer) { clearTimeout(workerPongTimer); workerPongTimer = null; }
}

function workerReport(): void {
  sseWorker?.port.postMessage({ type: "subscribe", channels: [...workerHandlers.keys()] });
}

function ensureEventSource(): EventSource {
  if (eventSource && eventSource.readyState !== EventSource.CLOSED) {
    return eventSource;
  }

  console.log("[api] (re)connecting SSE at /api/events");
  eventSource = new EventSource(`/api/events?cid=${encodeURIComponent(CLIENT_ID)}`);

  // Capture every hydrated channel's snapshot whether or not anything is listening
  // yet — that is the whole point, since the hydrate lands before the tab that
  // wants it has mounted. These are attached directly to the EventSource and are
  // deliberately NOT in `sseListeners`, so they do not widen the channel filter
  // reported to the server.
  for (const channel of HYDRATED_CHANNELS) {
    eventSource.addEventListener(channel, (e: MessageEvent) => {
      try {
        lastPayload.set(channel, JSON.parse(e.data));
      } catch {
        /* a malformed frame is the dispatcher's problem, not the cache's */
      }
    });
  }

  // Re-attach all registered listeners on reconnect.
  for (const entry of sseListeners) {
    eventSource.addEventListener(entry.channel, entry.handler);
  }

  // (Re)report our channel set on every (re)connect — the server drops the filter
  // when a stream closes, so a transparent reconnect needs a fresh report.
  eventSource.onopen = () => {
    sseReconnectDelayMs = SSE_RECONNECT_MIN_MS;
    reportChannels();
  };

  eventSource.onerror = (e) => {
    // CONNECTING means the browser is retrying on its own — leave it alone.
    // CLOSED means it has GIVEN UP, and nothing else would ever reopen the
    // stream: the page goes on rendering its last snapshot, silently receiving
    // nothing, until someone reloads it. That is what a display looks like when
    // it "stops updating" after a server restart — the browser closes the stream
    // on an error response and never comes back on its own.
    if (eventSource?.readyState === EventSource.CLOSED) {
      console.warn("[api] SSE closed — scheduling reconnect", e);
      scheduleSseReconnect();
    }
  };

  return eventSource;
}

let sseReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let sseReconnectDelayMs = 1000;
const SSE_RECONNECT_MIN_MS = 1000;
const SSE_RECONNECT_MAX_MS = 30_000;

/** Reopen a permanently-closed stream, backing off so a server that is still
 *  down is not hammered by every display in the building at once. */
function scheduleSseReconnect(): void {
  if (sseReconnectTimer) return;
  sseReconnectTimer = setTimeout(() => {
    sseReconnectTimer = null;
    sseReconnectDelayMs = Math.min(sseReconnectDelayMs * 2, SSE_RECONNECT_MAX_MS);
    ensureEventSource();
  }, sseReconnectDelayMs);
}

// A kiosk display can sit untouched for days. When its tab is shown again, make
// sure the stream is actually alive rather than trusting that it survived —
// a closed one reconnects immediately instead of waiting out the backoff.
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    // Shared path: the worker owns the stream, so ask IT to check. A machine that
    // slept may have had the stream closed underneath every tab at once.
    if (sharedSse && sseWorker) {
      try { sseWorker.port.postMessage({ type: "wake" }); } catch { /* ignore */ }
      return;
    }
    if (eventSource && eventSource.readyState === EventSource.CLOSED) {
      sseReconnectDelayMs = SSE_RECONNECT_MIN_MS;
      ensureEventSource();
    }
  });
}

/**
 * Subscribe to a server-sent event channel.
 * Returns an unsubscribe function.
 *
 * The handler's second argument says whether the frame is a REPLAY of the cached
 * snapshot rather than something the server just sent. The two are not
 * interchangeable, and a subscriber that has also issued a one-shot read has to
 * be able to tell them apart:
 *
 *   - a LIVE frame is newer than any read already in flight, so it wins;
 *   - a REPLAYED frame is at best connect-time and can be far older. The server
 *     filters a channel out for a client with nothing subscribed to it, so the
 *     moment the last subscriber for a channel goes away the cache stops being
 *     updated — a component that mounts, unmounts and mounts again is handed a
 *     snapshot from whenever the previous one was listening. Correcting exactly
 *     that is what the read is for, so it must not be dropped in its favour.
 *
 * Ignoring the argument is fine and is what most subscribers do — it changes
 * nothing about which frames arrive or in what order.
 */
export function onNotification(
  channel: string,
  cb: (payload: unknown, replayed: boolean) => void,
): () => void {
  // Shared-worker path: register the callback and let the worker deliver parsed
  // payloads. Falls through to the direct path if the worker can't be created.
  if (sharedSse && ensureWorker()) {
    let set = workerHandlers.get(channel);
    if (!set) {
      set = new Set();
      workerHandlers.set(channel, set);
    }
    set.add(cb);
    workerReport();
    return () => {
      set!.delete(cb);
      if (set!.size === 0) workerHandlers.delete(channel);
      workerReport();
    };
  }

  const handler = (e: MessageEvent) => {
    try {
      const payload = JSON.parse(e.data);
      if (hydratedSet.has(channel)) lastPayload.set(channel, payload);
      cb(payload, false);
    } catch (err) {
      console.error(`[api] SSE parse error for "${channel}":`, err);
    }
  };

  const entry: SseListener = { channel, handler };
  sseListeners.push(entry);

  // Replay the connect-time snapshot this subscriber was too late for. Deferred
  // so a caller cannot receive it synchronously during its own render.
  if (hydratedSet.has(channel) && lastPayload.has(channel)) {
    const cached = lastPayload.get(channel);
    queueMicrotask(() => cb(cached, true));
  }

  const es = ensureEventSource();
  es.addEventListener(channel, handler);
  reportChannels(); // our channel set grew — tell the server

  return () => {
    const idx = sseListeners.indexOf(entry);
    if (idx !== -1) sseListeners.splice(idx, 1);
    eventSource?.removeEventListener(channel, handler);
    reportChannels(); // our channel set shrank — tell the server
  };
}
