// use-signage-tags.ts — tags, and putting a screen in them.
//
// ONE query key and ONE set of writes, shared by the Now board and the Screens
// page. Both showed the same tags and both wrote them, from two copies of the
// same code under two different cache keys — so renaming a tag on one page left
// the other showing the old name until it happened to remount, and "which key do
// I invalidate" had two answers.
//
// Every write reports its failure. The previous versions awaited `invoke` with
// no catch behind `onChange={(next) => void setTags(next)}`, so a rejected save
// was an unhandled promise rejection: no toast, and the picker silently snapping
// back on the next query result with nothing said.

import { useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import type { SignageGroup } from "@main/types/signage";

import { errorMessage } from "@main/services/errors";
import { invoke } from "../../lib/api";
import { toast } from "../../components/ui/toast";
import { newSignageId } from "./ids";

/** THE key for the tag list. Anything that writes a tag invalidates this. */
export const SIGNAGE_TAGS_KEY = ["signage:groups"] as const;

export function useSignageTags(options: { enabled?: boolean } = {}): {
  tags: SignageGroup[];
  /** The tag ids this screen is in. */
  tagsOf: (outputId: string) => string[];
  setTags: (outputId: string, next: string[]) => Promise<void>;
  createTag: (outputId: string, name: string) => Promise<string | null>;
  renameTag: (id: string, name: string) => Promise<void>;
  deleteTag: (id: string) => Promise<void>;
} {
  const client = useQueryClient();
  const { data } = useQuery({
    queryKey: SIGNAGE_TAGS_KEY,
    queryFn: () => invoke<{ groups: SignageGroup[] }>("signage:listGroups"),
    enabled: options.enabled ?? true,
  });

  // Memoised so the callbacks below do not get a new identity every render.
  const tags = useMemo(() => data?.groups ?? [], [data]);
  /**
   * Re-read everything that shows a tag.
   *
   * Both caches, deliberately. The Signage tab reads tags as part of a larger
   * config bundle and the Screens page reads them alone — two keys, because the
   * two pages want different amounts of config. That is fine as long as a write
   * refreshes both, which is precisely what was missing: tagging a screen on
   * Screens left the Signage tab stale, and renaming a tag on the Now board left
   * Screens showing the old name.
   */
  const refresh = useCallback(
    () =>
      Promise.all([
        client.invalidateQueries({ queryKey: SIGNAGE_TAGS_KEY }),
        client.invalidateQueries({ queryKey: ["signage:config"] }),
      ]).then(() => undefined),
    [client],
  );

  const tagsOf = useCallback(
    (outputId: string) =>
      tags.filter((g) => Array.isArray(g.outputIds) && g.outputIds.includes(outputId)).map((g) => g.id),
    [tags],
  );

  const setTags = useCallback(
    async (outputId: string, next: string[]) => {
      const want = new Set(next);
      // Only the tags whose membership actually changed are written. Saving
      // every tag on every edit would rewrite the whole store — and each write
      // recomputes the horizon for every screen in the building.
      const changed = tags.filter(
        (g) => (Array.isArray(g.outputIds) && g.outputIds.includes(outputId)) !== want.has(g.id),
      );
      try {
        for (const g of changed) {
          const outputIds = want.has(g.id)
            ? [...g.outputIds, outputId]
            : g.outputIds.filter((id) => id !== outputId);
          await invoke("signage:saveGroup", { group: { ...g, outputIds } });
        }
      } catch (err) {
        toast.error(errorMessage(err));
      } finally {
        // Whatever happened, re-read: a partial write leaves the picker showing
        // an arrangement that is half true, and silently keeping it is worse
        // than snapping back to what the server actually holds.
        await refresh();
      }
    },
    [tags, refresh],
  );

  /**
   * Make a tag with THIS screen already in it.
   *
   * In ONE write. Created empty first, on the reasoning that the picker's own
   * onChange would add the screen a moment later — it does call it, but setTags
   * can only write tags it already has, and the brand-new one is not in that
   * list yet, so the tag appeared with no screens in it and the operator had to
   * tick the thing they had just made.
   */
  const createTag = useCallback(
    async (outputId: string, name: string): Promise<string | null> => {
      const group = {
        id: newSignageId("gr"),
        name,
        outputIds: [outputId],
        createdAt: new Date().toISOString(),
      };
      try {
        await invoke("signage:saveGroup", { group });
      } catch (err) {
        toast.error(errorMessage(err));
        return null;
      } finally {
        await refresh();
      }
      return group.id;
    },
    [refresh],
  );

  const renameTag = useCallback(
    async (id: string, name: string) => {
      const g = tags.find((x) => x.id === id);
      if (!g) return;
      try {
        await invoke("signage:saveGroup", { group: { ...g, name } });
      } catch (err) {
        toast.error(errorMessage(err));
      } finally {
        await refresh();
      }
    },
    [tags, refresh],
  );

  const deleteTag = useCallback(
    async (id: string) => {
      try {
        await invoke("signage:deleteGroup", { id });
      } catch (err) {
        toast.error(errorMessage(err));
      } finally {
        await refresh();
      }
    },
    [refresh],
  );

  return { tags, tagsOf, setTags, createTag, renameTag, deleteTag };
}
