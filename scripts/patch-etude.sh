#!/usr/bin/env bash
# Prepares an Etude checkout for this deployment:
#  1. points the Sync/account default at our own server instead of sync.etude.study
#  2. adds app-addon/autolink.js (automatic Sync sign-in via Cloudflare Access or a #link= magic link)
# Usage: scripts/patch-etude.sh <etude-checkout> <sync-url>
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
dir="$1"; url="${2%/}"
cd "$dir"
files=(src/core/account.ts src/core/telemetry.ts web/src/components/settings-sync.tsx web/src/components/onboarding.tsx web/src/components/settings-account.tsx)
for f in "${files[@]}"; do
  grep -q 'https://sync.etude.study' "$f" || { echo "patch target moved: $f no longer mentions sync.etude.study" >&2; exit 1; }
  sed -i "s#https://sync.etude.study#${url}#g; s#Leave empty for sync.etude.study#Leave empty for ${url}#g" "$f"
done
# autolink: copied into the public dir (served as <base>/autolink.js) and loaded after the app module.
cp "$here/app-addon/autolink.js" web/public/autolink.js
html=src/browser/index.html
grep -q 'type="module" src="./app-main.ts"' "$html" || { echo "patch target moved: $html has no app-main.ts module script" >&2; exit 1; }
grep -q 'autolink.js' "$html" || sed -i 's#\(<script type="module" src="./app-main.ts"></script>\)#\1\n    <script src="%BASE_URL%autolink.js" defer></script>#' "$html"
grep -q 'autolink.js' "$html" || { echo "autolink injection failed" >&2; exit 1; }
echo "patched ${#files[@]} files -> $url, autolink injected"
