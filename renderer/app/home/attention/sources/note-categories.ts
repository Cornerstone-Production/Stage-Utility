// Note categories that no column can show.
//
// The layouts page's notice says it at the top of /servicecue/presets; nothing on Home
// did, though the category shows under All columns and is missing from every
// department's layout. Counted by the notice's own functions (servicecue-layouts-model)
// over the landing page's service types, so the page and Home cannot disagree, and
// not on a first run with no roles, where the page says nothing either.

import { listOf, unassignedByType, unassignedDistinct } from "../../../../settings/sections/servicecue-layouts-model";
import { attentionKey, type AttentionInput, type AttentionItem, type AttentionSource } from "../types";

/** The `data-flash-id` of the Category roles section on /servicecue/presets. */
export const ROLES_FLASH_ID = "servicecue-roles";

export const noteCategories: AttentionSource = {
  id: "note-categories",
  items(input: AttentionInput): AttentionItem[] {
    const { known, roles, landingTypeIds, catsByType } = input.noteCategories;
    if (!known || roles.length === 0) return [];
    const names = unassignedDistinct(unassignedByType(roles, landingTypeIds, catsByType)).map((c) => c.name);
    if (names.length === 0) return [];
    const one = names.length === 1;
    return [
      {
        // The set is the subject, so a category added later is a new problem, not the snoozed one.
        key: attentionKey("note-categories", names.join("+")),
        severity: "warn",
        title: `${names.length} note ${one ? "category is" : "categories are"} in no column`,
        detail: `${listOf(names)} ${one ? "shows" : "show"} only under All columns.`,
        fix: { label: "Open roles", route: "/servicecue/presets", flash: ROLES_FLASH_ID },
      },
    ];
  },
};
