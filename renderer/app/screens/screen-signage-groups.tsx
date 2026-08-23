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

import { TagPicker } from "../signage/tag-picker";
import { useSignageTags } from "../signage/use-signage-tags";
import { AppLink } from "../app-link";

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
  // The shared hook: one key, one set of writes, shared with the Now board.
  // Both pages showed the same tags under two different cache keys, so a rename
  // on one left the other stale.
  const { tags, tagsOf, setTags, createTag } = useSignageTags({ enabled: isSignage });
  const mine = tagsOf(outputId);

  if (!isSignage) return null;

  const picker = (
    <TagPicker
      groups={tags}
      selected={mine}
      onChange={(next) => void setTags(outputId, next)}
      onCreate={(name) => createTag(outputId, name)}
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
