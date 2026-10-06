// The ServiceCue rundown on a display: ServiceCue, drawn at the size the server
// keeps for this display (see use-display-text-size.ts). A layout object embedding
// ServiceCue does not come through here, so it has no text size and ignores a
// `?text=` on the display's address.

import { ServiceCue } from "./servicecue-view";
import { useDisplayTextSize } from "./use-display-text-size";

export function DisplayServiceCue({
  displayId,
  serviceCueLayoutId,
  serverTextSize,
  isPreview,
}: {
  displayId: string;
  serviceCueLayoutId: string | null;
  /** The screen's `textSize`: the size the server keeps for the screen this one is or
   *  stands in for, null when none is kept. */
  serverTextSize: number | null;
  isPreview: boolean;
}) {
  const textSize = useDisplayTextSize(displayId, serverTextSize, isPreview);
  return <ServiceCue serviceCueLayoutId={serviceCueLayoutId} textSize={textSize} />;
}
