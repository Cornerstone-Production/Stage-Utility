// use-live-servicecue-lists.ts — the ServiceCue layouts and category roles, kept current for
// a screen or a rundown page that draws from them.
//
// Read at mount and again whenever they are saved. In the building the server says so on
// `servicecue:lists`; on the public page the Worker says so on `publish:docs` (the same two
// docs it serves them as). A page used to read them on its rundown's one-minute timer, so
// a layout edited on /servicecue/presets reached an open screen up to a minute later.
//
// The one thing left on a timer is the RETRY. A read that failed at boot must not leave the
// page on its empty lists for good, and an empty list resolves to ALL columns: a screen
// set to one department silently showing every other department's notes. The retry runs
// only while the last read failed, so a healthy page reads exactly when something changed.
//
// A frame that is a REPLAY is not the news. A page mounting into an open stream is handed
// the last one, and has just read for itself.

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
    // Per read: the last one failed. A failure keeps the last good list.
    let layoutsFailed = false;
    let rolesFailed = false;
    const load = () => {
      invoke<ServiceCueLayout[]>("servicecue:listLayouts")
        .then((l) => {
          if (cancelled) return;
          layoutsFailed = false;
          setLayouts(l);
          clear("layouts");
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          layoutsFailed = true;
          fail("layouts", layoutsWhat, err);
        });
      invoke<CategoryRole[]>("servicecue:listRoles")
        .then((r) => {
          if (cancelled) return;
          rolesFailed = false;
          setRoles(r);
          clear("roles");
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          rolesFailed = true;
          fail("roles", rolesWhat, err);
        });
    };
    load();
    // Public: the Worker's doc notices, and nothing on a timer but their own net.
    const stopDocs = refreshWhileMounted(load, ["servicecue-layouts", "servicecue-roles"], null);
    // In the building: the server's frame.
    const stopFrames = isPublicMode()
      ? () => {}
      : onNotification(SERVICECUE_LISTS_CHANNEL, (_payload, replayed) => {
          if (!replayed) load();
        });
    const retry = setInterval(() => {
      if (layoutsFailed || rolesFailed) load();
    }, LISTS_RETRY_MS);
    return () => {
      cancelled = true;
      stopDocs();
      stopFrames();
      clearInterval(retry);
    };
  }, [enabled, fail, clear, layoutsWhat, rolesWhat]);
  return { layouts, roles };
}
