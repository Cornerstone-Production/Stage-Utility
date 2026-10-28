// pinned-line-ends.ts — put back a pinned file that differs from git only in its
// line ends.
//
// .gitattributes marks some files `-text`: checked out as their exact bytes,
// whatever core.autocrlf says, because the release signs those bytes (see the
// comment in .gitattributes). A checkout made before that attribute existed, on a
// machine with core.autocrlf=true (Git for Windows' default), already has such a
// file with CRLF line ends, and git rewrites a file on checkout only when its blob
// changed. So the file stays CRLF, `git status` calls the tree dirty, and the
// updater refuses every update and track switch from then on.
//
// This finds each modified file that is pinned `-text` and differs from the index
// by nothing but a CR at the end of its lines, and checks it out again. A file
// with any other change is left alone: that is the operator's edit, and the
// dirty-tree refusal after this still says so.

/** Runs one git command in the checkout; throws when git exits non-zero. */
export type GitRunner = (args: string[]) => Promise<string>;

/** Check out again every pinned file whose only difference is its line ends.
 *  Returns the paths it restored. A git failure on a path leaves that path as
 *  it was, and the dirty-tree check that follows reports the tree. */
export async function restorePinnedLineEnds(git: GitRunner): Promise<string[]> {
  const restored: string[] = [];
  // Modified in the working tree against the index, one path a line. Not
  // `status --porcelain`, whose leading space a trimmed answer loses.
  const modified = (await git(["diff", "--name-only", "--diff-filter=M"])).split("\n").map((l) => l.trim()).filter(Boolean);
  for (const file of modified) {
    const attr = await git(["check-attr", "text", "--", file]);
    if (!attr.trim().endsWith(": text: unset")) continue;
    // Exit 0: the working tree and the index differ only by CRs at line ends.
    // Exit 1 (a throw here) is a real change, which is not this function's to undo.
    const onlyLineEnds = await git(["diff", "--quiet", "--ignore-cr-at-eol", "--", file]).then(
      () => true,
      () => false,
    );
    if (!onlyLineEnds) continue;
    await git(["checkout", "--", file]);
    restored.push(file);
  }
  return restored;
}
