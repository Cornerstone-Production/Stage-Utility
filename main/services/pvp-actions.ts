// pvp-actions.ts — the automation actions that drive ProVideoPlayer.
//
// EVERY ONE OF THESE VERIFIES. PVP answers a POST with HTTP 200 and an empty
// body whether or not anything happened — no echo of the applied value, no
// confirmation, nothing to read — and it applies the change a BEAT after the
// 200. So neither the response nor an immediate re-read is evidence, and an
// action that reported success on a 200 would be a rule that appears to run,
// logs "fired", and never touches a screen. That is the swallowed failure this
// repo has a rule about, wearing a different costume.
//
// The shape, without exception: resolve what the rule named, honour simulate,
// then ONE call to pvpService.command(path, body, { what, holds }). `holds` is
// asked of a fresh read of transportState, and a `holds` that says no is a
// FAILURE returned to the operator — never a log line.
//
// No try/catch around command(). It converts a transport failure into a returned
// result, so a catch here could only log, which is forbidden.

import { errorMessage } from "./errors.js";
import type { ActionDef, ActionResult } from "../types/automation.js";
import { hasContent, type PvpLayerDTO } from "../types/pvp.js";
import { pvpService } from "./pvp-service.js";

const ok = (detail: string): ActionResult => ({ ok: true, detail });
const fail = (detail: string): ActionResult => ({ ok: false, detail });

/** The two things these actions touch, behind a seam. Tests replace them;
 *  nothing else should. Kept narrow on purpose — the point is to be able to
 *  assert that an action which cannot confirm its write reports a FAILURE.
 *
 *  pvp-service.test.ts exercises the REAL command() over a stubbed transport, so
 *  the method itself is not proved by this double. */
export const pvpDeps: {
  readLayers: () => Promise<PvpLayerDTO[]>;
  command: (
    path: string,
    body: unknown,
    verify: { what: string; holds: (layers: readonly PvpLayerDTO[]) => boolean },
  ) => Promise<ActionResult>;
} = {
  readLayers: () => pvpService.readLayers(),
  command: (path, body, verify) => pvpService.command(path, body, verify),
};

const LAYER_PARAM = {
  key: "layer",
  label: "Layer",
  type: "string" as const,
  help: "The layer's name in ProVideoPlayer. Renaming the layer in PVP stops the rule.",
};

const PLAYLIST_PARAM = {
  key: "playlist",
  label: "Playlist",
  type: "string" as const,
  help: "The playlist's name in ProVideoPlayer. A playlist whose name is only digits cannot be used — PVP reads an all-digits value as a position, never a name.",
};

const CUE_PARAM = {
  key: "cue",
  label: "Cue",
  type: "string" as const,
  help: "The cue's name in ProVideoPlayer, exactly as it appears there. A cue whose name is only digits cannot be used — PVP reads an all-digits value as a position, never a name.",
};

/**
 * Turn the rule's layer NAME into the uuid the API addresses.
 *
 * A name in the rule and a uuid on the wire, because those are the right answers
 * to two different questions: a name is what the operator sees in PVP and what
 * survives being typed into a form, and a uuid is what PVP's own endpoints take
 * unambiguously — PVP reads an all-digits path parameter as an INDEX, never a
 * name, so a layer called "2" could not be addressed by name at all.
 *
 * A name that matches nothing is a failure with the names that DO exist in it.
 * "Layer not found" alone would leave an operator guessing at a typo.
 */
async function resolveLayer(
  params: Record<string, unknown>,
): Promise<{ layer: PvpLayerDTO } | { error: string }> {
  const want = String(params.layer ?? "").trim().toLowerCase();
  if (!want) return { error: "no layer name configured" };
  // Through readWorkspace, which is the same try/catch producing the same
  // message. Two copies of a read that turns a throw into an operator-facing
  // string is two places for the wording, and the recovery, to drift.
  const got = await readWorkspace();
  if ("error" in got) return got;
  const layers = got.layers;
  const layer = layers.find((l) => l.name.trim().toLowerCase() === want);
  if (!layer) {
    const known = layers.map((l) => `"${l.name}"`).join(", ") || "no layers";
    return { error: `no layer named "${String(params.layer)}" — PVP has ${known}` };
  }
  return { layer };
}

/** A layer from a fresh read, by uuid. The verify predicates work on uuid rather
 *  than name so a rename between the write and the read cannot make a failed
 *  action look successful. */
const byUuid = (layers: readonly PvpLayerDTO[], uuid: string): PvpLayerDTO | undefined =>
  layers.find((l) => l.uuid === uuid);

/**
 * A path segment PVP will read as a NAME.
 *
 * PVP reads an all-digits parameter as an INDEX, so "2024" would address the
 * 2024th entry rather than the playlist called 2024 — refused here rather than
 * fired at something the operator did not mean.
 */
