#!/usr/bin/env bash
# Run manually after the maintainer confirms a quiet host. Never schedules a recording.
set -euo pipefail

task_repo=$(git -C "$(dirname -- "${BASH_SOURCE[0]}")/../.." rev-parse --show-toplevel)
task_output=${CANOPY_DIAGNOSTICS_OUTPUT:-/var/tmp/canopy-diagnostics-3/measure-$(date -u +%Y%m%dT%H%M%SZ)}
cd -- "$task_repo"
if [[ $(git branch --show-current) != feat/diagnostics-3-workers ]]; then
  printf '%s\n' 'Use the diagnostics stage 3 branch.' >&2
  exit 1
fi
if [[ -n $(git status --porcelain) ]]; then
  printf '%s\n' 'Commit or stash changes before measuring an immutable revision.' >&2
  exit 1
fi
if [[ -n $(ss -H -ltn '( sport = :18191 or sport = :18192 )') ]]; then
  printf '%s\n' 'Benchmark ports 18191/18192 are occupied; do not stop another stack.' >&2
  exit 1
fi
command -v bun taskset vmstat git jq ss systemd-run systemctl >/dev/null
source scripts/bench/diagnostics-scope.sh
mkdir -p -- "$task_output"
git rev-parse HEAD >"$task_output/head.txt"
bun --version >"$task_output/bun-version.txt"
lscpu -e=CPU,CORE,SOCKET,ONLINE >"$task_output/topology.txt"
cat /proc/loadavg >"$task_output/load-before.txt"

task_priority=()
if nice -n -5 true 2>"$task_output/nice-probe.log" && [[ ! -s "$task_output/nice-probe.log" ]]; then
  task_priority=(nice -n -5)
fi
unset CANOPY_BENCH_SMOKE CANOPY_BENCH_RESOURCES CANOPY_BENCH_PROFILE_DIR
unset CANOPY_BENCH_CHURN CANOPY_BENCH_EXTRA_PHASES CANOPY_BENCH_CONTENTION
unset CANOPY_BENCH_FORENSICS_DIR CANOPY_BENCH_FORENSIC_PHASE
unset CANOPY_BENCH_FORENSIC_CHECKPOINTS
unset CANOPY_BENCH_FORENSIC_SNAPSHOT_POINT
unset CANOPY_BENCH_FORENSIC_FORMAT CANOPY_BENCH_RETENTION_PROBE
unset CANOPY_BENCH_ONLY_PHASE CANOPY_BENCH_SOURCE_ROOT CANOPY_BENCH_BLOCKED_UPDATES CANOPY_BENCH_POOL_TRACE
export CANOPY_BENCH_CONTROL=${CANOPY_DIAGNOSTICS_CONTROL:-0}
export CANOPY_BENCH_SERIES=4
if [[ $CANOPY_BENCH_CONTROL == 1 ]]; then export CANOPY_BENCH_SERIES=2; fi
export CANOPY_BENCH_STAGE=3
export TMPDIR="$task_output"
export CANOPY_BENCH_SHORT=1
export CANOPY_BENCH_IDLE_MS=180000
export CANOPY_BENCH_LOAD_MS=90000
export CANOPY_BENCH_ALL_PHASES=1
export CANOPY_BENCH_HISTORY=1
export CANOPY_BENCH_VIEW=1
export CANOPY_BENCH_CHECKPOINT=1
export CANOPY_BENCH_COMPACTION=1
export CANOPY_BENCH_GATEWAY_CPU=${CANOPY_DIAGNOSTICS_GATEWAY_CPU:-2}
export CANOPY_BENCH_WORKER_CPU=${CANOPY_DIAGNOSTICS_WORKER_CPU:-3}
export CANOPY_BENCH_PG_CPU=${CANOPY_DIAGNOSTICS_PG_CPU:-4}
export CANOPY_BENCH_PG_PORT=18191
export CANOPY_BENCH_GATEWAY_PORT=18192
printf '%s\n' "Revision: $(cat "$task_output/head.txt")" "Evidence: $task_output" "Controller PID: $$"
if [[ $CANOPY_BENCH_CONTROL == 1 ]]; then
  printf '%s\n' 'Control: two A/A pairs, stages 1/2 on, stage 3 off in all four fresh members (~55 minutes).'
else
  printf '%s\n' 'Order: AB / BA / AB / BA (A=stage 3 off, B=on; stages 1 and 2 on throughout).'
fi
printf '%s\n' 'Worker load: real journal, ACK/replay, deterministic ACP turns and git; no inference.'
printf '%s\n' 'Workload: 96 minutes; approximately 110 minutes with fresh clusters and startup, longer after rejected pairs.'
diagnostics_recording "$task_output" "${task_priority[@]}" taskset -c "${CANOPY_DIAGNOSTICS_DRIVER_CPU:-1}" bun scripts/bench/diagnostics-series.ts
