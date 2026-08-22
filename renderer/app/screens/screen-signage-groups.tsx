// Which signage groups a screen belongs to, on that screen's own card.
//
// Read-only on purpose. Membership is edited in Signage, where the groups, the
// playlists and the schedule are all visible together; a checkbox here would let
// someone change what a wall plays without seeing what else is in that group or
// which schedule currently wins.
//
// Renders nothing for a screen that is not in any group, which is every screen
// that is not doing signage.

import { useQuery } from "@tanstack/react-query";
import type { SignageGroup } from "@main/types/signage";

import { invoke } from "../../lib/api";
import { AppLink } from "../app-link";

export function ScreenSignageGroups({ outputId }: { outputId: string }) {
  // Its own query rather than the Signage tab's config bundle: this renders on
  // Screens, where the other three signage stores are not wanted.
  const { data } = useQuery({
    queryKey: ["signage:groups"],
    queryFn: () => invoke<{ groups: SignageGroup[] }>("signage:listGroups"),
  });

  const groups = (data?.groups ?? []).filter((g) => g.outputIds.includes(outputId));
  if (groups.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5 border-t border-line px-3 py-2">
      <span className="text-caption2 text-fg-subtle">Signage</span>
      {groups.map((g) => (
        <span key={g.id} className="rounded border border-line px-1.5 py-0.5 text-caption2 text-fg-muted">
          {g.name}
        </span>
      ))}
      <AppLink to="/signage" className="ml-auto text-caption2 text-accent hover:underline">
        Edit in Signage
      </AppLink>
    </div>
  );
}
