#!/usr/bin/env bash
# Prepare the working tree for EAS builds and OTA exports. Never publishes anything.
set -euo pipefail
if [ "$#" -ne 1 ]; then
  echo 'Usage: bash scripts/mobile-version.sh <vX.Y.Z[-nightly.N|-beta.N]|dev>' >&2
  exit 1
fi
tag=$1
if [ "$tag" = dev ]; then
  version=0.0.0-dev
elif [[ "$tag" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-(nightly|beta)\.(0|[1-9][0-9]*))?$ ]]; then
  version=${tag#v}
else
  echo 'Expected a Canopy release tag (stable, beta or nightly), or dev.' >&2
  exit 1
fi
mobile=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../apps/mobile" && pwd)
trap 'rm -f "$mobile/app.json.tmp" "$mobile/canopy-version.json.tmp"' EXIT
# App stores need three numbers; JS keeps the complete release version, including its channel.
jq --arg version "${version%%-*}" '.expo.version = $version' "$mobile/app.json" > "$mobile/app.json.tmp"
jq -n --arg version "$version" '{version: $version}' > "$mobile/canopy-version.json.tmp"
mv "$mobile/app.json.tmp" "$mobile/app.json"
mv "$mobile/canopy-version.json.tmp" "$mobile/canopy-version.json"
