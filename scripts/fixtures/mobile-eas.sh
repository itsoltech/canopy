#!/usr/bin/env bash
# Offline EAS boundary for release-policy tests. Never forwards a command to the real CLI.
set -euo pipefail
shift # pinned EAS package argument passed to bunx
command=$1
shift
platform=ios
runtime=false
status=
key=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --platform) platform=$2; shift ;;
    --runtime-version) runtime=true; shift ;;
    --status) status=$2; shift ;;
    --private-key-path) key=$2; shift ;;
  esac
  shift
done
case "$command" in
  channel:list) response=channels ;;
  channel:view) response=mapping ;;
  fingerprint:generate) response="fingerprint-$platform" ;;
  build:list)
    if [ "$runtime" = false ]; then response=baseline
    elif [ "$platform" = android ]; then response=android
    elif [ "$status" = finished ]; then response=ios
    else response=pending; fi ;;
  update:list)
    if [ "$runtime" = true ]; then response="updates-$platform"; else response=recent; fi ;;
  update:view) response=group ;;
  update)
    [ -z "${EXPO_UPDATES_PRIVATE_KEY+x}" ]
    [ "$(stat -c %a "$key")" = 600 ]
    printf '%s' "$key" > "$CANOPY_MOBILE_TEST_RESPONSES/key-path"
    exit 12 ;;
  *) echo 'Unexpected EAS mutation or command in offline test.' >&2; exit 99 ;;
esac
[ "$response" != "${CANOPY_MOBILE_TEST_FAIL:-}" ] || exit 10
cat "$CANOPY_MOBILE_TEST_RESPONSES/$response.json"
