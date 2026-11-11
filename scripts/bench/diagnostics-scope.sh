#!/usr/bin/env bash
# Sourced by the stage launchers. PostgreSQL uses its own swap-disabled user scope.
diagnostics_scope() {
  exec systemd-run --user --scope --quiet \
    --unit="canopy-diagnostics-stage${CANOPY_BENCH_STAGE}-$$" \
    -p MemorySwapMax=0 -- "$@"
}
