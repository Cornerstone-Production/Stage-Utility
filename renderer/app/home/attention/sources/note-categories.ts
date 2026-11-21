// Note categories that no column can show.
//
// The layouts page's notice says it at the top of /servicecue/presets; nothing on Home
// did, though the category shows under All columns and is missing from every
// department's layout. Counted with the functions the Category roles section's
// "Categories in no role" list uses (servicecue-layouts-model): over the landing page's
// service types, each name once. The page's notice lists a name once per type instead,
// so a name in two types is counted once here and listed twice there. Not shown on a first run
// with no roles, where the page says nothing either.

import { ROLES_FLASH_ID } from "../../../flash";
import { listOf, unassignedByType, unassignedDistinct } from "../../../../settings/sections/servicecue-layouts-model";
import { attentionKey, type AttentionInput, type AttentionItem, type AttentionSource } from "../types";

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
        // The set is the subject (sorted, so reordering the landing types is not a new problem), and a category added later is.
        key: attentionKey("note-categories", [...names].sort((a, b) => a.localeCompare(b)).join("+")),
        severity: "warn",
        title: `${names.length} note ${one ? "category is" : "categories are"} in no column`,
        detail: `${listOf(names)} ${one ? "shows" : "show"} only under All columns.`,
        fix: { label: "Open roles", route: "/servicecue/presets", flash: ROLES_FLASH_ID },
      },
    ];
  },
};
