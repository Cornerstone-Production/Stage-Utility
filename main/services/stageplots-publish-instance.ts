// stageplots-publish-instance.ts — the stage plots publisher wired to the app.
//
// stageplots-publish.ts takes everything it reads as a seam so a test can drive it against
// the real Worker handler. This is the one place those seams are the real thing: the
// ServiceCue page's saved address and token, the stage plots store, the image folder, the
// plan the app follows, the patch linked points resolve against and the app's time zone.

import { appTimeZone } from "./app-timezone.js";
import { addBroadcastListener, broadcast } from "./broadcaster.js";
import { patchStore } from "./patch-store.js";
import { checkPublishToken, parsePublishUrl } from "./servicecue-publish-rules.js";
import { readPublishToken, servicecuePublishStore } from "./servicecue-publish-store.js";
import { stageController } from "./stage-controller.js";
import { readStagePlotImage, stagePlotsView } from "./stageplots-files.js";
import { StagePlotsPublisher, type PublishTarget } from "./stageplots-publish.js";
import { stageplotsStore } from "./stageplots-store.js";
import type { PatchFile } from "../types/patch.js";
import { STAGEPLOTS_CHANNEL } from "../types/stageplots.js";

/** What the card says when there is no page to publish to. */
export const NO_PAGE =
  "Set up the public link first: the page address and its publishing token, under Public link at the foot of the ServiceCue layouts page.";

/** The ServiceCue page's address and token, whether or not ServiceCue publishing is switched on. */
export async function publishTarget(): Promise<PublishTarget> {
  const parsed = parsePublishUrl((await servicecuePublishStore.load()).url);
  if (!parsed.ok) return { ok: false, message: NO_PAGE };
  const token = (await readPublishToken(parsed.origin)).trim();
  if (token === "" || checkPublishToken(token) !== null) return { ok: false, message: NO_PAGE };
  return { ok: true, origin: parsed.origin, token };
}

/** The patch the publisher resolves linked points against. Strict: an unreadable or set-aside
 *  patch.json throws, and linked points go out unlinked, never against the seed sheets (where
 *  every link would read "device removed"). */
export function publisherPatch(): Promise<PatchFile> {
  return patchStore.loadStrict();
}

export const stageplotsPublisher = new StagePlotsPublisher({
  target: publishTarget,
  store: stageplotsStore,
  image: readStagePlotImage,
  plan: () => {
    const state = stageController.getState();
    return state.pcoConfigured
      ? { planId: state.planId, planDates: state.planDates, serviceTypeId: state.serviceTypeId }
      : { planId: null, planDates: null, serviceTypeId: null };
  },
  patch: publisherPatch,
  timeZone: appTimeZone,
  // The follow's notice rides on every broadcast, so the Publish card keeps it until the next save clears it.
  onSaved: (doc) => broadcast(STAGEPLOTS_CHANNEL, stagePlotsView(doc, stageplotsPublisher.notice())),
  listen: (cb) => addBroadcastListener((channel) => cb(channel)),
});
