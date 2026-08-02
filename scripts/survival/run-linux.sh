#!/usr/bin/env bash
#
# run-linux.sh — does the updater survive long enough to finish?
#
# Two cases, and the second matters as much as the first:
#
#   swap       nothing stops the unit, so the work finishes. This is the
#              shipped ordering: stage, swap, then signal the server last.
#   stopfirst  the unit is stopped mid-work, as a stop-first installer would.
#              systemd kills by CGROUP and setsid does NOT escape a cgroup, so
#              the work must die. That failure is the evidence that keeps
#              anyone from reintroducing a stop-first installer later.
#
# A stopfirst run that REPORTS SUCCESS is a failing test, not a passing one: it
# means the teardown is no longer reaching the process and the case has stopped
# proving anything.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
NODE="$(command -v node)"
UNIT="stage-survival-test"

stop_unit() { sudo systemctl stop "$UNIT" >/dev/null 2>&1 || true; }
# Logs are removed only on the way out, never between cases - a case creates its
# log and then stops any stale unit, so clearing logs in that step would delete
# the file the case is about to measure.
cleanup() { stop_unit; rm -f "$HERE"/.survival-*.log; }
trap cleanup EXIT

run_case() { # $1 = swap|stopfirst   $2 = expected yes|no
  local mode="$1" expect="$2" log got
  # NOT mktemp. systemd gives a unit its own view of /tmp and /var/tmp, so a
  # path there is unreachable from inside the service - the first CI run failed
  # with EACCES on the log while the unit itself was running perfectly, which
  # measured nothing. A file beside the checkout is visible to both.
  log="$HERE/.survival-$mode.log"
  rm -f "$log"
  : > "$log"
  chmod 666 "$log"

  stop_unit
  sudo systemd-run --unit="$UNIT" --setenv=SURVIVAL_LOG="$log" \
    "$NODE" "$HERE/parent.mjs" >/dev/null

  sleep 4
  if [ "$mode" = stopfirst ]; then
    sudo systemctl stop "$UNIT" >/dev/null 2>&1 || true
  fi
  sleep 14

  got=no
  grep -q FINISHED "$log" 2>/dev/null && got=yes
  stop_unit

  # Before trusting either verdict, prove the case measured anything at all.
  # "no FINISHED" is also what a log nobody could write to looks like - which is
  # exactly how two earlier CI runs reported a Linux failure that turned out to
  # be an unwritable /tmp path and no evidence about the update path whatsoever.
  # A case that cannot show the worker STARTED is a broken test, not a result.
  if ! grep -q "PARENT-START" "$log" 2>/dev/null; then
    echo "  case=$mode INVALID - the service never recorded starting"
    echo "  --- survival log ($(wc -c <"$log" | tr -d ' ') bytes) ---"; sed 's/^/    /' "$log"
    echo "  --- unit output ---"
    sudo journalctl -u "$UNIT" --no-pager --lines=25 2>&1 | tail -25 | sed 's/^/    /' || true
    return 1
  fi
  if ! grep -q "^START " "$log" 2>/dev/null; then
    echo "  case=$mode INVALID - the parent ran but the worker never started"
    echo "  --- survival log ---"; sed 's/^/    /' "$log"
    return 1
  fi

  echo "  case=$mode expected=$expect got=$got (worker started: yes)"
  if [ "$got" != "$expect" ]; then
    echo "  --- survival log ($(wc -c <"$log" | tr -d ' ') bytes) ---"
    sed 's/^/    /' "$log"
    # An empty log is ambiguous on its own: it could mean the worker was killed,
    # or that the unit never ran at all. These say which.
    echo "  --- unit state ---"
    sudo systemctl status "$UNIT" --no-pager --lines=0 2>&1 | head -6 | sed 's/^/    /' || true
    echo "  --- unit output ---"
    sudo journalctl -u "$UNIT" --no-pager --lines=25 2>&1 | tail -25 | sed 's/^/    /' || true
    if [ "$mode" = stopfirst ]; then
      echo "  stopfirst survived, which means the teardown is not reaching the"
      echo "  process. This case no longer proves anything - investigate before"
      echo "  trusting the swap case."
    fi
    return 1
  fi
}

run_case swap      yes
run_case stopfirst no
echo "  linux survival: both cases behaved as expected"
