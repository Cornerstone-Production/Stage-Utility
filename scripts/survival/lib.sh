# shellcheck shell=bash
#
# lib.sh — the wait shared by run-linux.sh and run-macos.sh.
#
# SOURCED, never executed. No shebang and no `set` line: the callers set their
# own options and this file must not fight them.
#
# It is here because the wait was copy-pasted between the two shell runners,
# comment and all, and the deadline then lived in three places. run-windows.ps1
# keeps its own copy — PowerShell cannot source a bash file — so the numbers
# below and the ones at run-windows.ps1:52 have to be changed together. Two
# places is the floor without rewriting a runner in another language.

# How long a child has to appear, and how often to look.
SPAWN_DEADLINE_SECONDS=60
SPAWN_POLL_SECONDS=0.25

# Wait for the CHILD TO EXIST, rather than guessing how long that takes.
#
# `sleep 4` was a budget, not a condition: on a slow runner the parent had
# written PARENT-START and not yet reached its spawn, so the teardown hit a
# parent with no child, nothing could survive, and the run failed exactly as a
# real survival failure does. Windows hit that twice in a row. PARENT-SPAWNED is
# the precondition the test needs -- there IS a detached child to outlive the
# teardown -- so all three platforms wait for it.
#
# PARENT-SPAWN-FAILED (parent.mjs:40) ends the wait immediately. The child is
# never coming, and burning the full deadline on a question already answered
# just delays the diagnosis by a minute per case.
#
# $1 = the survival log. Returns 0 once the child exists, 1 otherwise.
wait_for_spawn() {
  local deadline
  deadline=$(( $(date +%s) + SPAWN_DEADLINE_SECONDS ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if grep -q "PARENT-SPAWNED" "$1" 2>/dev/null; then return 0; fi
    if grep -q "PARENT-SPAWN-FAILED" "$1" 2>/dev/null; then return 1; fi
    sleep "$SPAWN_POLL_SECONDS"
  done
  return 1
}

# WHY there is no child, in the words the report uses.
#
# The three answers need three different fixes, and "no child was spawned"
# named none of them: a service that never ran at all, one that ran and never
# reached its spawn, and one whose spawn threw. run-windows.ps1 already branched
# the first two ($how, :64); this adds the third and gives the shell runners
# both.
#
# $1 = the survival log.
spawn_diagnosis() {
  local failed
  failed=$(grep "PARENT-SPAWN-FAILED" "$1" 2>/dev/null || true)
  if [ -n "$failed" ]; then
    # The message parent.mjs caught, carried through rather than swallowed —
    # it is the only description of the actual error anyone gets.
    echo "started but could not spawn its child: ${failed#PARENT-SPAWN-FAILED }"
  elif grep -q "PARENT-START" "$1" 2>/dev/null; then
    echo "started but never spawned its child within ${SPAWN_DEADLINE_SECONDS}s"
  else
    echo "never started, within ${SPAWN_DEADLINE_SECONDS}s"
  fi
}

# The whole INCONCLUSIVE report. Deliberately a DIFFERENT message from a
# survival failure: nothing was ever torn down, so this says nothing about
# whether a child survives. Reported as a failure because the test did not run,
# not because the behaviour is wrong.
#
# $1 = platform name   $2 = what runs the parent there   $3 = the survival log.
report_no_spawn() {
  echo "  $1 survival: INCONCLUSIVE - the $2 $(spawn_diagnosis "$3")"
  echo "  Nothing was torn down, so this does not indicate a survival failure."
}
