#!/usr/bin/env bash
set -euo pipefail

scope=full
web=false
desktop=false
declare -A extra_tests=()

# Keep both paths of a rename and exclude commits made only on the base branch.
changes="$RUNNER_TEMP/changed-files"
git diff --no-renames --name-status -z "$BASE...$HEAD" > "$changes"
if [[ -s $changes ]]; then
  scope=docs
  while IFS= read -r -d '' status && IFS= read -r -d '' file; do
    case "$file" in
      .github/*) scope=full; break ;;
      *.md|docs/*.png|docs/*.jpg|docs/*.jpeg|docs/*.webp|docs/*.gif|docs/*.svg) continue ;;
    esac
    # Bun walks the current import graph. A removed module no longer has importers there.
    if [[ $status != A && $status != M ]]; then scope=full; break; fi

    case "$file" in
      apps/mobile/*|tests/integration/mobile-*.test.ts|tests/integration/*-mobile.test.ts|\
      scripts/mobile-release.sh|scripts/mobile-publish-update.sh|scripts/mobile-version.sh|\
      scripts/mobile-*.test.ts|scripts/fixtures/mobile-eas.sh)
        extra_tests[mobile]=1
        extra_tests[scripts/channel-identity.test.ts]=1 ;;
      apps/web/src/*.css) web=true ;;
      apps/web/src/*.svelte|apps/web/src/lib/shared/ui/*.ts)
        web=true
        extra_tests[tests/integration/web-secrets.test.ts]=1 ;;
      # These launch other processes and load the built BFF at runtime.
      apps/desktop/src/controller*.ts|apps/desktop/src/runtime/*|apps/desktop/src/sidecars/*) scope=full; break ;;
      apps/desktop/src/desktop-main.ts)
        desktop=true
        # The channel identity test reads this bootstrap as text.
        extra_tests[scripts/channel-identity.test.ts]=1 ;;
      apps/desktop/src/*.ts|apps/desktop/test/*.test.ts|tests/integration/desktop-*.test.ts) desktop=true ;;
      *) scope=full; break ;;
    esac
    case "$file" in
      apps/*/src/*.ts|apps/*/src/*.tsx|apps/*/src/*.js|apps/*/src/*.mjs|apps/*/src/*.svelte)
        extra_tests[tools/direct-inference.test.ts]=1 ;;
    esac
    scope=clients
  done < "$changes"
fi

{
  echo "scope=$scope"
  echo "web=$web"
  echo "desktop=$desktop"
  echo "extra_tests=${!extra_tests[*]}"
} >> "$GITHUB_OUTPUT"
