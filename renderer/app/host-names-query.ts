// host-names-query.ts — the names this server answers to, live.
//
// Read once and then refreshed whenever the server says the list changed: a new
// name reaching the server, a decision on the Host names card, refusal turned on
// or off. The rail's count and the card read the same query, so they cannot
// disagree.

import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { HOST_NAMES_CHANNEL } from "@main/services/host-name-rules";
import type { HostNamesView } from "@main/services/host-names";

import { invoke as ipc, onNotification } from "../lib/api";

const KEY = ["security:host-names"] as const;

export function useHostNames() {
  const queryClient = useQueryClient();
  useEffect(
    () => onNotification(HOST_NAMES_CHANNEL, () => void queryClient.invalidateQueries({ queryKey: KEY })),
    [queryClient],
  );
  return useQuery({ queryKey: KEY, queryFn: async () => complete(await ipc<Partial<HostNamesView>>("security:hostNames")) });
}

/** An answer missing a list reads as that list empty, so a server that answers
 *  something else never takes the rail down with it. */
function complete(view: Partial<HostNamesView> | null | undefined): HostNamesView {
  const list = <T,>(v: T[] | undefined): T[] => (Array.isArray(v) ? v : []);
  return {
    enforce: view?.enforce === true,
    seeded: view?.seeded === true,
    automatic: list(view?.automatic),
    accepted: list(view?.accepted),
    waiting: list(view?.waiting),
    dismissed: list(view?.dismissed),
  };
}

/** How many names reached the server and wait for an accept or a dismiss. */
export function useHostNamesWaiting(): number {
  return useHostNames().data?.waiting.length ?? 0;
}

/** One change on the card; answers the new view, which replaces the cached one. */
export function useHostNamesChange() {
  const queryClient = useQueryClient();
  return async (change: Record<string, unknown>): Promise<HostNamesView> => {
    const next = complete(await ipc<Partial<HostNamesView>>("security:setHostNames", change));
    queryClient.setQueryData(KEY, next);
    return next;
  };
}
