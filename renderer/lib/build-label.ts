import type { UpdateStatus } from "@main/types/stage.js";

/**
 * The whole build identity, for the sidebar's truncated version label: version,
 * track, commit and date.
 *
 * That combination is what gets asked for when something needs diagnosing, and
 * having it on a hover saves opening Advanced to read it.
 *
 * Parts the server did not report are skipped rather than rendered as blanks — a
 * machine that is not a git checkout has no branch or commit, and a label reading
 * "v1.6.0 ·  · " is worse than one reading "v1.6.0". With nothing known at all the
 * result is empty, which leaves the label with no tooltip rather than an empty one.
 */
export function buildLabel(s: UpdateStatus | null | undefined): string {
  if (!s?.version) return "";
  const parts = [`v${s.version}`];
  if (s.branch) parts.push(s.branch);
  if (s.currentSha) parts.push(s.currentSha);
  if (s.currentDate) {
    const d = new Date(s.currentDate);
    if (!Number.isNaN(d.getTime())) parts.push(d.toLocaleDateString());
  }
  return parts.join(" · ");
}
