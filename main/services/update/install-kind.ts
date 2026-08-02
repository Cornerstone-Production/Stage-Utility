// install-kind.ts — how this copy of the server was installed.
//
// Declared by the packaged launchers rather than guessed, because a wrong guess
// writes to the wrong place. Inference exists only for installs that predate the
// launcher change: it picks a STRATEGY and never decides a path.

import { FORMULA } from "./homebrew-strategy.js";

export type InstallKind = "git" | "tarball" | "homebrew" | "unknown";

/** Keg path fragment for each published formula, e.g. "/Cellar/stage-utility-beta/". */
const HOMEBREW_KEGS = Object.values(FORMULA).map((f) => `/Cellar/${f}/`);

const DECLARED: readonly InstallKind[] = ["git", "tarball", "homebrew"];

/** Exactly the prefixes install.sh and install.ps1 write to. */
const TARBALL_PREFIXES = [
  "/opt/stage-utility",
  "/usr/local/stage-utility",
  "C:\\Program Files\\Stage Utility",
];

/**
 * True when appRoot is exactly prefix, or a path segment below it.
 *
 * install.ps1 creates releases\<version> and a `current` junction below the
 * Windows prefix, joined with a backslash — so the segment boundary must
 * recognise either separator. A plain startsWith(prefix) would also match
 * "/opt/stage-utility-other", which must NOT be treated as a tarball install.
 */
function isUnder(appRoot: string, prefix: string): boolean {
  if (appRoot === prefix) return true;
  return appRoot.startsWith(`${prefix}/`) || appRoot.startsWith(`${prefix}\\`);
}

export function detectInstallKind(
  env: NodeJS.ProcessEnv,
  appRoot: string,
  exists: (p: string) => boolean,
): InstallKind {
  const declared = env.STAGE_UTILITY_INSTALL_KIND?.trim();
  if (declared) {
    return (DECLARED as readonly string[]).includes(declared)
      ? (declared as InstallKind)
      : "unknown";
  }
  if (exists(`${appRoot}/.git`)) return "git";
  // Every formula we publish, not one hardcoded name. This matched only
  // "/Cellar/stage-utility/", so the moment a beta formula existed every install
  // from it detected as "unknown" — no strategy, no in-app update. Derived from
  // FORMULA so adding a third track cannot reintroduce that.
  if (HOMEBREW_KEGS.some((keg) => appRoot.includes(keg))) return "homebrew";
  if (TARBALL_PREFIXES.some((p) => isUnder(appRoot, p))) return "tarball";
  return "unknown";
}
