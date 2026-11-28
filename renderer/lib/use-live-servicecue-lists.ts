// use-live-servicecue-lists.ts — the ServiceCue layouts and category roles, kept current for
// a screen or a rundown page that draws from them.
//
// Read at mount and again whenever they are saved. In the building the server says so on
// `servicecue:lists`; on the public page the Worker says so on `publish:docs` (the same two
// docs it serves them as), and the page keeps no timer of its own: every read there is a
// request against the Worker's daily allowance.
//
// In the building the one thing on a timer is the RETRY, and only of a list whose last read
// failed. A read that failed at boot must not leave the page on its empty lists for good, and
// an empty list resolves to ALL columns: a screen set to one department silently showing
// every other department's notes.
//
// A frame that is a REPLAY is not the news: a page mounting into an open stream is handed the
// last one, and has just read for itself. Reads are last-wins: a save can follow another
// before the first read answers, and an older answer landing late must not replace a newer one.

import { useEffect, useState } from "react";

import type { ServiceCueLayout } from "@main/types/stage";
import type { CategoryRole } from "@main/types/servicecue-roles";
import { SERVICECUE_LISTS_CHANNEL } from "@main/types/servicecue-lists";
import { invoke, onNotification } from "./api";
import { refreshWhileMounted } from "./live-refresh";
import { isPublicMode } from "./public-mode";

/** How long after a failed read the page tries again. */
export const LISTS_RETRY_MS = 60_000;

/** The `useFailedReads` of the page, narrowed to the two reads this hook makes. */
export interface ListsFailures {
  fail: (which: "layouts" | "roles", what: string, err: unknown) => void;
  clear: (...which: ("layouts" | "roles")[]) => void;
}

export function useLiveServiceCueLists(
  enabled: boolean,
  { fail, clear }: ListsFailures,
  what: { layouts: string; roles: string },
): { layouts: ServiceCueLayout[] | null; roles: CategoryRole[] | null } {
  const [layouts, setLayouts] = useState<ServiceCueLayout[] | null>(null);
  const [roles, setRoles] = useState<CategoryRole[] | null>(null);
  const { layouts: layoutsWhat, roles: rolesWhat } = what;
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    // Per list: the last read failed, and which read is the latest started.
    const failedNow = { layouts: false, roles: false };
    const latest = { layouts: 0, roles: 0 };
    const read = <T,>(
      key: "layouts" | "roles",
      channel: "servicecue:listLayouts" | "servicecue:listRoles",
      label: string,
      apply: (list: T) => void,
    ) => {
      const mine = ++latest[key];
      invoke<T>(channel)
        .then((list) => {
          if (cancelled || mine !== latest[key]) return;
          failedNow[key] = false;
          apply(list);
          clear(key);
        })
        .catch((err: unknown) => {
          if (cancelled || mine !== latest[key]) return;
          failedNow[key] = true;
          fail(key, label, err);
        });
    };
    const loadLayouts = () => read<ServiceCueLayout[]>("layouts", "servicecue:listLayouts", layoutsWhat, setLayouts);
    const loadRoles = () => read<CategoryRole[]>("roles", "servicecue:listRoles", rolesWhat, setRoles);
    const load = () => {
      loadLayouts();
      loadRoles();
    };
    load();
    // Public: the Worker's doc notices. In the building: the server's frame, and the retry.
    const stopDocs = refreshWhileMounted(load, ["servicecue-layouts", "servicecue-roles"], null);
    const building = !isPublicMode();
    const stopFrames = building
      ? onNotification(SERVICECUE_LISTS_CHANNEL, (_payload, replayed) => {
          if (!replayed) load();
        })
      : () => {};
    const retry = building
      ? setInterval(() => {
          if (failedNow.layouts) loadLayouts();
          if (failedNow.roles) loadRoles();
        }, LISTS_RETRY_MS)
      : null;
    return () => {
      cancelled = true;
      stopDocs();
      stopFrames();
      if (retry) clearInterval(retry);
    };
  }, [enabled, fail, clear, layoutsWhat, rolesWhat]);
  return { layouts, roles };
}
