// The operator's kept colours, as the picker sees them.
//
// They live on the server, in the shared stage state — the same place the
// context bar's arrangement lives, and for the same reason: somebody mixes a
// colour on a laptop and reaches for it on the tablet by the desk, and a
// per-browser palette would read as having lost them.
//
// That also means every open screen updates when one is saved, and that they
// ride along in the config backup, because the store declares itself as the
// operator's work.

import { useQueryClient } from "@tanstack/react-query";

import { invoke } from "../../lib/api";
import { writeOptimistic } from "../../lib/optimistic";
import { useStageState } from "../../main/use-stage-state";
import { toast } from "./toast";

export interface SavedColors {
  colors: string[];
  has: (color: string) => boolean;
  toggle: (color: string) => Promise<void>;
}

export function useSavedColors(): SavedColors {
  const { state } = useStageState();
  const queryClient = useQueryClient();
  const colors: string[] = state?.savedColors ?? [];

  return {
    colors,
    has: (color) => colors.includes(color),
    async toggle(color) {
      const keep = !colors.includes(color);
      // Shown immediately: the panel is a direct-manipulation surface, and a
      // swatch that appeared a beat after the click reads as a click that missed.
      // Rolled back by writeOptimistic if the server refuses — leaving a swatch
      // on screen the server does not have means the next reload silently loses
      // it.
      const next = await writeOptimistic<StageState>(
        queryClient,
        ["stage:getState"],
        (cur) => ({
          ...cur,
          savedColors: keep
            ? [color, ...colors.filter((c: string) => c !== color)]
            : colors.filter((c: string) => c !== color),
        }),
        () => invoke<StageState>("savedColors:set", { color, keep }),
      );
      // The list has a ceiling, and reaching it costs the oldest colour. Say so:
      // a swatch that disappeared without a word reads as a bug, and quietly
      // discarding something the operator saved is not ours to do.
      if (!next) return;
      const gone = colors.find((c: string) => c !== color && !next.savedColors.includes(c));
      if (keep && gone) toast.info(`Saved colours are full — ${gone} was dropped`);
    },
  };
}
