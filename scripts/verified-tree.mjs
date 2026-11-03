#!/usr/bin/env node
// verified-tree.mjs — has the tree a push to main carries already passed the release gate on beta?
//
//   node scripts/verified-tree.mjs        (in release.yml; writes `verified` to $GITHUB_OUTPUT)
//
// A stable release is beta merged into main, so the tree main is handed is beta's, which
// the release run on beta lint-checked, type-checked, built and tested minutes or days
// earlier. Running that gate again is five minutes of proving nothing new. Not quite the
// same tree, though: beta's tip is the `chore(release)` bump the beta release pushed with
// [skip ci], so it was never itself verified, and it differs from the verified commit
// before it in the version field of package.json and package-lock.json, and nowhere else.
//
// So the answer is yes only when a release run on beta whose every verify job passed was
// run on a commit this push contains, and the only difference between that commit's tree
// and this one is the project's own version in those two files (compared as parsed JSON,
// so a dependency's version changing in the lockfile is a difference). Anything else, an API
// that does not answer, a ref that is not main: the answer is no, and the gate runs as it
// always did. This script never fails the workflow; it only ever saves the gate a run.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { isMain } from "./is-main.mjs";

const VERSION_FILES = new Set(["package.json", "package-lock.json"]);
/** The release.yml jobs that make up the gate, as the Actions API names them. */
export const GATE_JOBS = ["verify lint, type-check, build", "verify tests (1/4)", "verify tests (2/4)", "verify tests (3/4)", "verify tests (4/4)"];

/**
 * A version file with the project's own version taken out: package.json's `version`, and
 * package-lock.json's `version` and `packages[""].version`. Nothing else: the lockfile has
 * a `version` for every dependency, and one of those changing is a real change.
 */
export function withoutOwnVersion(name, text) {
  const doc = JSON.parse(text);
  delete doc.version;
  if (name === "package-lock.json" && doc.packages?.[""]) delete doc.packages[""].version;
  return JSON.stringify(doc);
}

/** Whether a run's jobs (the Actions API's `jobs` array) include every gate job, each a success. */
export function gatePassed(jobs) {
  return GATE_JOBS.every((name) => jobs.some((j) => j.name === name && j.conclusion === "success"));
}

const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

/** Whether commit `from` is in HEAD's history and its tree differs from HEAD's only in the project's own version. */
export function sameButVersion(from, cwd = process.cwd()) {
  try {
    git(["merge-base", "--is-ancestor", from, "HEAD"], cwd);
  } catch {
    return false;
  }
  const changed = git(["diff", "--name-only", "--no-renames", from, "HEAD"], cwd).split("\n").filter(Boolean);
  for (const name of changed) {
    if (!VERSION_FILES.has(name)) return false;
    try {
      if (withoutOwnVersion(name, git(["show", `${from}:${name}`], cwd)) !== withoutOwnVersion(name, git(["show", `HEAD:${name}`], cwd))) return false;
    } catch {
      return false; // added, removed or not JSON: not a version bump
    }
  }
  return true;
}

async function getJson(url, token) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" } });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json();
}

/** The newest beta release run whose gate passed on a commit whose tree this one matches, or null. */
export async function findVerified({ api, repo, token, cwd, runs = 20 }) {
  const list = await getJson(`${api}/repos/${repo}/actions/workflows/release.yml/runs?branch=beta&event=push&per_page=${runs}`, token);
  for (const run of list.workflow_runs ?? []) {
    if (!sameButVersion(run.head_sha, cwd)) continue;
    const { jobs } = await getJson(`${run.jobs_url}?per_page=100`, token);
    if (gatePassed(jobs ?? [])) return { sha: run.head_sha, url: run.html_url };
  }
  return null;
}

async function main() {
  const out = (k, v) => {
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`);
  };
  if (process.env.GITHUB_REF !== "refs/heads/main") {
    console.log(`${process.env.GITHUB_REF ?? "no ref"} is not main: the gate runs.`);
    out("verified", "false");
    return;
  }
  try {
    const found = await findVerified({
      api: process.env.GITHUB_API_URL ?? "https://api.github.com",
      repo: process.env.GITHUB_REPOSITORY,
      token: process.env.GH_TOKEN,
      cwd: process.cwd(),
    });
    if (found) {
      console.log(`::notice title=Gate::this tree passed the gate on beta at ${found.sha.slice(0, 8)} (${found.url}), and differs from it only in the version, so it is not run again.`);
      out("verified", "true");
      out("sha", found.sha);
      out("url", found.url);
    } else {
      console.log("No beta run passed the gate on this tree, version aside: the gate runs.");
      out("verified", "false");
    }
  } catch (err) {
    console.log(`::warning title=Gate::could not tell whether beta verified this tree (${err instanceof Error ? err.message : String(err)}), so the gate runs.`);
    out("verified", "false");
  }
}

if (isMain(import.meta.url, process.argv[1])) await main();
