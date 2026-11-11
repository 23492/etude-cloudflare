#!/usr/bin/env bash
# Points the Etude build at our own Sync server instead of sync.etude.study.
# Usage: scripts/patch-etude.sh <etude-checkout> <sync-url>
set -euo pipefail
dir="$1"; url="${2%/}"
cd "$dir"
files=(src/core/account.ts src/core/telemetry.ts web/src/components/settings-sync.tsx web/src/components/onboarding.tsx web/src/components/settings-account.tsx)
for f in "${files[@]}"; do
  grep -q 'https://sync.etude.study' "$f" || { echo "patch target moved: $f no longer mentions sync.etude.study" >&2; exit 1; }
  sed -i "s#https://sync.etude.study#${url}#g; s#Leave empty for sync.etude.study#Leave empty for ${url}#g" "$f"
done
echo "patched ${#files[@]} files -> $url"
