#!/usr/bin/env bash
# ShellCheck over every shell script in the repo.
#
#   scripts/lint-shell.sh
#
# CI (.github/workflows/shellcheck.yml) calls this rather than carrying its own
# file list, so the check you run here is the check that runs there.
#
# A script is every tracked `*.sh`, plus any tracked file with no extension whose
# first line is a shell shebang (scripts/stage-upgrade). ShellCheck reads the
# dialect from each script's own shebang, so the POSIX installers are checked as
# `sh` and the bash scripts as `bash` with no flag from here. A script run through
# `curl | sh` must therefore carry a `#!/bin/sh` shebang: with a bash one it would
# be checked as bash and run as dash.
#
# A suppression has to name the check it silences, with the reason after it. A
# disable that names no SCxxxx code (`all`, a range, a bare `=`) fails here before
# ShellCheck gets a say, and so does a .shellcheckrc, which would switch a check off
# for every script at once.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

command -v shellcheck >/dev/null || {
  echo "shellcheck is not installed (brew install shellcheck, or apt install shellcheck)" >&2
  exit 127
}

files=()
while IFS= read -r f; do
  [[ -f $f && ! -L $f ]] || continue
  case "${f##*/}" in
    *.sh) files+=("$f") ;;
    *.*) ;;
    *)
      first=$(head -n 1 "$f" | LC_ALL=C tr -d '\0' || true)
      [[ $first =~ ^#!.*[/\ ](ba|da|k)?sh([\ ]|$) ]] && files+=("$f")
      ;;
  esac
done < <(git ls-files)

# A discovery that finds nothing would pass every run, which is the one result a
# linter must never give for the wrong reason.
if [[ ${#files[@]} -eq 0 ]]; then
  echo "no shell scripts found: refusing to report a vacuous pass" >&2
  exit 1
fi
echo "shellcheck $(shellcheck --version | sed -n 's/^version: //p') over ${#files[@]} scripts"

status=0

# Only a code-named disable passes. `|| true`: grep exits 1 when nothing is wrong.
loose=$(grep -nE '#[[:space:]]*shellcheck[[:space:]].*disable=' "${files[@]}" \
  | grep -vE 'disable=SC[0-9]{4}(,SC[0-9]{4})*([^0-9A-Za-z,]|$)' || true)
if [[ -n $loose ]]; then
  echo "A shellcheck disable must name the check it silences (disable=SCxxxx):" >&2
  echo "$loose" >&2
  status=1
fi

# Not `git ls-files | grep -q`: under pipefail grep's early exit can kill git with
# SIGPIPE and the pipeline then reads as "not found".
if [[ -n $(git ls-files -- .shellcheckrc '*/.shellcheckrc') ]]; then
  echo "A .shellcheckrc is not allowed: suppress at the line, naming the check." >&2
  status=1
fi

shellcheck "${files[@]}" || status=1

# On a runner, also say it where the reviewer is looking: an annotation on the
# line in the PR diff, not only a log to open.
if [[ $status -ne 0 && -n ${GITHUB_ACTIONS:-} ]] && command -v jq >/dev/null; then
  shellcheck -f json1 "${files[@]}" \
    | jq -r '.comments[] | "::\(if .level == "error" then "error" elif .level == "warning" then "warning" else "notice" end) file=\(.file),line=\(.line),col=\(.column),title=ShellCheck SC\(.code)::\(.message)"' \
    || true
fi

exit "$status"
