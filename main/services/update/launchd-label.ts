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

/**
 * What asking launchd about one job came back with. "not-loaded" is an answer;
 * `error` is the absence of one — launchctl could not be run or did not reply —
 * and is kept apart so the failure the operator reads names the real cause.
 */
export type ProbeResult = "loaded" | "not-loaded" | { error: string };

export type LabelProbe = (label: DaemonLabel) => ProbeResult;

/**
 * Run one `launchctl print` and classify how it went. A non-zero exit status is
 * launchctl saying the job is not loaded. Anything else (the binary missing, the
 * timeout, a signal) means it never got to answer. Takes the run as an argument
 * so the classification is exercised against real child-process failures
 * without calling launchctl.
 */
export function probeWith(run: () => void): ProbeResult {
  try {
    run();
    return "loaded";
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { status?: number | null; signal?: string | null };
    if (typeof e.status === "number") return "not-loaded";
    return { error: e.code ?? e.signal ?? e.message };
  }
}

export const launchctlProbe: LabelProbe = (label) =>
  probeWith(() => {
    execFileSync("launchctl", ["print", `system/${label}`], { stdio: "ignore", timeout: 2000 });
  });

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

  const unanswered: string[] = [];
  for (const label of KNOWN_DAEMON_LABELS) {
    const r = probe(label);
    if (r === "loaded") return { ok: true, label, via: "probe" };
    if (r !== "not-loaded") unanswered.push(`${label}: ${r.error}`);
  }

  const seen = `XPC_SERVICE_NAME=${JSON.stringify(env.XPC_SERVICE_NAME ?? null)}`;
  return {
    ok: false,
    reason: unanswered.length
      ? `launchctl could not say which job runs this server (${seen}; ${unanswered.join("; ")})`
      : `no known launchd job is running this server (${seen}; none of ${KNOWN_DAEMON_LABELS.join(", ")} is loaded in the system domain)`,
  };
}
