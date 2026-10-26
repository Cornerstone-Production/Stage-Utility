// The view kinds an operator can make, in the order they are offered, and their names.
//
// ONE list for every place that offers a kind: the New view dialog, the type picker
// on a view's settings, and the New screen panel. A second copy is how a kind goes
// missing from one of them with nothing failing.

import type { ViewKind } from "@main/types/stage";
import { everyViewKind } from "@main/types/views";
import { externKeyed } from "@main/types/extern-keyed";

export const KIND_LABELS: Record<ViewKind, string> = externKeyed({
  slots: "Mic Slots",
  dashboard: "Dashboard",
  stage: "Stage",
  transcription: "Transcription",
  custom: "Custom Layout",
  script: "ServiceCue",
  "spl-rundown": "SPL Rundown",
  calendar: "Calendar",
});
// everyViewKind fails to compile when a kind is missing from the list.
export const KIND_ORDER = everyViewKind([
  "slots",
  "dashboard",
  "stage",
  "transcription",
  "script",
  "spl-rundown",
  "calendar",
  "custom",
]);
