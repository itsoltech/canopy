#!/usr/bin/env bash
# Sourced by the stage launchers. PostgreSQL uses its own swap-disabled user scope.
diagnostics_scope() {
  exec systemd-run --user --scope --quiet \
    --unit="canopy-diagnostics-stage${CANOPY_BENCH_STAGE}-$$" \
    -p MemorySwapMax=0 -- "$@"
}

# Keep exec inside the owned child, forwarding cancellation before running the postlude.
diagnostics_recording() {
  task_recording_output=$1
  shift
  diagnostics_scope "$@" >"$task_recording_output/results.jsonl" 2>"$task_recording_output/stderr.log" &
  task_scope_pid=$!
  trap 'kill -TERM "$task_scope_pid" 2>/dev/null || true; wait "$task_scope_pid" || true; exit 143' INT TERM
  wait "$task_scope_pid"
  trap - INT TERM
  bun scripts/bench/diagnostics-paired-report.ts "$task_recording_output/results.jsonl" >"$task_recording_output/paired-report.json"
}
