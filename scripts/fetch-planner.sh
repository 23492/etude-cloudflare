#!/usr/bin/env bash
# Copies the certification planner from dsh-etude (cert/kit/planner) at the commit pinned in planner.ref into
# sync-worker/src/planner.js and sync-worker/test/planner/, so there is one copy of the code (in dsh-etude).
# Also packs the etude-cert skill (dsh-etude cert/) as sync-worker/public/skills/etude-cert.zip, served at
# /skills/etude-cert.zip for Claude Desktop, claude.ai and Claude Code (Settings, Capabilities, Skills, upload).
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
mkdir -p "$here/sync-worker/public/skills"
rm -f "$here/sync-worker/public/skills/etude-cert.zip"
python3 - "$tmp/cert" "$here/sync-worker/public/skills/etude-cert.zip" <<'PY'
import os, sys, zipfile
src, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for root, dirs, files in os.walk(src):
        dirs[:] = sorted(d for d in dirs if d != "__pycache__")
        for f in sorted(files):
            if f.endswith(".pyc"): continue
            full = os.path.join(root, f)
            z.write(full, os.path.join("etude-cert", os.path.relpath(full, src)))
PY
echo "planner and skill from dsh-etude@${ref:0:7}"
