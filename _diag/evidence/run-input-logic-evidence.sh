#!/usr/bin/env bash
# Input-logic phase — raw evidence runner.
# Produces _diag/evidence/results/input-logic-evidence.txt from scratch:
#   * the new input-logic suite, run against the patched worker AND the pre-patch worker
#   * the whole existing test matrix, before/after
#   * evidence suites 01/02/03 + the differential (suite 04)
#   * the lead-level proof of the reported price defect
# Usage: bash _diag/evidence/run-input-logic-evidence.sh <pre-patch-worker.js>
set -u
PRE="${1:?usage: run-input-logic-evidence.sh <pre-patch-worker.js>}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/_diag/evidence/results/input-logic-evidence.txt"
SANDBOX="$(mktemp -d)"
# a full copy of the working tree (minus the git dir) so EVERY suite can run there,
# then swap in the pre-patch worker — the only variable between the two columns.
tar -C "$ROOT" --exclude=.git -cf - . | tar -C "$SANDBOX" -xf -
cp "$PRE" "$SANDBOX/_worker/worker.js"

PASSFAIL() { grep -E "^# (pass|fail)" | tr '\n' ' '; }
{
echo "═══ INPUT-LOGIC PHASE — RAW EVIDENCE ═══"
echo "generated: $(date -u +%Y-%m-%dT%H:%M:%SZ) (UTC)"
echo "worker.js      : $(wc -l < "$ROOT/_worker/worker.js") lines, $(wc -c < "$ROOT/_worker/worker.js") bytes, sha256 $(sha256sum "$ROOT/_worker/worker.js" | cut -d' ' -f1)"
echo "pre-patch file : $PRE (sha256 $(sha256sum "$PRE" | cut -d' ' -f1))"
echo

echo "─── 1. the new regression suite vs the PATCHED worker (must be 24/0) ───"
(cd "$ROOT/_worker/tests" && node input-logic.test.mjs 2>&1 | grep -E "^(ok|not ok) [0-9]+ - |^# (pass|fail|tests)")
echo
echo "─── 2. the new regression suite vs the PRE-PATCH worker (must be RED — proves it tests the fix) ───"
(cd "$SANDBOX/_worker/tests" && node input-logic.test.mjs 2>&1 | grep -E "^(not ok) [0-9]+ - |^# (pass|fail|tests)")
echo
echo "─── 3. D-4b privacy suite vs the PRE-PATCH worker (red before) ───"
node "$SANDBOX/_diag/evidence/02-privacy-d4b.mjs" 2>&1 | tail -1
echo
echo "─── 4. D-4b privacy suite vs the PATCHED worker (green after) ───"
node "$ROOT/_diag/evidence/02-privacy-d4b.mjs" 2>&1 | tail -1
echo
echo "─── 5. worker-safety before / after ───"
printf "before: "; (cd "$SANDBOX/_worker/tests" && node worker-safety.test.mjs 2>&1 | PASSFAIL); echo
printf "after : "; (cd "$ROOT/_worker/tests" && node worker-safety.test.mjs 2>&1 | PASSFAIL); echo
echo
echo "─── 6. the full suite matrix, before / after ───"
for t in worker-safety agent-page market-integration valuation-gift valuation-handoff valuation-page valuation-worker properties-sync; do
  printf "%-20s before: " "$t"; (cd "$SANDBOX/_worker/tests" && node "$t.test.mjs" 2>&1 | PASSFAIL)
  printf "%-20s after : " "$t"; (cd "$ROOT/_worker/tests" && node "$t.test.mjs" 2>&1 | PASSFAIL); echo
done
echo
echo "─── 7. evidence 01 (session persistence) vs the patched worker ───"
node "$ROOT/_diag/evidence/01-session-persistence.mjs" 2>&1 | tail -1
echo "─── 8. evidence 03 (brain expansion) vs the patched worker ───"
node "$ROOT/_diag/evidence/03-brain-expansion.mjs" 2>&1 | tail -1
echo
echo "─── 9. differential (suite 04): pre-patch vs patched ───"
cp "$ROOT/_worker/worker.js" "$SANDBOX/worker-after.js"
node "$ROOT/_diag/evidence/04-differential.mjs" "$PRE" "$SANDBOX/worker-after.js" 2>&1 | grep -vE "^ *(before|after) *:"
echo
echo "─── 10. lead-level proof of the reported defect (the WhatsApp message the owner gets) ───"
printf "before: "; node -e "
import('$SANDBOX/_worker/tests/_agent-harness.mjs').then(async H => {
  H.installFetchMock();
  const g = await H.driveOwnerToGift({ withGps: false });
  const s = await H.agentPost({ message: '⏭ تخطي السؤال', formState: g.json.formState, history: [] });
  const d = await H.finishOwnerFlow(s.json.formState);
  console.log((String(d.json.waMessage||'').split('\n').find(l => /السعر المطلوب/.test(l)) || '(none)').trim());
});" 2>&1 | tail -1
printf "after : "; node -e "
import('$ROOT/_worker/tests/_agent-harness.mjs').then(async H => {
  H.installFetchMock();
  const g = await H.driveOwnerToGift({ withGps: false });
  const s = await H.agentPost({ message: '⏭ تخطي السؤال', formState: g.json.formState, history: [] });
  const d = await H.finishOwnerFlow(s.json.formState);
  console.log((String(d.json.waMessage||'').split('\n').find(l => /السعر المطلوب/.test(l)) || '(none)').trim());
});" 2>&1 | tail -1
echo
echo "─── 11. what the customer can now type at «السعر المطلوب كام؟» / «ميزانيتك كام؟» ───"
node "$ROOT/_diag/evidence/price-answers-probe.mjs" 2>&1 | tail -20
echo
echo "═══ END ═══"
} | tee "$OUT"
rm -rf "$SANDBOX"
