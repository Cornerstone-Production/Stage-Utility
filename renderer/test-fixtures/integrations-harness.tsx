// A running Integrations page for a test, with the network faked and nothing else.
//
// `invoke()` in renderer/lib/api.ts is a channel -> HTTP mapping over `fetch`, so
// stubbing `fetch` leaves every layer above it — the channel map, react-query,
// the panel, the dialog, each bespoke panel — running for real. That is the point:
// the guards in this feature are about what the real components do when a card
// moves group or a dialog is dismissed, and a mocked component proves none of it.
//
// Import this only from a test, and only after installDom().

import { strict as assert } from "node:assert";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement, ReactNode } from "react";
import { TooltipProvider } from "../components/ui/tooltip-provider";
import { INTEGRATION_DESCRIPTOR_FIXTURE } from "./integration-descriptors";

/** What the fake server answers for a GET, by path. Captured from a real server
 *  on a fresh install; every one of these is reached by mounting the page. */
const GET_ROUTES: Record<string, unknown> = {
  "/api/state": { serviceTypeId: null, planTitle: null, lastRefreshedAt: null, slots: [], items: [] },
  "/api/people/count": { connected: false, updatedAt: null, total: { attendance: null, occupancy: null }, zones: [], rev: 0 },
  "/api/attendance/history": [],
  "/api/attendance/history/current": null,
  "/api/propresenter/status": { connected: false },
  "/api/propresenter/instances": { list: [{ id: "default", name: "Main" }], status: {}, conn: {} },
  "/api/pco/live": null,
  "/api/osc/targets": [],
  "/api/osc/feedback-port": { port: 9000 },
  "/api/rosstalk/targets": { targets: [], simulate: true },
  "/api/wireless/providers": [{ id: "none", kind: "wireless", label: "None", configSchema: [] }],
  "/api/wireless/connections": [],
  "/api/scores/favourites": { favourites: [] },
  "/api/sensource/locations": [],
  "/api/sensource/zones": [],
};

export interface FakeServer {
  /** Live integration states, mutated by the routes the page posts to. */
  states: Map<string, IntegrationState>;
  /** Every POST the page made, in order — `{ path, body }`. */
  posts: { path: string; body: unknown }[];
  /** Any GET the page made that no route above answers. A non-empty list here
   *  means the harness is lying to the component about something. */
  unhandled: string[];
  restore: () => void;
}

/** A fresh-install state for one integration. */
export function blankState(id: string, over: Partial<IntegrationState> = {}): IntegrationState {
  return {
    id,
    enabled: false,
    connection: "disconnected",
    message: null,
    config: {},
    configured: false,
    ...over,
  } as IntegrationState;
}

/**
 * Point `fetch` and `EventSource` at an in-memory server.
 *
 * @param overrides per-integration state, merged over the fresh-install default.
 * @param routes    extra or replacement GET responses, by path.
 */
export function installFakeServer(
  overrides: Record<string, Partial<IntegrationState>> = {},
  routes: Record<string, unknown> = {},
): FakeServer {
  const getRoutes = { ...GET_ROUTES, ...routes };
  const states = new Map<string, IntegrationState>(
    INTEGRATION_DESCRIPTOR_FIXTURE.map((d) => [d.id, blankState(d.id, overrides[d.id] ?? {})]),
  );
  const posts: { path: string; body: unknown }[] = [];
  const unhandled: string[] = [];

  const g = globalThis as unknown as Record<string, unknown>;
  const prevFetch = g.fetch;
  const prevES = g.EventSource;

  const json = (value: unknown): Response =>
    ({ ok: true, status: 200, statusText: "OK", json: async () => value }) as unknown as Response;

  g.fetch = async (input: unknown, init?: { method?: string; body?: string }): Promise<Response> => {
    const path = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body) : undefined;

    if (method !== "GET") posts.push({ path, body });

    if (path === "/api/integrations") {
      return json({ descriptors: INTEGRATION_DESCRIPTOR_FIXTURE, states: [...states.values()] });
    }

    const enabled = /^\/api\/integrations\/([^/]+)\/enabled$/.exec(path);
    if (enabled) {
      const id = decodeURIComponent(enabled[1]);
      const next = { ...states.get(id)!, enabled: (body as { enabled: boolean }).enabled };
      states.set(id, next);
      return json(next);
    }

    const config = /^\/api\/integrations\/([^/]+)\/config$/.exec(path);
    if (config) {
      const id = decodeURIComponent(config[1]);
      const patch = (body as { config: Record<string, unknown> }).config;
      const prev = states.get(id)!;
      const next = { ...prev, config: { ...prev.config, ...patch }, configured: true };
      states.set(id, next);
      return json(next);
    }

    if (/^\/api\/integrations\/[^/]+\/test$/.test(path)) return json({ ok: true, message: "OK" });

    const known = Object.keys(getRoutes).find((r) => path === r || path.startsWith(`${r}?`));
    if (known) return json(getRoutes[known]);

    // A POST nobody declared is almost always bookkeeping (the SSE channel
    // report). A GET nobody declared is a component being told a lie, so it is
    // recorded rather than swallowed — a test can assert the list is empty.
    if (method === "GET") unhandled.push(path);
    return json({ ok: true });
  };

  // jsdom ships no EventSource, and api.ts opens one the moment anything
  // subscribes. Never delivers an event; the tests here drive state through the
  // POST routes, which is the path the operator's clicks actually take.
  class FakeEventSource {
    static readonly CLOSED = 2;
    readyState = 1;
    addEventListener(): void {}
    removeEventListener(): void {}
    close(): void {
      this.readyState = 2;
    }
  }
  g.EventSource = FakeEventSource;

  return {
    states,
    posts,
    unhandled,
    restore() {
      if (prevFetch === undefined) delete g.fetch;
      else g.fetch = prevFetch;
      if (prevES === undefined) delete g.EventSource;
      else g.EventSource = prevES;
    },
  };
}

/**
 * The providers the operator app wraps everything in (renderer/app/index.tsx),
 * with query retries off so a failure surfaces immediately.
 *
 * TooltipProvider is not optional here: ConnectionBadge's error branch renders a
 * Tooltip, so a render of any integration in an error state throws
 * "`Tooltip` must be used within `TooltipProvider`" without it.
 */
export function withQueryClient(children: ReactNode): ReactElement {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return (
    <QueryClientProvider client={client}>
      <TooltipProvider>{children}</TooltipProvider>
    </QueryClientProvider>
  );
}

/** Let react-query resolve, React commit, and Radix finish its animation frames. */
export const settle = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Assert a DOM node is not there.
 *
 * Never `assert.equal(node, null)`: assert renders a diff of whatever it is
 * handed, and serialising a jsdom element — a whole dialog, say — takes long
 * enough that node:test SIGKILLs the file and reports `'test failed'` at line
 * 1:1 instead of the assertion that failed. That has cost real time twice here.
 * Compare booleans, and put a short excerpt of what WAS found in the message.
 */
export function assertAbsent(node: Element | null | undefined, message: string): void {
  assert.equal(
    node == null,
    true,
    `${message} — found <${node?.tagName?.toLowerCase()}> ${node?.textContent?.slice(0, 60) ?? ""}`,
  );
}
