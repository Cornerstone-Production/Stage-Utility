#!/usr/bin/env bash
# The highest release level among the commits in a git range: major, minor,
# patch or none. The release workflow reads it to decide whether to release and
# at what level; scripts/release-notes.test.ts and scripts/commit-types.test.ts
# drive it over a fixture history.
#
#   scripts/release-level.sh v1.17.1..HEAD
#   scripts/release-level.sh            # the whole history
#
# Each type's level is in main/services/commit-types.json. A minor or patch type
# scoped to the project's own machinery (the list in
# main/services/internal-scopes.json, shared with the notes generator and the
# update dialog) changes nothing an operator can see, so it neither triggers a
# release nor picks its level. A breaking change counts whatever its scope.
set -euo pipefail

range="${1:-}"
root="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
# By assignment, so `set -e` acts on node's own exit status. A revert is not
# breakable: it has no `!` form, and `git revert` writes its own subject.
config=$(node -p "
const scopes = require('$root/main/services/internal-scopes.json').scopes;
const t = require('$root/main/services/commit-types.json');
[scopes, t.minor, t.patch, [...t.minor, ...t.patch, ...t.invisible]].map((a) => a.join('|')).join('\n')")
{ read -r internal; read -r minor; read -r patch; read -r breakable; } <<<"$config"

subjects=$(git log --no-merges --format='%s' ${range:+"$range"})
bodies=$(git log --no-merges --format='%b' ${range:+"$range"})
# `|| true`: grep -v exits 1 when it filters everything out, which under
# pipefail would read as the script failing rather than as "nothing visible".
visible=$(grep -viE "^($minor|$patch)\(($internal)\):" <<<"$subjects" || true)

if grep -qE "^($breakable)(\([^)]+\))?!:" <<<"$subjects" \
   || grep -q 'BREAKING CHANGE' <<<"$bodies"; then echo major
elif grep -qE "^($minor)(\([^)]+\))?:" <<<"$visible"; then echo minor
elif grep -qE "^($patch)(\([^)]+\))?:" <<<"$visible"; then echo patch
else echo none
fi
