#!/usr/bin/env bash
# Produces _diag/evidence/results/privacy-canary-evidence.txt from scratch:
#   * the privacy-canary suite against the FIXED worker and against the PRE-FIX worker
#     (every assertion inspects the captured FINAL HTTP payload, not scrubAddresses() alone)
#   * the differential (pre-fix vs fixed) with the privacy fixes pinned
#   * the residual payload trace on the fixed tree
#   * the full gate matrix on the fixed tree
# Usage: bash _diag/evidence/run-privacy-canary-evidence.sh <pre-fix-worker.js>
set -u
PRE="${1:?usage: run-privacy-canary-evidence.sh <pre-fix-worker.js>}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/_diag/evidence/results/privacy-canary-evidence.txt"
SANDBOX="$(mktemp -d /tmp/privacy-canary-XXXX)"
# نفس وصفة الأدلة السابقة: نسخة كاملة من الشجرة ثم استبدال الـworker بالنسخة القديمة
tar -C "$ROOT" --exclude=.git -cf - . | tar -C "$SANDBOX" -xf -
cp "$PRE" "$SANDBOX/_worker/worker.js"

{
  echo "=== PRIVACY CANARY EVIDENCE — $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
  echo "before (pre-fix) worker: $PRE"
  echo "  sha256 $(sha256sum "$PRE" | cut -d' ' -f1)"
  echo "after  (fixed)   worker: $ROOT/_worker/worker.js"
  echo "  sha256 $(sha256sum "$ROOT/_worker/worker.js" | cut -d' ' -f1)"
  echo
  echo "─── 1. privacy-canary suite — BEFORE (pre-fix build) ───"
  (cd "$SANDBOX/_worker/tests" && node --test privacy-canary.test.mjs 2>&1)
  echo
  echo "─── 2. privacy-canary suite — AFTER (fixed build) ───"
  (cd "$ROOT/_worker/tests" && node --test privacy-canary.test.mjs 2>&1)
  echo
  echo "─── 3. differential (pre-fix vs fixed) ───"
  node "$ROOT/_diag/evidence/04-differential.mjs" "$PRE" "$ROOT/_worker/worker.js" 2>&1
  echo
  echo "─── 4. residual payload trace — AFTER (fixed build) ───"
  node "$ROOT/_diag/evidence/05-residual-payload-trace.mjs" 2>&1 | tail -45
  echo
  echo "─── 5. gate matrix on the fixed tree ───"
  for t in worker-safety input-logic privacy-canary agent-page market-integration valuation-gift valuation-handoff valuation-page valuation-worker properties-sync; do
    printf "%-20s " "$t"
    (cd "$ROOT/_worker/tests" && node "$t.test.mjs" 2>&1 | grep -E "^# (pass|fail)" | tr '\n' ' ')
    echo
  done
  echo
  for e in 01-session-persistence 02-privacy-d4b 03-brain-expansion; do
    printf "%-24s " "$e"
    node "$ROOT/_diag/evidence/$e.mjs" 2>&1 | grep -E "COMPLETE" | tail -1
  done
} > "$OUT" 2>&1
echo "written: $OUT ($(wc -l < "$OUT") lines)"
