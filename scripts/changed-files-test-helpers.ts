// Runs the changed-files composite action's own shell (.github/actions/changed-files)
// for the two workflow tests that use it, codeql-workflow.test.ts and
// helper-macos-workflow.test.ts, with a stand-in for `gh`.
//
// The stand-in answers like the API: it checks the endpoint, serves a page of 30
// unless the call paginates, caps the comparison at 300 files, runs the real `jq` on
// the call's own filter, and logs every endpoint it was asked for, so a test can say
// which listing a decision came from.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CHANGED_FILES_ACTION = path.join(HERE, "..", ".github", "actions", "changed-files", "action.yml");

interface ActionStep {
  id?: string;
  run?: string;
  env?: Record<string, string>;
}
export const changedFilesAction = parse(fs.readFileSync(CHANGED_FILES_ACTION, "utf8")) as {
  inputs: Record<string, unknown>;
  outputs: Record<string, { value: string }>;
  runs: { using: string; steps: ActionStep[] };
};
export const listStep = changedFilesAction.runs.steps.find((s) => s.id === "list");

/** `gh api [--paginate] <endpoint> --jq <filter>`, answering as the REST API does. */
const GH = `#!/bin/bash
paginate=0; endpoint=""; filter=""
while [ $# -gt 0 ]; do
  case "$1" in
    api) ;;
    --paginate) paginate=1 ;;
    --jq) filter="$2"; shift ;;
    *) endpoint="$1" ;;
  esac
  shift
done
echo "$endpoint" >>"$GH_CALLS"
[ -n "$GH_FAIL" ] && { echo "api failure" >&2; exit 1; }
[ "$endpoint" = "$GH_EXPECT" ] || { echo "unexpected endpoint $endpoint, wanted $GH_EXPECT" >&2; exit 1; }
case "$endpoint" in
  */pulls/*/files)
    # 30 a page, 3000 in all; only a paginating call sees past the first page.
    if [ "$paginate" = 1 ]; then jq 'limit(3000; .[])' "$GH_FIXTURE" | jq -s '.' | jq -r "$filter"
    else jq 'limit(30; .[])' "$GH_FIXTURE" | jq -s '.' | jq -r "$filter"; fi ;;
  */compare/*)
    # 300 files at most, and an object rather than an array.
    jq '{files: .[0:300]}' "$GH_FIXTURE" | jq -r "$filter" ;;
esac
`;

export type Entry = string | { filename: string; previous_filename: string };

export interface Event {
  /** github.event_name */
  event: string;
  /** github.event.action */
  action?: string;
  /** github.event.pull_request.head.ref */
  headRef?: string;
  /** github.event.pull_request.head.repo.full_name */
  headRepo?: string;
  /** github.event.before: empty on a pull request that was not pushed to */
  before?: string;
  /** Which listing the API is expected to be asked for. Anything else is a 404. */
  via: "pr" | "compare" | "none";
  /** What that listing holds, or "error" for an API that fails. */
  files?: Entry[] | "error";
}

export interface Listed {
  /** The step answered that everything counts. */
  all: boolean;
  /** The files it listed. */
  files: string[];
  /** Every endpoint it asked `gh` for, in order. */
  calls: string[];
  /** What it said. */
  log: string;
}

export const REPO = "o/r";
export const AFTER = "2".repeat(40);
export const BEFORE = "1".repeat(40);

/** The listing for `c`, and the outputs the step wrote. */
export function listChanged(c: Event): Listed {
  assert.ok(listStep?.run, "no step lists the changed files");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "su-changed-files-"));
  try {
    const out = path.join(tmp, "output");
    const calls = path.join(tmp, "calls");
    const fixture = path.join(tmp, "files.json");
    const before = c.before ?? (c.event === "push" || c.action === "synchronize" ? BEFORE : "");
    const endpoint =
      c.via === "pr" ? `repos/${REPO}/pulls/1/files` : c.via === "compare" ? `repos/${REPO}/compare/${before}...${AFTER}` : "none";
    fs.writeFileSync(
      fixture,
      JSON.stringify(Array.isArray(c.files) ? c.files.map((f) => (typeof f === "string" ? { filename: f } : f)) : []),
    );
    fs.writeFileSync(path.join(tmp, "gh"), GH, { mode: 0o755 });
    fs.writeFileSync(out, "");
    fs.writeFileSync(calls, "");
    // Actions runs a composite step with `shell: bash` as `bash --noprofile --norc -eo pipefail {0}`.
    const r = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", listStep.run], {
      encoding: "utf8",
      env: {
        PATH: `${tmp}:${process.env["PATH"] ?? ""}`,
        GITHUB_OUTPUT: out,
        RUNNER_TEMP: tmp,
        GH_FIXTURE: fixture,
        GH_CALLS: calls,
        GH_FAIL: c.files === "error" ? "1" : "",
        GH_EXPECT: endpoint,
        EVENT: c.event,
        EVENT_ACTION: c.action ?? "",
        HEAD_REF: c.headRef ?? "",
        HEAD_REPO: c.headRepo ?? "",
        REPO,
        PR_NUMBER: "1",
        BEFORE: before,
        AFTER,
      },
    });
    assert.equal(r.status, 0, r.stderr);
    const outputs = Object.fromEntries(
      fs
        .readFileSync(out, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    );
    assert.deepEqual(Object.keys(outputs).sort(), ["all", "file"]);
    assert.ok(outputs["all"] === "true" || outputs["all"] === "false", `all is ${String(outputs["all"])}`);
    return {
      all: outputs["all"] === "true",
      files: fs.readFileSync(outputs["file"], "utf8").split("\n").filter(Boolean),
      calls: fs.readFileSync(calls, "utf8").split("\n").filter(Boolean),
      log: r.stdout,
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** A pull request from this repository's beta branch into main that was just pushed to: the release pull request. */
export const RELEASE_PUSH = { event: "pull_request", action: "synchronize", headRef: "beta", headRepo: REPO } as const;
