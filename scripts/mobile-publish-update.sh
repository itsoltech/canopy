#!/usr/bin/env bash
# Update-service adapter: history/deduplication and publishing. Run in apps/mobile.
set -euo pipefail
: "${CHANNEL:?}"
case "$CHANNEL" in nightly|beta|stable) ;; *) echo 'Invalid release channel.' >&2; exit 1 ;; esac
EAS_CLI=${EAS_CLI:-eas-cli@27.4.1}
eas() { bunx "$EAS_CLI" "$@" --json --non-interactive; }

# Refuse aliases, paused channels and rollouts that could mix release channels.
channel_exists=false
validate_channel() {
  local offset=0 page mapping
  while :; do
    page=$(eas channel:list --limit 25 --offset "$offset")
    if jq -e --arg channel "$CHANNEL" '.currentPage[] | select(.name == $channel)' <<< "$page" >/dev/null; then
      channel_exists=true
      mapping=$(eas channel:view "$CHANNEL" --limit 25)
      jq -e --arg channel "$CHANNEL" '
        .currentPage | (.branchMapping | fromjson) as $mapping |
        .isPaused == false and (.updateBranches | length) == 1 and
        .updateBranches[0].name == $channel and ($mapping.data | length) == 1 and
        $mapping.data[0].branchId == .updateBranches[0].id and $mapping.data[0].branchMappingLogic == "true"
      ' <<< "$mapping" >/dev/null || { echo 'Channel must map exclusively to its same-name branch.' >&2; exit 1; }
      return
    fi
    [ "$(jq '.currentPage | length' <<< "$page")" -eq 25 ] || return 0
    offset=$((offset + 25))
  done
}

latest() {
  local runtime=$1 recent group update
  validate_channel
  [ "$channel_exists" = true ] || return 0
  recent=$(eas update:list --branch "$CHANNEL" --platform ios --limit 1)
  group=$(jq -r --arg runtime "$runtime" '.currentPage[0] |
    select(.runtimeVersion == $runtime and .codeSigningKey == "canopy-updates" and
    (.isRollBackToEmbedded | not) and (.rolloutPercentage == null or .rolloutPercentage == 100)) | .group // empty' <<< "$recent")
  [ -n "$group" ] || return 0
  update=$(eas update:view "$group")
  # An Android OTA during an unsuccessful iOS build must not hide the missing iOS delivery.
  jq -r 'select((map(.platform) | unique | sort) == ["android", "ios"]) | .[0].gitCommitHash // empty' <<< "$update"
}

already_published() {
  local platform=$1 runtime=$2 offset=0 page
  while :; do
    page=$(eas update:list --branch "$CHANNEL" --platform "$platform" --runtime-version "$runtime" --limit 50 --offset "$offset") || exit 1
    if jq -e --arg message "\"$MESSAGE\" " '.currentPage[] |
      select(.codeSigningKey == "canopy-updates" and (.isRollBackToEmbedded | not) and (.message | startswith($message)))' <<< "$page" >/dev/null; then
      return 0
    fi
    [ "$(jq '.currentPage | length' <<< "$page")" -eq 50 ] || return 1
    offset=$((offset + 50))
  done
}

case "${1:-publish}" in
  latest) latest "${2:?Runtime required}"; exit 0 ;;
  status)
    : "${MESSAGE:?}"
    if already_published ios "${2:?}" && already_published android "${3:?}"; then echo true; else echo false; fi
    exit 0 ;;
  publish) ;;
  *) echo 'Invalid update-service operation.' >&2; exit 1 ;;
esac
: "${MESSAGE:?}" "${EXPO_UPDATES_PRIVATE_KEY:?Missing update signing key}"
validate_channel
[ "$channel_exists" = true ] || { echo 'Build this channel before publishing updates.' >&2; exit 1; }
umask 077
mkdir -p ../../.tmp
key=$(mktemp ../../.tmp/expo-updates-key.XXXXXX)
trap 'rm -- "$key"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
printf '%s\n' "$EXPO_UPDATES_PRIVATE_KEY" > "$key"
unset EXPO_UPDATES_PRIVATE_KEY
bunx "$EAS_CLI" update --channel "$CHANNEL" --platform all --environment production \
  --message "$MESSAGE" --private-key-path "$key" --non-interactive
