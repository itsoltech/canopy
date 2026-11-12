#!/usr/bin/env bash
# Explicit forensic run only. Never part of the overhead gate; snapshots force GC.
set -euo pipefail
umask 077

task_repo=$(git -C "$(dirname -- "${BASH_SOURCE[0]}")/../.." rev-parse --show-toplevel)
cd -- "$task_repo"
task_stage=${1:-2}
task_phase=${2:-write_failure}
task_point=${3:-all}
case "$task_stage:$task_phase" in
  2:write_failure|2:write_failure_without_watches|3:write_failure|3:write_failure_without_watches)
    task_points=(before_lock lock_end released_twenty_seconds)
    ;;
  2:governor|3:governor) task_points=(before_governor end) ;;
  2:slow_reader|3:slow_reader) task_points=(end) ;;
  *) printf '%s\n' 'Usage: bash scripts/bench/diagnostics-retention.sh <2|3> <write_failure|write_failure_without_watches|governor|slow_reader> [all|checkpoint]' >&2; exit 1 ;;
esac
if [[ "$task_point" != all ]]; then
  case " ${task_points[*]} " in
    *" $task_point "*) task_points=("$task_point") ;;
    *) printf '%s\n' 'Checkpoint is not valid for this phase.' >&2; exit 1 ;;
  esac
fi
task_branch=feat/diagnostics-2-gateway
if [[ "$task_stage" == 3 ]]; then task_branch=feat/diagnostics-3-workers; fi
if [[ $(git branch --show-current) != "$task_branch" || -n $(git status --porcelain) ]]; then
  printf '%s\n' 'Use the selected stage branch with a clean committed revision.' >&2
  exit 1
fi
if [[ -n $(ss -H -ltn '( sport = :18191 or sport = :18192 )') ]]; then
  printf '%s\n' 'Private benchmark ports are occupied.' >&2
  exit 1
fi
command -v bun taskset git jq ss systemd-run systemctl >/dev/null
task_output=${CANOPY_DIAGNOSTICS_OUTPUT:-/var/tmp/canopy-diagnostics-retention-$(date -u +%Y%m%dT%H%M%SZ)}
mkdir -m 700 -- "$task_output"
git rev-parse HEAD >"$task_output/head.txt"
unset CANOPY_BENCH_RESOURCES CANOPY_BENCH_CHURN CANOPY_BENCH_EXTRA_PHASES CANOPY_BENCH_CONTENTION
unset CANOPY_BENCH_SHORT CANOPY_BENCH_ALL_PHASES CANOPY_BENCH_PROFILE_DIR
export CANOPY_BENCH_STAGE="$task_stage" CANOPY_BENCH_SMOKE=1 CANOPY_BENCH_SERIES=1
export CANOPY_BENCH_HISTORY=1 CANOPY_BENCH_VIEW=1 CANOPY_BENCH_CHECKPOINT=1 CANOPY_BENCH_COMPACTION=1
export CANOPY_BENCH_FORENSIC_PHASE="$task_phase" CANOPY_BENCH_FORENSIC_CHECKPOINTS=1
export CANOPY_BENCH_FORENSIC_FORMAT=jsc CANOPY_BENCH_IDLE_MS=30000 CANOPY_BENCH_LOAD_MS=90000
export CANOPY_BENCH_RETENTION_PROBE=${CANOPY_DIAGNOSTICS_RETENTION_PROBE:-1}
export CANOPY_BENCH_GATEWAY_CPU=${CANOPY_DIAGNOSTICS_GATEWAY_CPU:-2}
export CANOPY_BENCH_WORKER_CPU=${CANOPY_DIAGNOSTICS_WORKER_CPU:-3}
export CANOPY_BENCH_PG_CPU=${CANOPY_DIAGNOSTICS_PG_CPU:-4}
export CANOPY_BENCH_PG_PORT=18191 CANOPY_BENCH_GATEWAY_PORT=18192
printf '%s\n' "Private evidence: $task_output" 'One fresh A/B run per checkpoint; not an overhead acceptance run.'
for task_checkpoint in "${task_points[@]}"; do
  task_directory="$task_output/$task_checkpoint"
  mkdir -m 700 -- "$task_directory"
  export TMPDIR="$task_directory" CANOPY_BENCH_FORENSICS_DIR="$task_directory"
  export CANOPY_BENCH_FORENSIC_SNAPSHOT_POINT="$task_checkpoint"
  systemd-run --user --scope --quiet --unit="canopy-diagnostics-retention-$$-$task_checkpoint" \
    -p MemorySwapMax=0 -- taskset -c "${CANOPY_DIAGNOSTICS_DRIVER_CPU:-1}" bun scripts/bench/diagnostics-series.ts \
    >"$task_directory/results.jsonl" 2>"$task_directory/stderr.log"
  task_snapshot_phase=${task_phase%_without_watches}
  task_prefix="$task_snapshot_phase-$task_checkpoint"
  bun scripts/bench/diagnostics-heap-report.ts \
    "$task_directory/off-$task_prefix-after.heapsnapshot.json" \
    "$task_directory/on-$task_prefix-after.heapsnapshot.json" \
    >"$task_directory/retention-diff.json"
  jq -n --slurpfile a "$task_directory/off-$task_prefix.heap.json" \
    --slurpfile b "$task_directory/on-$task_prefix.heap.json" \
    '{off: $a[0], on: $b[0], postGcDelta: {heap: ($b[0].after.memory.heapUsed - $a[0].after.memory.heapUsed), rss: ($b[0].after.memory.rss - $a[0].after.memory.rss)}}' \
    >"$task_directory/post-gc.json"
done
