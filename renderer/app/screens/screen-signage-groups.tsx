// Which signage tags a screen carries, on that screen's own card.
//
// EDITABLE here, which it was not before. The reasoning for read-only was that
// membership should be changed where the playlists and the schedule are visible
// together — but that argument was for a Groups page that no longer exists, and
// it had the effect of making "put that TV in the foyer set" a trip to another
// tab to find a list of screens and tick one.
//
// Tagging a screen cannot silently change what a wall plays in a way the
// operator cannot see, because the Now board shows every tag and what it is
// playing; the link to it is right here.
//
// Renders a control only for a screen that is actually doing signage — a slots
// display carrying a signage tag would make a card on the Now board that can
// never play anything.

import { useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { SignageGroup } from "@main/types/signage";

import { newSignageId } from "../signage/ids";
import { TagPicker } from "../signage/tag-picker";
import { invoke } from "../../lib/api";
import { AppLink } from "../app-link";

export const SIGNAGE_GROUPS_KEY = ["signage:groups"] as const;

export function ScreenSignageGroups({
  outputId,
  /** False for a screen that is not routed to a signage View. */
  isSignage,
  compact = false,
}: {
  outputId: string;
  isSignage: boolean;
  /** Inline, for the compact signage row. The bordered strip belongs to a full
   *  card, and signage screens do not get one — see SignageScreenRow. */
  compact?: boolean;
}) {
  const client = useQueryClient();
  // Its own query rather than the Signage tab's config bundle: this renders on
  // Screens, where the other three signage stores are not wanted.
  const { data } = useQuery({
    queryKey: SIGNAGE_GROUPS_KEY,
    queryFn: () => invoke<{ groups: SignageGroup[] }>("signage:listGroups"),
    enabled: isSignage,
  });

  // Memoised so setTags below does not get a new identity on every render.
  const groups = useMemo(() => data?.groups ?? [], [data]);
  const mine = groups.filter((g) => g.outputIds.includes(outputId)).map((g) => g.id);

  const setTags = useCallback(
    async (next: string[]) => {
      const want = new Set(next);
      // Only the groups whose membership actually changed are written. Saving
      // every group on every edit would rewrite the whole store — and each write
      // recomputes the horizon for every screen in the building.
      const changed = groups.filter((g) => g.outputIds.includes(outputId) !== want.has(g.id));
      for (const g of changed) {
        const outputIds = want.has(g.id)
          ? [...g.outputIds, outputId]
          : g.outputIds.filter((id) => id !== outputId);
        await invoke("signage:saveGroup", { group: { ...g, outputIds } });
      }
      await client.invalidateQueries({ queryKey: SIGNAGE_GROUPS_KEY });
    },
    [groups, outputId, client],
  );

  /**
   * Make a tag from inside the picker, with THIS screen already in it.
   *
   * Created empty at first, on the reasoning that the picker's own onChange
   * would add the screen a moment later. It does call it — but setTags can only
   * write groups it already has, and the brand-new one is not in that list yet,
   * so the tag appeared with no screens in it and the operator had to tick the
   * thing they had just made. Making it in one write is both correct and fewer
   * round trips.
   *
   * The onChange that follows is then a no-op for this id, which is harmless:
   * it names a group setTags does not know about and is skipped.
   */
  const createTag = useCallback(
    async (name: string): Promise<string | null> => {
      const group = {
        id: newSignageId("gr"),
        name,
        outputIds: [outputId],
        createdAt: new Date().toISOString(),
      };
      await invoke("signage:saveGroup", { group });
      await client.invalidateQueries({ queryKey: SIGNAGE_GROUPS_KEY });
      return group.id;
    },
    [client, outputId],
  );

  if (!isSignage) return null;

  const picker = (
    <TagPicker
      groups={groups}
      selected={mine}
      onChange={(next) => void setTags(next)}
      onCreate={createTag}
      placeholder="No tags"
      className={compact ? "min-w-24" : "min-w-32"}
    />
  );

  // Just the picker. The row it sits in already carries the screen's name and
  // the link to Signage, and repeating either would make a compact row wide.
  if (compact) return picker;

  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-line px-3 py-2">
      <span className="text-caption2 text-fg-subtle">Signage tags</span>
      {picker}
      <AppLink to="/signage" className="ml-auto text-caption2 text-accent hover:underline">
        Open Signage
      </AppLink>
    </div>
  );
}
