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
import { logReadFailure } from "../lib/client-log";

const KEY = ["security:host-names"] as const;

/** Whether the last read failed, so a run of failures (the query retries) is one
 *  line on /log, and a recovery followed by a new failure is another. */
let failing = false;

/** Tests only. */
export function __resetHostNamesForTests(): void {
  failing = false;
}

async function read(): Promise<HostNamesView> {
  try {
    const view = complete(await ipc<Partial<HostNamesView>>("security:hostNames"));
    failing = false;
    return view;
  } catch (err) {
    // The rail's count has nowhere to show an error, and a read that failed is not
    // "nothing waiting": the query keeps the last good list and the card shows the
    // error, and this is what an operator finds on /log.
    if (!failing) logReadFailure("security", "the host names", err);
    failing = true;
    throw err;
  }
}

export function useHostNames() {
  const queryClient = useQueryClient();
  useEffect(
    () => onNotification(HOST_NAMES_CHANNEL, () => void queryClient.invalidateQueries({ queryKey: KEY })),
    [queryClient],
  );
  return useQuery({ queryKey: KEY, queryFn: read });
}

/** The answer, checked. One that is not a host names view is a failed read: an
 *  answer missing its lists must not read as every list empty, which would take
 *  the rail's count away while names wait. */
function complete(view: Partial<HostNamesView> | null | undefined): HostNamesView {
  if (!view || typeof view !== "object") throw new Error("the server's answer was not a host names view");
  const list = <T,>(name: string, v: T[] | undefined): T[] => {
    if (!Array.isArray(v)) throw new Error(`the server's host names answer has no ${name} list`);
    return v;
  };
  return {
    enforce: view.enforce === true,
    seeded: view.seeded === true,
    automatic: list("automatic", view.automatic),
    accepted: list("accepted", view.accepted),
    waiting: list("waiting", view.waiting),
    dismissed: list("dismissed", view.dismissed),
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