function nameSegment(raw: unknown, what: string): { value: string } | { error: string } {
  const v = String(raw ?? "").trim();
  if (!v) return { error: `no ${what} name configured` };
  if (/^\d+$/.test(v)) {
    return {
      error: `ProVideoPlayer reads an all-digits ${what} name as a position, so "${v}" cannot be addressed by name`,
    };
  }
  return { value: encodeURIComponent(v) };
}

const sameName = (a: string | null, b: string): boolean =>
  (a ?? "").trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Did THIS trigger land, as opposed to having landed at some point in the past?
 *
 * `lastCueName` alone cannot answer that, and getting this wrong is the exact
 * failure the whole integration is built against. It is RESIDUAL — it names the
 * last cue that touched the layer and never clears, so after a rule has once
 * fired "MAIN GRAPHIC", every later attempt to fire "MAIN GRAPHIC" would find it
 * already there and confirm instantly, even against a PVP that answered 200 and
 * did nothing, and even on a layer that has since been cleared to black.
 *
 * So it takes a PRE-IMAGE and requires the cue to be there AND something to have
 * observably moved: the cue name changed, the media changed, or the clip's clock
 * jumped backwards (a restart). A layer we had never seen before counts as
 * moved, because it cannot have been carrying this cue already.
 */
function cueLandedSince(before: PvpLayerDTO | undefined, after: PvpLayerDTO | undefined, cue: string): boolean {
  if (!after || !sameName(after.lastCueName, cue)) return false;
  if (!before) return true;
  if (!sameName(before.lastCueName, cue)) return true;
  if (before.mediaUuid !== after.mediaUuid) return true;
  // A restart: PVP was further into the clip before the POST than after it.
  return (
    before.anchorElapsedSec != null &&
    after.anchorElapsedSec != null &&
    after.anchorElapsedSec < before.anchorElapsedSec
  );
}

/** A snapshot to compare the verify read against, keyed by layer uuid. */
const byUuidMap = (layers: readonly PvpLayerDTO[]): Map<string, PvpLayerDTO> =>
  new Map(layers.map((l) => [l.uuid, l]));

/**
 * The whole workspace, or a failure. Every trigger action needs a pre-image, and
 * a trigger that cannot take one cannot be confirmed, so it must not be sent.
 */
async function readWorkspace(): Promise<{ layers: PvpLayerDTO[] } | { error: string }> {
  try {
    return { layers: await pvpDeps.readLayers() };
  } catch (e) {
    return { error: `could not read ProVideoPlayer's layers: ${errorMessage(e)}` };
  }
}

/**
 * Hide / unhide / mute / unmute. One function because the four are mechanically
 * identical and only the words differ — written out four times, one of them ends
 * up verifying the wrong field and reporting a working action as failed forever.
 */
function flagAction(
  id: string,
  label: string,
  path: "hide" | "unhide" | "mute" | "unmute",
  key: "hidden" | "muted",
  want: boolean,
  past: string,
): ActionDef {
  return {
    id,
    label,
    help: "Confirmed by reading PVP's state back — if the layer did not change, this reports a failure rather than a success.",
    params: [LAYER_PARAM],
    run: async (params, ctx) => {
      const r = await resolveLayer(params);
      if ("error" in r) return fail(r.error);
      if (ctx.simulate) return ok(`would ${path} layer ${r.layer.name}`);
      return await pvpDeps.command(`/${path}/layer/${r.layer.uuid}`, undefined, {
        what: `layer ${r.layer.name} ${past}`,
        holds: (layers) => byUuid(layers, r.layer.uuid)?.[key] === want,
      });
    },
  };
}

