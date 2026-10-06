// One search param of the current address, as state.
//
// For a page that keeps a choice in its URL so a refresh or a copied link lands
// in the same place. Returns the param as a string (or null when absent) and a
// setter that navigates.
//
// TanStack parses a search value as JSON, so `?plan=123` arrives as the NUMBER
// 123, and a string that looks like a number is written back QUOTED
// (`?plan=%22123%22`). This hook hands callers strings both ways: a numeric id
// is read as its digits and written as a number, which keeps the address clean.
//
// `useRouter({ warn: false })` is null with no router above (a test rendering a
// page alone); the value then lives in component state only, seeded from
// `window.location`. Same fallback and the same typing-only-what-is-touched
// handle as the History page's `?service=`, which predates this.

import { useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";

interface RouterHandle {
  state: { location: { pathname: string; search: Record<string, unknown> } };
  navigate: (opts: { to: string; search: Record<string, unknown>; replace?: boolean; hash?: true }) => unknown;
  subscribe: (event: "onResolved", fn: () => void) => () => void;
}

function asString(v: unknown): string | null {
  if (typeof v === "string") return v || null;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

/** A value for the router's `search`: digits go in as a number so the address
 *  reads `?plan=123`. Only when the number survives the round trip exactly. */
function forSearch(value: string): string | number {
  const n = Number(value);
  return /^\d+$/.test(value) && Number.isSafeInteger(n) && String(n) === value ? n : value;
}

function readParam(router: RouterHandle | null, name: string): string | null {
  if (router) return asString(router.state.location.search[name]);
  return new URLSearchParams(window.location.search).get(name) || null;
}

export function useRouterHandle(): RouterHandle | null {
  return useRouter({ warn: false }) as unknown as RouterHandle | null;
}

export function useSearchParam(name: string): [string | null, (value: string | null, opts?: { replace?: boolean }) => void] {
  const router = useRouterHandle();
  const [value, setLocal] = useState<string | null>(() => readParam(router, name));

  // Back, Forward, or a link landing here. A click below sets `value` directly
  // rather than waiting for the navigation to resolve and echo back, so the page
  // reacts the instant it is pressed.
  useEffect(() => {
    if (!router) return;
    return router.subscribe("onResolved", () => setLocal(readParam(router, name)));
  }, [router, name]);

  const set = useCallback(
    (next: string | null, opts?: { replace?: boolean }) => {
      setLocal(next);
      if (!router) return;
      const search = { ...router.state.location.search };
      if (next === null) delete search[name];
      else search[name] = forSearch(next);
      void router.navigate({ to: router.state.location.pathname, search, replace: opts?.replace ?? false });
    },
    [router, name],
  );

  return [value, set];
}

/**
 * Rewrites one param of the address in place — only when the address already
 * carries it — as a replace, so Back does not step through the old value. Every
 * other param and the hash stay as they are.
 *
 * Through the router when there is one: a write behind its back would leave
 * `router.state.location.search` holding the old value, and the next
 * `navigate` that copies it (see `useSearchParam`'s setter) would put the old
 * value straight back. With no router above, the address is rewritten directly.
 */
export function useRewriteSearchParam(): (name: string, value: string) => void {
  const router = useRouterHandle();
  return useCallback(
    (name, value) => {
      if (router) {
        if (!(name in router.state.location.search)) return;
        const search = { ...router.state.location.search, [name]: forSearch(value) };
        void router.navigate({ to: router.state.location.pathname, search, replace: true, hash: true });
        return;
      }
      const url = new URL(window.location.href);
      if (!url.searchParams.has(name)) return;
      url.searchParams.set(name, value);
      window.history.replaceState(window.history.state, "", url);
    },
    [router],
  );
}

/** Go to another path, keeping the router's own state (no reload). With no
 *  router above, a plain navigation. `keepSearch` carries the current address's
 *  other params along (a page changing layout keeps `?plan=` and `?text=`);
 *  `search` is then laid over them. */
export function useNavigateTo(): (to: string, search?: Record<string, string>, opts?: { keepSearch?: boolean }) => void {
  const router = useRouterHandle();
  return useCallback(
    (to, search = {}, opts) => {
      if (router) {
        const typed: Record<string, unknown> = opts?.keepSearch ? { ...router.state.location.search } : {};
        for (const [k, v] of Object.entries(search)) typed[k] = forSearch(v);
        void router.navigate({ to, search: typed });
        return;
      }
      const q = opts?.keepSearch ? new URLSearchParams(window.location.search) : new URLSearchParams();
      for (const [k, v] of Object.entries(search)) q.set(k, v);
      const qs = q.toString();
      window.location.assign(qs ? `${to}?${qs}` : to);
    },
    [router],
  );
}
