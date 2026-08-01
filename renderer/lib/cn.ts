import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// Register our custom Apple-HIG font-size utilities (defined in styles.css) as the
// `font-size` group so tailwind-merge treats them as sizes, not colors. Without
// this, cn("text-footnote", "text-fg") could drop one — both look like `text-*`.
const FONT_SIZE_CLASSES = [
  "large-title", "title1", "title2", "title3", "headline", "body",
  "callout", "subheadline", "footnote", "caption1", "caption2",
];

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": FONT_SIZE_CLASSES.map((c) => `text-${c}`),
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
