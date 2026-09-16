#!/usr/bin/env bash
# The highest release level among the commits in a git range: major, minor,
# patch or none. The release workflow reads it to decide whether to release and
# at what level; scripts/release-notes.test.ts drives it over a fixture history.
#
#   scripts/release-level.sh v1.17.1..HEAD
#   scripts/release-level.sh            # the whole history
#
# A feat, fix or perf scoped to the project's own machinery (the list in
# main/services/internal-scopes.json, shared with the notes generator and the
# update dialog) changes nothing an operator can see, so it neither triggers a
# release nor picks its level. A breaking change counts whatever its scope.
set -euo pipefail

range="${1:-}"
root="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
internal=$(node -p "require('$root/main/services/internal-scopes.json').scopes.join('|')")

subjects=$(git log --no-merges --format='%s' ${range:+"$range"})
bodies=$(git log --no-merges --format='%b' ${range:+"$range"})
# `|| true`: grep -v exits 1 when it filters everything out, which under
# pipefail would read as the script failing rather than as "nothing visible".
visible=$(grep -viE "^(feat|fix|perf)\(($internal)\):" <<<"$subjects" || true)

if grep -qE '^(feat|fix|perf|refactor|docs|test|build|ci|chore)(\([^)]+\))?!:' <<<"$subjects" \
   || grep -q 'BREAKING CHANGE' <<<"$bodies"; then echo major
elif grep -qE '^feat(\([^)]+\))?:' <<<"$visible"; then echo minor
elif grep -qE '^(fix|perf)(\([^)]+\))?:' <<<"$visible"; then echo patch
else echo none
fi