export const PVP_ACTIONS: Record<string, ActionDef> = {
  "pvp.clear-layer": {
    id: "pvp.clear-layer",
    label: "Clear a ProVideoPlayer layer",
    // Never tested against a layer holding content — the research only ever
    // cleared an empty one. It ships anyway BECAUSE it verifies: if the clear
    // does nothing, the rule reports a failure rather than a success, which is
    // the whole point of the design.
    help: "Takes whatever is on that layer off screen. Confirmed by reading PVP's state back — if the layer still holds content, this reports a failure rather than a success.",
    params: [LAYER_PARAM],
    run: async (params, ctx) => {
      const r = await resolveLayer(params);
      if ("error" in r) return fail(r.error);
      if (ctx.simulate) return ok(`would clear layer ${r.layer.name}`);
      return await pvpDeps.command(`/clear/layer/${r.layer.uuid}`, undefined, {
        what: `layer ${r.layer.name} cleared`,
        // The PRESENCE of media is the only reliable has-content signal. Not
        // isPlaying (a still reports true) and not the cue name, which is
        // residual and survives a clear on every layer we have seen — a verify
        // that asked about the cue would report a working clear as failed
        // forever.
        holds: (layers) => { const l = byUuid(layers, r.layer.uuid); return !!l && !hasContent(l); },
      });
    },
  },

  "pvp.clear-workspace": {
    id: "pvp.clear-workspace",
    label: "Clear every ProVideoPlayer layer",
    // Never tested live either, and the description says so: the research
    // declined to fire it because it blanks every screen at once, which is not
    // something to try during a service.
    help: "Takes everything off every layer at once. Blanks every screen PVP is driving. Confirmed by reading PVP's state back.",
    params: [],
    run: async (_params, ctx) => {
      if (ctx.simulate) return ok("would clear every layer");
      return await pvpDeps.command("/clear/workspace", undefined, {
        what: "every layer cleared",
        // `layers.length > 0` is load-bearing: every() is vacuously true on an
        // empty read, so a workspace we failed to read would report success.
        holds: (layers) => layers.length > 0 && !layers.some(hasContent),
      });
    },
  },

  "pvp.hide-layer": flagAction("pvp.hide-layer", "Hide a ProVideoPlayer layer", "hide", "hidden", true, "hidden"),
  "pvp.unhide-layer": flagAction("pvp.unhide-layer", "Unhide a ProVideoPlayer layer", "unhide", "hidden", false, "shown"),
  "pvp.mute-layer": flagAction("pvp.mute-layer", "Mute a ProVideoPlayer layer", "mute", "muted", true, "muted"),
  "pvp.unmute-layer": flagAction("pvp.unmute-layer", "Unmute a ProVideoPlayer layer", "unmute", "muted", false, "unmuted"),

  "pvp.set-layer-opacity": {
    id: "pvp.set-layer-opacity",
    label: "Set a ProVideoPlayer layer's opacity",
    help: "0 is invisible, 100 is fully opaque. Confirmed by reading PVP's state back.",
    params: [
      LAYER_PARAM,
      // Percent, not the 0..1 the API takes: an operator types 50, not 0.5. The
      // themed NumberInput renders this from `type: "number"`, with these bounds.
      { key: "percent", label: "Opacity (%)", type: "number", min: 0, max: 100 },
    ],
    run: async (params, ctx) => {
      const raw = Number(params.percent);
      // Rejected here rather than sent. PVP SILENTLY CLAMPS an out-of-range value
      // to 1 and answers 200, so sending 500 would set the layer fully opaque and
      // report success at "500%" — a wrong action that looks like a right one.
      if (!Number.isFinite(raw) || raw < 0 || raw > 100) {
        return fail(`opacity must be between 0 and 100, not "${String(params.percent)}"`);
      }
      const r = await resolveLayer(params);
      if ("error" in r) return fail(r.error);
      const value = raw / 100;
      if (ctx.simulate) return ok(`would set layer ${r.layer.name} to ${raw}%`);
      return await pvpDeps.command(`/opacity/layer/${r.layer.uuid}`, { value }, {
        what: `layer ${r.layer.name} set to ${raw}%`,
        // A tolerance, not equality: the value crosses JSON and comes back
        // through whatever precision PVP keeps it in, and an exact float compare
        // would report a working action as failed.
        holds: (layers) => {
          const l = byUuid(layers, r.layer.uuid);
          return !!l && Math.abs(l.opacity - value) < 0.01;
        },
      });
    },
  },

  "pvp.trigger-cue": {
    id: "pvp.trigger-cue",
    label: "Fire a ProVideoPlayer cue",
    help: "Fires a cue from a playlist. ProVideoPlayer decides which layer it lands on. Confirmed by reading PVP's state back — if no layer picks the cue up, the rule reports a failure rather than a success.",
    params: [PLAYLIST_PARAM, CUE_PARAM],
    run: async (params, ctx) => {
      const playlist = nameSegment(params.playlist, "playlist");
      if ("error" in playlist) return fail(playlist.error);
      const cue = nameSegment(params.cue, "cue");
      if ("error" in cue) return fail(cue.error);
      const cueName = String(params.cue).trim();
      if (ctx.simulate) return ok(`would fire cue "${cueName}"`);
      // A pre-image, BEFORE the POST. Without it the residual cue name makes a
      // repeat trigger confirm itself instantly against a PVP that did nothing.
      const pre = await readWorkspace();
      if ("error" in pre) return fail(pre.error);
      const before = byUuidMap(pre.layers);
      // Said in the message rather than hidden: if some layer is already carrying
      // this cue, only a restart or a media change can confirm a fresh trigger,
      // so a still already sitting on it cannot be confirmed at all.
      const stale = pre.layers.some((l) => sameName(l.lastCueName, cueName));
      return await pvpDeps.command(`/trigger/playlist/${playlist.value}/cue/${cue.value}`, undefined, {
        what: stale
          ? `cue "${cueName}" fired (it was already the last cue here, so only a restart can confirm it)`
          : `cue "${cueName}" fired`,
        // ANY layer, because this form does not say which one it will land on —
        // PVP decides that from the cue. Asking about a specific layer here would
        // report a working trigger as failed.
        holds: (layers) => layers.some((l) => cueLandedSince(before.get(l.uuid), l, cueName)),
      });
    },
  },
};
