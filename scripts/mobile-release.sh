#!/usr/bin/env bash
# Release planner only: reads EAS state, sets the tag version, emits build/ota outputs. Run in apps/mobile.
set -euo pipefail

: "${CHANNEL:?}" "${PROFILE:?}" "${TAG:?}" "${MARKETING:?}" "${HEAD_SHA:?}" "${GITHUB_OUTPUT:?}"
EAS_CLI=${EAS_CLI:-eas-cli@27.4.1}
case "$CHANNEL:$PROFILE" in
  nightly:production|beta:production-beta|stable:production-stable) ;;
  *) echo 'Channel and build profile do not match.' >&2; exit 1 ;;
esac
message="Canopy $TAG ($HEAD_SHA)"
echo "message=$message" >> "$GITHUB_OUTPUT"

eas() { bunx "$EAS_CLI" "$@" --json --non-interactive; }

# Only delivered builds advance the change baseline. A queued or failed build still needs recovery.
builds=$(eas build:list --platform ios --channel "$CHANNEL" --distribution store --status finished --limit 1)
last_build=$(jq -r '.[0].gitCommitHash // empty' <<< "$builds")
last_runtime=$(jq -r '.[0].runtimeVersion // empty' <<< "$builds")

# The publisher owns all update-service reads as well as writes, for a future server swap.
# No delivered build on this channel yet (first release with OTA): nothing can have been published to it.
last_update=
[ -z "$last_runtime" ] || last_update=$(bash ../../scripts/mobile-publish-update.sh latest "$last_runtime")
last=$last_build
if [ -n "$last_update" ] && git cat-file -e "$last_update^{commit}" 2>/dev/null; then
  if [ -z "$last" ] || ! git cat-file -e "$last^{commit}" 2>/dev/null || git merge-base --is-ancestor "$last" "$last_update"; then
    last=$last_update
  fi
fi
if [ -n "$last" ] && git cat-file -e "$last^{commit}" 2>/dev/null; then
  if [ "$last_update" = "$HEAD_SHA" ] || { [ "$last" != "$HEAD_SHA" ] && git merge-base --is-ancestor HEAD "$last"; }; then
    echo 'This commit or a newer mobile release is already delivered; skipping.'; exit 0
  fi
  # A same-SHA native build can have succeeded after its parallel Android OTA step failed.
  if [ "$last" != "$HEAD_SHA" ] && [ "${FORCE:-false}" != true ] && git diff --quiet "$last" HEAD -- \
    . ../../packages/contracts ../../packages/domain ../../packages/ui ../../package.json ../../bun.lock \
    ../../scripts/mobile-release.sh ../../scripts/mobile-publish-update.sh ../../.github/workflows/mobile-testflight.yml; then
    echo "Nothing the mobile app uses changed since ${last:0:8}; skipping."; exit 0
  fi
fi

# The same marketing version, profile environment and fingerprint policy must reach build and update.
jq --arg v "$MARKETING" '.expo.version = $v' app.json > app.json.tmp
mv app.json.tmp app.json
ios=$(eas fingerprint:generate --platform ios --build-profile "$PROFILE" | jq -er '.hash | select(test("^[a-f0-9]{40}$"))')
android=$(eas fingerprint:generate --platform android --build-profile "$PROFILE" | jq -er '.hash | select(test("^[a-f0-9]{40}$"))')
echo "Runtime fingerprints: iOS $ios, Android $android"

ios_build=$(eas build:list --platform ios --channel "$CHANNEL" --distribution store --runtime-version "$ios" --status finished --limit 1)
android_build=$(eas build:list --platform android --channel "$CHANNEL" --runtime-version "$android" --status finished --limit 1)
if [ "$(jq length <<< "$ios_build")" -eq 0 ]; then
  pending=$(eas build:list --platform ios --channel "$CHANNEL" --distribution store --runtime-version "$ios" --limit 50)
  if jq -e '.[] | select(.status != "ERRORED" and .status != "CANCELED" and .status != "FINISHED")' <<< "$pending" >/dev/null; then
    echo 'An iOS build for this runtime is already pending; not queuing another.'
  else
    echo 'build=true' >> "$GITHUB_OUTPUT"
  fi
fi

# iOS decides whether it needs a build. Android can receive OTA even when iOS needs a new binary.
if [ "$(jq length <<< "$ios_build")" -eq 0 ] && [ "$(jq length <<< "$android_build")" -eq 0 ]; then
  echo 'No compatible installed runtime on this channel; OTA waits for a native build.'; exit 0
fi

published=$(MESSAGE="$message" bash ../../scripts/mobile-publish-update.sh status "$ios" "$android")
if [ "$published" = true ]; then
  echo 'Signed updates for both runtimes already exist; skipping publication.'
else
  echo 'ota=true' >> "$GITHUB_OUTPUT"
fi
