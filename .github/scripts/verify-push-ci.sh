#!/usr/bin/env bash
set -euo pipefail

case "$RELEASE_BRANCH" in
  dev) branches=() ;;
  next) branches=(dev) ;;
  main) branches=(dev next) ;;
  *) echo "Invalid release branch: $RELEASE_BRANCH" >&2; exit 1 ;;
esac
if [[ ! "$EXPECTED_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Expected a full commit SHA." >&2
  exit 1
fi

if [[ ${1:-} != --find-upstream ]]; then branches+=("$RELEASE_BRANCH"); fi
api="repos/$GITHUB_REPOSITORY/actions"
run=
for branch in "${branches[@]}"; do
  # Use the latest run, including failed and active attempts. A promotion points back
  # to the original channel's evidence even when that run still needs attention.
  run=$(gh api "$api/workflows/push-ci.yml/runs?event=push&branch=$branch&head_sha=$EXPECTED_SHA&per_page=1" |
    jq -r --arg repo "$GITHUB_REPOSITORY" --arg sha "$EXPECTED_SHA" --arg branch "$branch" '
      .workflow_runs[] | select(.event == "push" and .head_sha == $sha and .head_branch == $branch
        and .head_repository.full_name == $repo and .path == ".github/workflows/push-ci.yml") | .id')
  if [[ -n "$run" ]]; then break; fi
done
if [[ ${1:-} == --find-upstream ]]; then
  echo "upstream=$run" >> "$GITHUB_OUTPUT"
  exit 0
fi
if [[ -z "$run" ]]; then
  echo "::error::Missing Push CI for $EXPECTED_SHA on ${branches[*]}."
  exit 1
fi

url="$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$run"
echo "Checking Push CI for $EXPECTED_SHA at $url"
# A hotfix or back-merge can trigger both workflows at once. Only observe its existing run.
while :; do
  info=$(gh api "$api/runs/$run")
  state=$(jq -r 'if .status == "completed" then .conclusion else .status end' <<< "$info")
  case "$state" in
    success) break ;;
    queued|in_progress|waiting|pending|requested) sleep 20 ;;
    *)
      # Push CI recovery retries a failed first attempt once. Give it five minutes to queue the retry.
      retry=$(jq -r 'if .run_attempt == 1 and (.updated_at | type) == "string"
        then (.updated_at | fromdateiso8601) + 300 > now else false end' <<< "$info")
      if [[ "$retry" == true ]]; then
        sleep 20
        continue
      fi
      echo "::error::Push CI for $EXPECTED_SHA ended with '$state'. See $url"
      exit 1 ;;
  esac
done
# A workflow with entirely skipped jobs can be green. Require the aggregate that checks
# every shard report, static check, native build and smoke job on pushes.
aggregate=$(gh api --paginate "$api/runs/$run/jobs?filter=latest&per_page=100" |
  jq -r '.jobs[] | select(.name == "checks / Typecheck, tests, builds" and .status == "completed") | .conclusion')
if [[ "$aggregate" != success ]]; then
  echo "::error::Push CI did not pass the required checks for $EXPECTED_SHA. See $url"
  exit 1
fi
echo "Verified Push CI for \`$EXPECTED_SHA\` ([run $run]($url))." >> "$GITHUB_STEP_SUMMARY"
