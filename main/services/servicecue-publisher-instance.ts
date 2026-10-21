// servicecue-publisher-instance.ts — the publisher wired to the app.
//
// The class (servicecue-publisher.ts) takes everything it reads as a seam so a test can drive it with a
// fixture and without Planning Center. This is the one place those seams are the real thing: the SAME
// functions the in-building routes call, so a published document has exactly the shape the ServiceCue
// pages already read.

import { appTimeZone } from "./app-timezone.js";
import { BRANDING_IMAGE_DIR } from "./branding-image-store.js";
import { readImage } from "./image-files.js";
import { pcoService } from "./pco-service.js";
import { readPublishToken, servicecuePublishStore } from "./servicecue-publish-store.js";
import { ServiceCuePublisher, type PublishSource } from "./servicecue-publisher.js";
import { serviceWindow } from "./service-window.js";
import { splRecorder } from "./spl-recorder.js";
import { stageController } from "./stage-controller.js";
import { pkgVersion } from "./updater.js";

/** What the publisher reads, by the app's own accessors. Checked against the seam by `satisfies`. */
export const appSource = {
  config: () => stageController.getServiceCueConfig(),
  layouts: () => stageController.listServiceCueLayouts(),
  roles: () => stageController.listServiceCueRoles(),
  state: () => stageController.getState(),
  timeZone: () => appTimeZone(),
  live: () => stageController.getLastLive(),
  spl: () => splRecorder.getCurrent(),
  serviceTypes: () => stageController.listServiceTypes(),
  upcoming: (days) => stageController.getUpcomingPlanList(days),
  rundown: (typeId, planId) => stageController.getServiceCueRundown(typeId, planId),
  pcoTight: () => pcoService.rateLimitTight(),
  dormant: () => serviceWindow.isDormant(),
  brandingImage: (name) => readImage(BRANDING_IMAGE_DIR, name),
} satisfies PublishSource;

export const servicecuePublisher = new ServiceCuePublisher({
  source: appSource,
  loadSettings: async () => ({ ...(await servicecuePublishStore.load()) }),
  loadToken: readPublishToken,
  version: pkgVersion,
});
