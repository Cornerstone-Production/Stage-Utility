# Beta-only overrides

One JSON file per release, named for the version exactly as the tag spells it
without the `v`: `1.18.0.json` is read when generating the notes for `v1.18.0`,
and never otherwise.

Each file is an array. Each entry corrects the `Beta-only:` decision in one
commit that is already on `beta` and can therefore no longer be edited:

```json
[
  {
    "commit": "c9d5c299",
    "betaOnly": true,
    "reason": "The body says all five findings are in code from this branch, and the trailer was never added."
  },
  {
    "commit": "c1d60219",
    "betaOnly": false,
    "reason": "v1.17.1 ships the same bug in its default configuration, so the trailer deletes a real fix."
  }
]
```

`commit` is a SHA of seven characters or more — never a branch or a tag, which
can move. `betaOnly` is the decision the commit should have carried — `true` holds the fix
out of the stable release's **Fixed** list and into the held-back count, `false`
puts it in. `reason` is required, and is printed to the release log when the
override is applied.

Anything wrong here fails the release rather than generating notes without it.
See [Correcting a trailer after the commit is on `beta`](../../contributing.md#correcting-a-trailer-after-the-commit-is-on-beta).

`STAGE_UTILITY_RELEASE_NOTES_DIR` points the generator at a different
`release-notes` directory, overrides and notices together. It exists so the
tests can put fixtures somewhere private instead of in this one; the release
workflow does not set it, and an override placed anywhere but here is not read.
