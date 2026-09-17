// app-state-reads.ts — what each `app:` state source currently says.
//
// The registry itself is pure and lives in app-state-sources.ts, because the
// rule editor imports it through cue-pairs.ts. This half touches the services
// and is server-only.
//
// One reader per source, in a Record over the id union: a source added to
// APP_STATE_SOURCE_IDS without a reader here does not compile. A Map with an
// optional lookup would instead have shipped a source that reads unknown
// forever, which is exactly the silent failure the binding exists to remove.
//
// A reader NEVER throws and never guesses: "REAPER is not connected" is the
// honest answer for an integration that is off or unreachable, and it reaches
// the operator as the cue state's `reason`.

import {
  APP_STATE_FAMILIES,
  APP_STATE_SOURCES,
  parseAppStateRef,
  type AppStateFamilyId,
  type AppStateSourceId,
} from "./app-state-sources.js";
import type { VariableResult } from "./companion-api.js";
import { obsService } from "./obs-service.js";
import { pvpService } from "./pvp-service.js";
import { reaperService } from "./reaper-service.js";
import { resiService } from "./resi-service.js";
import { youtubeService } from "./youtube-service.js";
import type { PvpLayerDTO } from "../types/pvp.js";

/** A source's answer: a value, or why nobody can say. */
export interface AppStateValue {
  value: string | null;
  /** Present exactly when `value` is null. */
  reason?: string;
}

const REAPER = APP_STATE_SOURCES.get("reaper.recording")!;
const OBS_RECORDING = APP_STATE_SOURCES.get("obs.recording")!;
const OBS_STREAMING = APP_STATE_SOURCES.get("obs.streaming")!;
const OBS_VIRTUAL_CAM = APP_STATE_SOURCES.get("obs.virtualCam")!;
const YOUTUBE_LIVE = APP_STATE_SOURCES.get("youtube.live")!;
const RESI_LIVE = APP_STATE_SOURCES.get("resi.live")!;

const READS: Record<AppStateSourceId, () => AppStateValue> = {
  "reaper.recording": () => {
    const status = reaperService.getLatest();
    // NOT "off" for a REAPER nobody can reach. An unreachable recorder reporting
    // "not recording" is a Home Assistant switch saying the service is not being
    // recorded when the truth is that we do not know.
    if (!status.connected) return { value: null, reason: "REAPER is not connected" };
    return { value: status.recording ? REAPER.onValue : REAPER.offValue };
  },
  // OBS costs nothing to read: the snapshot is pushed by obs-websocket on
  // RecordStateChanged and StreamStateChanged, so it is already what OBS said
  // rather than what a poll last managed to ask.
  "obs.recording": () => {
    const status = obsService.getLatest();
    // Unknown, not "off", for the same reason REAPER's reader refuses to guess:
    // a recorder nobody can reach reported as "not recording" is a switch
    // saying the service is not being recorded when the truth is nobody knows.
    // A PAUSED recording is still a recording — OBS has one in progress, and
    // the snapshot's `recording` already says so.
    if (!status.connected) return { value: null, reason: "OBS is not connected" };
    return { value: status.recording ? OBS_RECORDING.onValue : OBS_RECORDING.offValue };
  },
  "obs.streaming": () => {
    const status = obsService.getLatest();
    if (!status.connected) return { value: null, reason: "OBS is not connected" };
    return { value: status.streaming ? OBS_STREAMING.onValue : OBS_STREAMING.offValue };
  },
  "obs.virtualCam": () => {
    const status = obsService.getLatest();
    if (!status.connected) return { value: null, reason: "OBS is not connected" };
    return { value: status.virtualCam ? OBS_VIRTUAL_CAM.onValue : OBS_VIRTUAL_CAM.offValue };
  },
  // The two platforms, which no action here can start or stop. `connected` is
  // the link to the platform's API and `live` is whether it is broadcasting —
  // two different problems, and only one of them is anybody's to fix mid-service
  // (see StreamStatusDTO). A YouTube we cannot reach reported as "off" would be
  // a light saying the service is not on air during the one part of the morning
  // somebody would act on it.
  "youtube.live": () => {
    const status = youtubeService.getLatest();
    if (!status.connected) return { value: null, reason: "YouTube is not connected" };
    return { value: status.live ? YOUTUBE_LIVE.onValue : YOUTUBE_LIVE.offValue };
  },
  "resi.live": () => {
    const status = resiService.getLatest();
    if (!status.connected) return { value: null, reason: "Resi is not connected" };
    return { value: status.live ? RESI_LIVE.onValue : RESI_LIVE.offValue };
  },
};

const PVP_HIDDEN = APP_STATE_FAMILIES.get("pvp.layer-hidden")!;
const PVP_MUTED = APP_STATE_FAMILIES.get("pvp.layer-muted")!;

/**
 * The one PVP layer this ref names, or why nobody can say.
 *
 * Matched exactly as pvp-actions.ts's `resolveLayer` matches — trimmed and
 * case-insensitively — so the switch and the action that drives it find the same
 * layer or fail together. A reading that resolved a name the action could not
 * would be a switch reporting a state for a layer the cue never touched.
 *
 * Two layers of the same name is UNKNOWN rather than the first hit: PVP allows
 * it, `resolveLayer` would address whichever came back first, and a switch
 * silently reporting one of two layers is worse than one saying it cannot tell.
 */
function pvpLayer(name: string): { layer: PvpLayerDTO } | { reason: string } {
  const status = pvpService.getLatest();
  // Not "shown"/"unmuted" for a PVP nobody can reach, for the reason every
  // reader above refuses to guess: a layer reported as visible when the truth is
  // that nobody knows is a switch lying during the one hour it is watched.
  if (!status.connected) return { reason: "ProVideoPlayer is not connected" };
  const want = name.trim().toLowerCase();
  const hits = status.layers.filter((l) => l.name.trim().toLowerCase() === want);
  if (hits.length > 1) return { reason: `Two or more PVP layers are called "${name}"` };
  const layer = hits[0];
  if (!layer) return { reason: `No PVP layer called "${name}"` };
  return { layer };
}

const flag = (
  name: string,
  read: (layer: PvpLayerDTO) => boolean,
  def: { onValue: string; offValue: string },
): AppStateValue => {
  const got = pvpLayer(name);
  if ("reason" in got) return { value: null, reason: got.reason };
  return { value: read(got.layer) ? def.onValue : def.offValue };
};

/**
 * One reader per FAMILY, taking the parameter — a Record over the family union,
 * so a family added without a reader does not compile, exactly as above.
 */
const FAMILY_READS: Record<AppStateFamilyId, (param: string) => AppStateValue> = {
  "pvp.layer-hidden": (name) => flag(name, (l) => l.hidden, PVP_HIDDEN),
  "pvp.layer-muted": (name) => flag(name, (l) => l.muted, PVP_MUTED),
};

/**
 * Read one `app:` ref, in the same shape `companionApi.readVariable` answers in
 * — so cue-states.ts treats both namespaces identically from there on.
 */
export function readAppState(variable: string): VariableResult {
  const parsed = parseAppStateRef(variable);
  if (!parsed) return { error: `no Stage Utility state source called "${variable.trim()}"` };
  const answer =
    parsed.kind === "source" ? READS[parsed.id]() : FAMILY_READS[parsed.family](parsed.param);
  return answer.value === null ? { error: answer.reason ?? "cannot be read" } : { value: answer.value };
}
