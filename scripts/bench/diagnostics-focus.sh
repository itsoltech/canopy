#!/usr/bin/env bash
# Explicit focused evidence only; never substitutes for full acceptance pairs.
set -euo pipefail
umask 077
task_repo=$(git -C "$(dirname -- "${BASH_SOURCE[0]}")/../.." rev-parse --show-toplevel)
cd -- "$task_repo"
task_stage=${1:?stage 2 or 3 required}
task_mode=${2:?pool, profile or dev-retention required}
case "$task_stage:$task_mode" in
  2:pool|3:pool|2:profile|3:profile|2:dev-retention) ;;
  *) printf '%s\n' 'Choose stage 2/3 and pool/profile; dev-retention requires stage 2.' >&2; exit 1 ;;
esac
if [[ -n $(git status --porcelain) || -n $(ss -H -ltn '( sport = :18191 or sport = :18192 )') ]]; then
  printf '%s\n' 'Use a committed revision and unused private benchmark ports.' >&2
  exit 1
fi
task_output=${CANOPY_DIAGNOSTICS_OUTPUT:?private evidence directory required}
mkdir -m 700 -- "$task_output"
git rev-parse HEAD >"$task_output/head.txt"
unset CANOPY_BENCH_SMOKE CANOPY_BENCH_RESOURCES CANOPY_BENCH_CHURN CANOPY_BENCH_EXTRA_PHASES
unset CANOPY_BENCH_PROFILE_DIR CANOPY_BENCH_FORENSIC_SNAPSHOT_POINT CANOPY_BENCH_RETENTION_PROBE
unset CANOPY_BENCH_CONTROL CANOPY_BENCH_FORENSIC_CHECKPOINTS CANOPY_BENCH_FORENSIC_PHASE
unset CANOPY_BENCH_FORENSICS_DIR CANOPY_BENCH_ONLY_PHASE CANOPY_BENCH_POOL_TRACE
export CANOPY_BENCH_STAGE="$task_stage" CANOPY_BENCH_SERIES=1 CANOPY_BENCH_SHORT=1
export CANOPY_BENCH_IDLE_MS=180000 CANOPY_BENCH_LOAD_MS=90000 CANOPY_BENCH_ALL_PHASES=1
export CANOPY_BENCH_HISTORY=1 CANOPY_BENCH_VIEW=1 CANOPY_BENCH_CHECKPOINT=1 CANOPY_BENCH_COMPACTION=1
export CANOPY_BENCH_GATEWAY_CPU=${CANOPY_DIAGNOSTICS_GATEWAY_CPU:-2}
export CANOPY_BENCH_WORKER_CPU=${CANOPY_DIAGNOSTICS_WORKER_CPU:-3}
export CANOPY_BENCH_PG_CPU=${CANOPY_DIAGNOSTICS_PG_CPU:-4}
export CANOPY_BENCH_PG_PORT=18191 CANOPY_BENCH_GATEWAY_PORT=18192 TMPDIR="$task_output"
task_driver=scripts/bench/diagnostics-series.ts
case "$task_mode" in
  pool)
    unset CANOPY_BENCH_SOURCE_ROOT
    export CANOPY_BENCH_ONLY_PHASE=pool_contention CANOPY_BENCH_POOL_TRACE=1
    export CANOPY_BENCH_BLOCKED_UPDATES=${3:-8}
    ;;
  profile)
    unset CANOPY_BENCH_SOURCE_ROOT CANOPY_BENCH_BLOCKED_UPDATES
    export CANOPY_BENCH_ONLY_PHASE=steady CANOPY_BENCH_FORENSICS_DIR="$task_output"
    export CANOPY_BENCH_LOAD_MS=30000
    ;;
  dev-retention)
    : "${CANOPY_BENCH_SOURCE_ROOT:?isolated dev checkout required}"
    export CANOPY_BENCH_FORENSICS_DIR="$task_output" CANOPY_BENCH_FORENSIC_PHASE=write_failure
    export CANOPY_BENCH_FORENSIC_CHECKPOINTS=1 CANOPY_BENCH_FORENSIC_SNAPSHOT_POINT=lock_end
    # Intentionally reproduce the old shared-cluster driver, both gateways use dev.
    export CANOPY_BENCH_SMOKE=1
    task_driver=scripts/bench/diagnostics.ts
    ;;
esac
printf '%s\n' "Focused evidence: $task_output (not an overhead acceptance run)"
systemd-run --user --scope --quiet --unit="canopy-diagnostics-focus-$$" -p MemorySwapMax=0 -- \
  taskset -c "${CANOPY_DIAGNOSTICS_DRIVER_CPU:-1}" bun "$task_driver" \
  >"$task_output/results.jsonl" 2>"$task_output/stderr.log"
