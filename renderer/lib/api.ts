// api.ts — Backend client for the renderer.
//
// invoke<T>(channel, params?) maps logical channels to HTTP fetch calls.
// onNotification(channel, cb)  subscribes to SSE push events.
//
// The renderer is always served from the same origin as the HTTP server
// (port 8788), so all paths here are relative.

type Params = Record<string, unknown> | undefined;

// ── HTTP helpers ──────────────────────────────────────────────────────────────

// Hard ceiling so a request that never settles (e.g. a stalled backend route)
// surfaces as an error instead of hanging a query in its loading state forever.
const REQUEST_TIMEOUT_MS = 15000;

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
      throw new Error(`Request to ${path} timed out`);
    }
    throw err;
  }
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const body = await res.json();
      if (typeof body?.error === "string") msg = body.error;
    } catch { /* ignore */ }
    throw new Error(msg);
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

    case "stage:listServiceTypes":
      return apiFetch<T>("/api/service-types");

    case "stage:listPlans": {
      const id = p.serviceTypeId as string;
      return apiFetch<T>(`/api/plans?serviceTypeId=${encodeURIComponent(id)}`);
    }

    case "stage:listTeamPositions":
      return apiFetch<T>("/api/team-positions");

    case "stage:setServiceType":
      return post<T>("/api/service-type", p);

    case "stage:setPlan":
      return post<T>("/api/plan", p);

    case "stage:selectNextPlan":
      return post<T>("/api/plan/next");

    case "stage:setPlanMode":
      return post<T>("/api/plan/mode", p);

    case "stage:setSlots":
      return post<T>("/api/slots", p);

    case "stage:refresh":
      return post<T>("/api/refresh");

    case "pco:liveNext":
      return post<T>("/api/live/next");

    case "pco:livePrevious":
      return post<T>("/api/live/previous");

    case "stage:setAllowedServiceTypes":
      return post<T>("/api/allowed-service-types", p);

    case "stage:setShowQr":
      return post<T>("/api/show-qr", p);

    case "stage:setBranding":
      return post<T>("/api/branding", p);

    case "stage:getBrandingSource": {
      const target = p.target === "empty" ? "empty" : "app";
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
      return post<T>(`/api/presets/${encodeURIComponent(id)}/apply`, { displayId: p.displayId });
    }

    case "presets:delete": {
      const id = p.id as string;
      return del<T>(`/api/presets/${encodeURIComponent(id)}`);
    }

    // ── Displays ───────────────────────────────────────────────────────
    case "displays:add":
      return post<T>("/api/displays", p);

    case "displays:rename": {
      const id = p.id as string;
      return patch<T>(`/api/displays/${encodeURIComponent(id)}`, { name: p.name });
    }

    case "displays:setKind": {
      const id = p.id as string;
      return patch<T>(`/api/displays/${encodeURIComponent(id)}`, { kind: p.kind });
    }

    case "displays:remove": {
      const id = p.id as string;
      return del<T>(`/api/displays/${encodeURIComponent(id)}`);
    }

    case "displays:openWindow":
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

    case "wireless:listChannels":
      return apiFetch<T>("/api/integrations/wireless/channels");

    case "wireless:getMeterRate":
      return apiFetch<T>("/api/wireless/meter-rate");

    case "wireless:setMeterRate":
      return post<T>("/api/wireless/meter-rate", p);

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

function ensureEventSource(): EventSource {
  if (eventSource && eventSource.readyState !== EventSource.CLOSED) {
    return eventSource;
  }

  console.log("[api] (re)connecting SSE at /api/events");
  eventSource = new EventSource("/api/events");

  // Re-attach all registered listeners on reconnect.
  for (const entry of sseListeners) {
    eventSource.addEventListener(entry.channel, entry.handler);
  }

  eventSource.onerror = (e) => {
    console.warn("[api] SSE error — browser will auto-reconnect", e);
  };

  return eventSource;
}

/**
 * Subscribe to a server-sent event channel.
 * Returns an unsubscribe function.
 */
export function onNotification(
  channel: string,
  cb: (payload: unknown) => void,
): () => void {
  const handler = (e: MessageEvent) => {
    try {
      cb(JSON.parse(e.data));
    } catch (err) {
      console.error(`[api] SSE parse error for "${channel}":`, err);
    }
  };

  const entry: SseListener = { channel, handler };
  sseListeners.push(entry);

  const es = ensureEventSource();
  es.addEventListener(channel, handler);

  return () => {
    const idx = sseListeners.indexOf(entry);
    if (idx !== -1) sseListeners.splice(idx, 1);
    eventSource?.removeEventListener(channel, handler);
  };
}
