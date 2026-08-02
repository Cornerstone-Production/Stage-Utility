// select-strategy.ts — install kind in, strategy out.
//
// Deliberately the only place that maps a kind to an implementation, so adding a
// fourth install method touches one function. `null` for "unknown" rather than a
// throw: the caller owns the error message, and it is the caller that knows what
// was detected and can say so.

import * as fs from "node:fs";

import { APP_ROOT } from "../app-root.js";
import { GitStrategy } from "./git-strategy.js";
import { HomebrewStrategy } from "./homebrew-strategy.js";
import type { InstallKind } from "./install-kind.js";
import type { UpdateStrategy } from "./strategy.js";
import { TarballStrategy } from "./tarball-strategy.js";

export function selectStrategy(
  kind: InstallKind,
  platform: NodeJS.Platform,
  exists: (p: string) => boolean = fs.existsSync,
  appRoot: string = APP_ROOT,
): UpdateStrategy | null {
  if (kind === "git") return new GitStrategy(appRoot, platform, exists);
  if (kind === "tarball") return new TarballStrategy(platform);
  if (kind === "homebrew") return new HomebrewStrategy(exists);
  return null;
}
