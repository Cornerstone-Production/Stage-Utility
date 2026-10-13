// launchd-label.ts — which launchd job THIS process is running as.
//
// install.sh registers a macOS tarball install under DAEMON_LABEL. Installs made
// before the rename carry LEGACY_DAEMON_LABELS instead, and keep them: an in-app
// update swaps the release tree and never rewrites the plist, so only a re-run of
// the installer moves a box to the new name. Both therefore exist in the field at
// once, and nothing here may assume one.
//
// The label cannot be read from our own files, so ask launchd.

import { execFileSync } from "node:child_process";

/** The label install.sh registers today. */
export const DAEMON_LABEL = "com.stageutility.server";

/** Labels older installers registered. Every one is still live on some Mac. */
export const LEGACY_DAEMON_LABELS = ["com.cornerstone.stage-utility"] as const;

/** New first: a box mid-migration, with both loaded, is better served by the new. */
export const KNOWN_DAEMON_LABELS = [DAEMON_LABEL, ...LEGACY_DAEMON_LABELS] as const;

export type DaemonLabel = (typeof KNOWN_DAEMON_LABELS)[number];

export type LabelResolution =
  | { ok: true; label: DaemonLabel; via: "environment" | "probe" }
  | { ok: false; reason: string };

/** True when launchd has this job loaded in the system domain. */
export type LabelProbe = (label: DaemonLabel) => boolean;

/**
 * `launchctl print` exits non-zero for a job that is not loaded, which is the
 * ordinary "no" answer. A launchctl that cannot run at all reads the same way
 * here, and resolveDaemonLabel reports "found nothing" to its caller either way.
 */
export const launchctlProbe: LabelProbe = (label) => {
  try {
    execFileSync("launchctl", ["print", `system/${label}`], { stdio: "ignore", timeout: 2000 });
    return true;
  } catch {
    return false;
  }
};

/**
 * launchd sets XPC_SERVICE_NAME to the job's label for every process it starts,
 * so that is the first answer. "0" is what a login shell inherits, and anything
 * else unrecognised (a hand-run server inside some other app's job) is not ours
 * to kick, so both fall through to probing.
 *
 * The result is always one of the constants above, never the environment's
 * string: it ends up in a shell command.
 */
export function resolveDaemonLabel(env: NodeJS.ProcessEnv, probe: LabelProbe = launchctlProbe): LabelResolution {
  const named = KNOWN_DAEMON_LABELS.find((l) => l === env.XPC_SERVICE_NAME);
  if (named) return { ok: true, label: named, via: "environment" };

  const loaded = KNOWN_DAEMON_LABELS.find((l) => probe(l));
  if (loaded) return { ok: true, label: loaded, via: "probe" };

  return {
    ok: false,
    reason:
      `no known launchd job is running this server (XPC_SERVICE_NAME=${JSON.stringify(env.XPC_SERVICE_NAME ?? null)}, ` +
      `none of ${KNOWN_DAEMON_LABELS.join(", ")} is loaded in the system domain)`,
  };
}
