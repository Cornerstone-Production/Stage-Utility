// use-layout-saves.ts — the ServiceCue layouts editor's saves, one at a time. How and why
// is use-list-saves.ts; this is that for the layouts list.

import { useListSaves, type ListEdit, type ListIo, type ListSaveResult } from "../../lib/use-list-saves";
import { invoke } from "../../lib/api";
import type { ServiceCueLayout } from "../../../main/types/pco.js";

/** One change to the list, applied to whatever the list is when its turn to save comes. */
export type LayoutEdit = ListEdit<ServiceCueLayout>;

export type LayoutSaveResult = ListSaveResult;

const LAYOUTS: ListIo<ServiceCueLayout> = {
  save: (layouts) => invoke<ServiceCueLayout[]>("servicecue:saveLayouts", { layouts }),
  read: () => invoke<ServiceCueLayout[]>("servicecue:listLayouts"),
};

export function useLayoutSaves(): {
  /** What the page shows: the server's last answer with the waiting edits applied. */
  layouts: ServiceCueLayout[];
  /** Take a list the server answered a read with. */
  adopt: (list: ServiceCueLayout[]) => void;
  /** Queue an edit; resolves once it has been saved or refused. */
  edit: (e: LayoutEdit) => Promise<LayoutSaveResult>;
} {
  const { list, adopt, edit } = useListSaves(LAYOUTS);
  return { layouts: list, adopt, edit };
}
