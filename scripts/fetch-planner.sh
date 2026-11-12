#!/usr/bin/env bash
# Copies the certification planner from dsh-etude (cert/kit/planner) at the commit pinned in planner.ref into
# sync-worker/src/planner.js and sync-worker/test/planner/, so there is one copy of the code (in dsh-etude).
# Usage: scripts/fetch-planner.sh
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
ref="$(tr -d ' \n' < "$here/planner.ref")"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
git -C "$tmp" init -q
git -C "$tmp" remote add origin https://github.com/23492/dsh-etude.git
git -C "$tmp" fetch -q --depth 1 origin "$ref"
git -C "$tmp" checkout -q FETCH_HEAD
src="$tmp/cert/kit/planner"
cp "$src/src/planner.js" "$here/sync-worker/src/planner.js"
mkdir -p "$here/sync-worker/test/planner"
cp "$src/test/planner.test.mjs" "$src/test/d1shim.mjs" "$here/sync-worker/test/planner/"
sed -i 's#"../src/planner.js"#"../../src/planner.js"#' "$here/sync-worker/test/planner/planner.test.mjs"
echo "planner from dsh-etude@${ref:0:7}"
