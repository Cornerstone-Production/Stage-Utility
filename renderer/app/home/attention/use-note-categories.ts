// The note-categories source's reads: ServiceCue's roles, the landing page's service types,
// and each of those types' note categories.
//
// Read once when Home mounts and again when the live plan changes (the stage state's
// planId, which the page already holds open), never on a timer: roles and landing types
// change when an operator edits them, which means leaving Home and coming back, and
// Planning Center's categories change about as often as its plans do. Nothing is read
// without Planning Center, and the categories are read only for a landing type that is
// ticked. A read that fails leaves the source unknown, says so in /log, and is tried
// again on the next plan change or visit; it never reads as "no uncovered categories".

import { useEffect, useState } from "react";

import type { CategoryRole } from "@main/types/servicecue-roles";
import type { ServiceCueConfig } from "@main/types/pco";
import { invoke } from "../../../lib/api";
import { useFailedReads } from "../../../lib/use-failed-reads";
import type { NoteCategoryInput } from "./types";

const UNKNOWN: NoteCategoryInput = { known: false, roles: [], landingTypeIds: [], catsByType: new Map() };

export function useNoteCategories(args: { pcoConfigured: boolean; planId: string | null | undefined }): NoteCategoryInput {
  const { pcoConfigured, planId } = args;
  const [answer, setAnswer] = useState<NoteCategoryInput>(UNKNOWN);
  const { fail, clear } = useFailedReads<"note-categories">("home");

  useEffect(() => {
    if (!pcoConfigured) return;
    // A later run (a plan change, Planning Center connecting) supersedes this one: its answer is dropped.
    let cancelled = false;
    void (async () => {
      try {
        const config = await invoke<ServiceCueConfig>("servicecue:getConfig");
        const landingTypeIds = config.serviceTypeIds ?? [];
        // Nothing ticked: nothing to ask Planning Center about.
        if (landingTypeIds.length === 0) {
          if (!cancelled) setAnswer({ known: true, roles: [], landingTypeIds, catsByType: new Map() });
          clear("note-categories");
          return;
        }
        const [roles, cats] = await Promise.all([
          invoke<CategoryRole[]>("servicecue:listRoles"),
          Promise.all(landingTypeIds.map(async (id) => [id, await invoke<string[]>("servicecue:noteCategories", { serviceTypeId: id })] as const)),
        ]);
        if (cancelled) return;
        setAnswer({ known: true, roles, landingTypeIds, catsByType: new Map(cats) });
        clear("note-categories");
      } catch (err) {
        if (cancelled) return;
        fail("note-categories", "the ServiceCue note categories for Needs attention", err);
        setAnswer(UNKNOWN);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pcoConfigured, planId, fail, clear]);

  // Without Planning Center, whatever was read before is not an answer any more.
  return pcoConfigured ? answer : UNKNOWN;
}
