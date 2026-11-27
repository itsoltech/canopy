#!/usr/bin/env bash
# Push CI recovery (docs/release.md). `rerun` retries the failed test jobs of a protected push once.
# `report` runs after a passing rerun and records the tests that failed in the first attempt as flaky.
set -euo pipefail

if [[ ! "$RUN_ID" =~ ^[0-9]+$ ]]; then
  echo "Expected a numeric run ID." >&2
  exit 1
fi

repo="repos/$GITHUB_REPOSITORY"
run_api="$repo/actions/runs/$RUN_ID"
aggregate="checks / Typecheck, tests, builds"
issue_title="Flaky tests in Push CI"
# Tests and smoke checks can fail without a source change. Static checks and builds are deterministic.
retryable='^checks / (Tests \([0-9]+/[0-9]+\)|push-native / Native checks \(.+\)|binary-smoke / .+|artifact-smoke / .+)$'

failed_jobs() {
  gh api --paginate "$run_api/attempts/1/jobs?per_page=100" --jq '
    .jobs[] | select(.conclusion | IN("failure", "timed_out", "cancelled", "startup_failure", "action_required"))
    | [.id, .conclusion, .name, .html_url] | @tsv'
}

rerun() {
  local failed id conclusion name url current retry=0
  failed=$(failed_jobs)

  while IFS=$'\t' read -r id conclusion name url; do
    if [[ -z "$id" || "$name" == "$aggregate" ]]; then continue; fi
    if [[ "$conclusion" != failure && "$conclusion" != timed_out ]] || [[ ! "$name" =~ $retryable ]]; then
      echo "Job '$name' ended with $conclusion and is not retried automatically."
      return 0
    fi
    retry=1
  done <<< "$failed"

  if (( ! retry )); then
    echo "No failed test job to retry."
    return 0
  fi

  # A manual rerun may have started while the jobs were read.
  current=$(gh api "$run_api" --jq '
    select(.path == ".github/workflows/push-ci.yml" and .event == "push" and .run_attempt == 1
      and .status == "completed" and .conclusion == "failure") | .id')
  if [[ "$current" != "$RUN_ID" ]]; then
    echo "Push CI run $RUN_ID changed after it failed. Leaving it as it is."
    return 0
  fi

  gh api --method POST "$run_api/rerun-failed-jobs" > /dev/null
  echo "Queued one retry of the failed test jobs in Push CI run $RUN_ID."
}

# Bun prints `(fail) <name> [<time>]` for each failed test, and again in the file summary.
failed_tests() {
  { gh api "$repo/actions/jobs/$1/logs" 2> /dev/null || true; } |
    sed -nE 's/^([0-9T:.Z-]+ )?\(fail\) (.+)$/\2/p' |
    sed -E 's/\r$//; s/ \[[0-9.]+m?s\]$//; s/`/'"'"'/g' |
    awk '!seen[$0]++' | head -20
}

flaky_issue() {
  local number
  number=$(gh api --paginate "$repo/issues?state=open&creator=github-actions%5Bbot%5D&per_page=100" \
    --jq ".[] | select(.pull_request == null and .title == \"$issue_title\") | .number" | head -1)
  if [[ -n "$number" ]]; then
    echo "$number"
    return
  fi

  gh api --method POST "$repo/issues" -f title="$issue_title" --jq .number -f body="Push CI on \`dev\`, \`next\` and \`main\` reruns failed test jobs once. \
Each comment lists tests that failed and then passed on the same commit. Fix them, then close this issue; the next flaky test opens a new one."
}

report() {
  local body id conclusion name url tests found=0
  body=$(mktemp)

  {
    printf 'Push CI for `%s` on `%s` failed in [attempt 1](%s) and passed when its failed jobs were rerun.\n\n' \
      "$HEAD_SHA" "$HEAD_BRANCH" "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$RUN_ID/attempts/1"

    while IFS=$'\t' read -r id conclusion name url; do
      if [[ -z "$id" || "$name" == "$aggregate" ]]; then continue; fi
      found=1
      printf -- '- [%s](%s), %s\n' "$name" "$url" "$conclusion"
      tests=$(failed_tests "$id")
      if [[ -z "$tests" ]]; then
        printf '  - No failed test in the log. The job itself failed.\n'
      else
        while IFS= read -r test; do printf '  - `%s`\n' "$test"; done <<< "$tests"
      fi
    done <<< "$(failed_jobs)"
  } > "$body"

  if (( ! found )); then
    echo "Attempt 1 has no failed job to report."
    return 0
  fi

  issue=$(flaky_issue)
  gh api --method POST "$repo/issues/$issue/comments" -F body=@"$body" > /dev/null
  cat "$body" >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
  echo "Reported the flaky jobs on issue #$issue."
}

case "${1:-}" in
  rerun) rerun ;;
  report) report ;;
  *) echo "Usage: push-ci-recovery.sh rerun|report" >&2; exit 1 ;;
esac
