// servicecue-publisher-instance.ts — the publisher wired to the app.
//
// The class (servicecue-publisher.ts) takes everything it reads as a seam so a test can drive it with a
// fixture and without Planning Center. This is the one place those seams are the real thing: the SAME
// functions the in-building routes call, so a published document has exactly the shape the ServiceCue
// pages already read.

import * as path from "node:path";

import { APP_ROOT } from "./app-root.js";
import { appTimeZone } from "./app-timezone.js";
import { BRANDING_IMAGE_DIR } from "./branding-image-store.js";
import { readImage } from "./image-files.js";
import { pcoService } from "./pco-service.js";
import { cloudflareOrigin, type CloudflareOrigin } from "./servicecue-cloudflare.js";
import { ServiceCueDeployer } from "./servicecue-deployer.js";
import { readDeployCredentials } from "./servicecue-deploy-store.js";
import { localAllowed, parsePublishUrl } from "./servicecue-publish-rules.js";
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

/**
 * Cloudflare's API. A developer's fake of it on this machine is dialled only when publishing to this machine
 * is already allowed (STAGE_UTILITY_PUBLISH_ALLOW_LOCAL=1) and the address is named, so a production server
 * cannot be pointed anywhere else.
 */
export const CLOUDFLARE_API_ENV = "STAGE_UTILITY_CLOUDFLARE_API";
export function deployApiOrigin(env: Record<string, string | undefined> = process.env, allowLocal: boolean = localAllowed()): CloudflareOrigin {
  const named = env[CLOUDFLARE_API_ENV];
  return allowLocal && named ? cloudflareOrigin(named) : cloudflareOrigin();
}

/** Where the page's copy is: `build/servicecue/`, or, under the same development switch, a folder a developer names. */
export const SERVICECUE_BUNDLE_ENV = "STAGE_UTILITY_SERVICECUE_BUNDLE";
export function deployBundleDir(env: Record<string, string | undefined> = process.env, allowLocal: boolean = localAllowed()): string {
  const named = env[SERVICECUE_BUNDLE_ENV];
  return allowLocal && named ? path.resolve(named) : path.join(APP_ROOT, "build", "servicecue");
}

/** The version this process runs: package.json does not change under a running server, so it is read once. */
const runningVersion = pkgVersion();

/** Keeps the public page itself up to date, from the copy every build carries, on the page the publisher reaches. */
export const servicecueDeployer = new ServiceCueDeployer({
  bundleDir: deployBundleDir(),
  version: () => runningVersion,
  live: () => stageController.getLastLive(),
  // Read back only for the address they were saved with: the page's current one.
  credentials: async () => {
    const parsed = parsePublishUrl((await servicecuePublishStore.load()).url);
    return parsed.ok ? readDeployCredentials(parsed.origin) : null;
  },
  apiOrigin: deployApiOrigin(),
});

export const servicecuePublisher = new ServiceCuePublisher({
  source: appSource,
  loadSettings: async () => ({ ...(await servicecuePublishStore.load()) }),
  loadToken: readPublishToken,
  version: pkgVersion,
  deploy: servicecueDeployer,
});
