// The Sound card as the History page mounts it: SplDetail with the page's plot
// preferences from `usePlotPrefs`.
//
// SplDetail takes the preferences as a prop because the page is their ONE
// subscriber (the card, its title, the header and the rows plot from that one
// value). Mounted bare, a test's card would plot from a frozen value and never
// see its own Plot radio take effect.
//
// Import this only from a test, and only after installDom().

import type { ComponentProps } from "react";
import { SplDetail } from "../settings/sections/spl-history-section";
import { usePlotPrefs } from "../settings/sections/sound-plot";

export function SplDetailOnPage({
  trendsMetric = null,
  ...props
}: Omit<ComponentProps<typeof SplDetail>, "plot"> & {
  /** The Trends metric as the page would have resolved it. */
  trendsMetric?: string | null;
}) {
  const plot = usePlotPrefs(trendsMetric);
  return <SplDetail {...props} plot={plot} />;
}
