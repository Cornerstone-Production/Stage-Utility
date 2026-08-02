// install-kind.ts — how this copy of the server was installed.
//
// Declared by the packaged launchers rather than guessed, because a wrong guess
// writes to the wrong place. Inference exists only for installs that predate the
// launcher change: it picks a STRATEGY and never decides a path.

export type InstallKind = "git" | "tarball" | "homebrew" | "unknown";

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
  if (appRoot.includes("/Cellar/stage-utility/")) return "homebrew";
  if (TARBALL_PREFIXES.some((p) => isUnder(appRoot, p))) return "tarball";
  return "unknown";
}
