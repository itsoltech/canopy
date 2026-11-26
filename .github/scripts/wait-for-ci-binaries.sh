#!/usr/bin/env bash
set -euo pipefail

jobs="repos/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID/jobs?filter=all&per_page=100"

# On a job rerun, the producer may have succeeded in an earlier attempt of this same run.
# When it is also being rerun, wait for its uploads to finish replacing the old artifacts.
while true; do
  status="$(gh api --paginate "$jobs" | jq -rs '
    [.[].jobs[] | select(.name == "Web and Linux binaries")]
    | max_by(.run_attempt)
    | if .status == "completed" then .conclusion else "pending" end
  ')"
  case "$status" in
    success) exit 0 ;;
    pending) sleep 10 ;;
    *)
      printf 'The binary build did not pass (%s).\n' "$status" >&2
      exit 1
      ;;
  esac
done
