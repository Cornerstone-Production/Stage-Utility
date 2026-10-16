// The launchd labels live in three places that cannot import each other:
// launchd-label.ts (what the running server recognises), install.sh (what it
// registers, and migrates away from) and scripts/uninstall.sh (what it removes).
// Rename a label in one and the others quietly keep the old one: the installer
// registers a job the updater does not recognise, or the uninstaller leaves a
// daemon behind that keeps fighting for the port.
//
// So each script's own assignment lines are run by real bash, and the labels
// they produce must be exactly the ones launchd-label.ts knows. The lines are
// matched at the start of a line as assignments, which prose and comments cannot
// satisfy; the script is never run, only those lines.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { KNOWN_DAEMON_LABELS } from "./launchd-label.js";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** The first line of `file` matching `pattern`; fails if there is not exactly one. */
function assignmentLine(file: string, pattern: RegExp): string {
  const lines = fs.readFileSync(path.join(REPO, file), "utf8").split("\n").filter((l) => pattern.test(l));
  assert.equal(lines.length, 1, `${file}: expected exactly one line matching ${pattern}, found ${lines.length}`);
  return lines[0];
}

/** Evaluate assignment lines with bash and print the named expressions, one per line. */
function bashPrint(assignments: string[], printf: string): string[] {
  const script = `${assignments.join("\n")}\n${printf}`;
  return execFileSync("bash", ["-c", script], { encoding: "utf8" }).split("\n").filter(Boolean);
}

const sorted = (xs: readonly string[]): string[] => [...xs].sort();

describe("the launchd labels in the shell scripts match launchd-label.ts", () => {
  it("install.sh registers the new label and migrates away from exactly the legacy ones", () => {
    const labels = bashPrint(
      [
        assignmentLine("install.sh", /^SERVICE_NAME=/),
        assignmentLine("install.sh", /^LAUNCHD_LABEL=/),
        assignmentLine("install.sh", /^LEGACY_LAUNCHD_LABEL=/),
      ],
      'printf "%s\\n" "$LAUNCHD_LABEL" "$LEGACY_LAUNCHD_LABEL"',
    );
    assert.deepEqual(sorted(labels), sorted(KNOWN_DAEMON_LABELS));
  });

  it("uninstall.sh removes exactly the labels the app recognises", () => {
    const labels = bashPrint(
      [assignmentLine("scripts/uninstall.sh", /^SERVICE_NAME=/), assignmentLine("scripts/uninstall.sh", /^LAUNCHD_LABELS=\(/)],
      'printf "%s\\n" "${LAUNCHD_LABELS[@]}"',
    );
    assert.deepEqual(sorted(labels), sorted(KNOWN_DAEMON_LABELS));
  });
});
