#!/usr/bin/env bash
# Manual dispatch only. Creates one new persistent D1 backup, never deletes DBs.
# All exports contain confidential data and remain in a private temporary directory.
set -euo pipefail
umask 077
T=$(mktemp -d)
result=not-completed
backup_name=none
backup_id=none
finish() {
  { echo "result=$result"; echo "backup_name=$backup_name"; echo "backup_id=$backup_id"; } >> "$GITHUB_OUTPUT"
  rm -rf "$T"
}
trap finish EXIT
[ -n "${CLOUDFLARE_API_TOKEN:-}" ] || { result=missing-token; exit 1; }
[[ ${GITHUB_RUN_ID:-} =~ ^[0-9]+$ ]] || { result=invalid-run-id; exit 1; }
echo "::add-mask::$CLOUDFLARE_API_TOKEN"
API=https://api.cloudflare.com/client/v4
AUTH="Authorization: Bearer $CLOUDFLARE_API_TOKEN"
source_id=760079c6-85f9-4a30-aa19-9a66f95d421a
source_name=nasr-crm-test-db-v2
backup_name="nasr-crm-test-db-backup-${GITHUB_RUN_ID}"
result=account-read-failed
curl -fsS --connect-timeout 10 --max-time 30 -H "$AUTH" "$API/accounts?per_page=100" > "$T/account.json" 2>/dev/null
jq -e '.success == true and (.result|type == "array" and length == 1)' "$T/account.json" >/dev/null
account=$(jq -r '.result[0].id' "$T/account.json")
echo "::add-mask::$account"
export CLOUDFLARE_ACCOUNT_ID="$account"
result=invalid-source-binding
grep -Fq "database_id = \"$source_id\"" _worker/wrangler.crm.toml
! grep -Eq 'nasr-market-db|ace5c9a2-c6b1-47b3-adf1-77e84ac50abf' _worker/wrangler.crm.toml
curl -fsS --max-time 30 -H "$AUTH" "$API/accounts/$account/d1/database/$source_id" > "$T/source-identity.json" 2>/dev/null
jq -e --arg id "$source_id" --arg name "$source_name" '.success == true and .result.uuid == $id and .result.name == $name' "$T/source-identity.json" >/dev/null
result=inventory-full-or-unavailable
curl -fsS --max-time 30 -H "$AUTH" "$API/accounts/$account/d1/database?per_page=100" > "$T/inventory.json" 2>/dev/null
jq -e --arg name "$backup_name" '.success == true and (.result|type == "array") and (.result_info.total_count | type == "number" and . < 10) and ([.result[] | select(.name == $name)] | length == 0)' "$T/inventory.json" >/dev/null
# Reuse exactly the previously exercised full-schema/data builder and local restore test.
python3 - "$T/builder.mjs" <<'PY'
import sys, textwrap
from pathlib import Path
source = Path('.github/workflows/crm-phase2-backup.yml').read_text()
start = "          cat << 'EOF_NODE' > \"$TMP/build_and_verify.mjs\"\n"
end = '\n          EOF_NODE'
assert source.count(start) == 1
Path(sys.argv[1]).write_text(textwrap.dedent(source.split(start, 1)[1].split(end, 1)[0]) + '\n')
PY
snapshot() {
  local label=$1 name=$2 config=$3 expected=$4
  npx --yes wrangler@4 d1 export "$name" --remote --no-data --config "$config" --output "$T/$label-schema.sql" > "$T/$label.log" 2>&1 || return 1
  npx --yes wrangler@4 d1 export "$name" --remote --no-schema --config "$config" --output "$T/$label-data.sql" >> "$T/$label.log" 2>&1 || return 1
  npx --yes wrangler@4 d1 execute "$name" --remote --json --config "$config" --command 'SELECT id, name, applied_at FROM d1_migrations ORDER BY id ASC;' > "$T/$label-migs.json" 2>/dev/null || return 1
  node "$T/builder.mjs" "$label" "$T/$label-schema.sql" "$T/$label-data.sql" "$T/$label-migs.json" "$T/$label-restore.sql" "$T/$label-meta.json" "$expected" > "$T/$label-builder.log" 2>&1 || return 1
}
result=source-export-or-local-restore-failed
snapshot source "$source_name" _worker/wrangler.crm.toml ''
result=source-changing-or-recheck-failed
snapshot before "$source_name" _worker/wrangler.crm.toml "$T/source-meta.json"
jq -S '{orderedNames,expIndexes,schemaObjectsDigest,autoIndexCount,fkTotal,checkTables,tableStats}' "$T/source-meta.json" > "$T/source-check.json"
jq -S '{orderedNames,expIndexes,schemaObjectsDigest,autoIndexCount,fkTotal,checkTables,tableStats}' "$T/before-meta.json" > "$T/before-check.json"
cmp -s "$T/source-check.json" "$T/before-check.json"
rows=$(jq '[.tableStats[].count] | add' "$T/source-meta.json")
[[ $rows =~ ^[0-9]+$ ]] && (( rows > 0 && rows <= 10000 )) || { result=unexpected-source-size; exit 1; }
# A conservative budget is an estimate only, not a guarantee against concurrent usage
# or index amplification. Stop before creating anything if analytics are unavailable.
result=quota-unavailable-or-insufficient
day=$(date -u +%F)
gql='query($accountTag: string!, $day: Date!) { viewer { accounts(filter: {accountTag: $accountTag}) { d1AnalyticsAdaptiveGroups(limit: 10000, filter: {date_geq: $day, date_leq: $day}) { sum { rowsWritten } } } } }'
jq -n --arg query "$gql" --arg account "$account" --arg day "$day" '{query:$query,variables:{accountTag:$account,day:$day}}' > "$T/request.json"
curl -fsS --max-time 30 -H "$AUTH" -H 'Content-Type: application/json' --data-binary "@$T/request.json" "$API/graphql" > "$T/usage.json" 2>/dev/null
jq -e '(.errors // [] | length == 0) and (.data.viewer.accounts | type == "array" and length == 1) and (.data.viewer.accounts[0].d1AnalyticsAdaptiveGroups | type == "array" and length > 0) and ([.data.viewer.accounts[0].d1AnalyticsAdaptiveGroups[].sum.rowsWritten] | all(type == "number" and . >= 0 and floor == .))' "$T/usage.json" >/dev/null
used=$(jq -r '[.data.viewer.accounts[0].d1AnalyticsAdaptiveGroups[].sum.rowsWritten] | add' "$T/usage.json")
[[ $used =~ ^[0-9]+$ ]] && (( 100000 - used >= 4 * rows + 5000 )) || exit 1
result=backup-create-failed-or-unknown
jq -n --arg name "$backup_name" '{name:$name}' > "$T/create-request.json"
curl -fsS --connect-timeout 10 --max-time 60 -H "$AUTH" -H 'Content-Type: application/json' --data-binary "@$T/create-request.json" "$API/accounts/$account/d1/database" > "$T/create.json" 2>/dev/null
jq -e --arg name "$backup_name" '.success == true and .result.name == $name and (.result.uuid | type == "string" and length > 0)' "$T/create.json" >/dev/null
backup_id=$(jq -r '.result.uuid' "$T/create.json")
printf 'name = "crm-single-slot-backup"\ncompatibility_date = "2025-11-17"\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "%s"\ndatabase_id = "%s"\n' "$backup_name" "$backup_id" > "$T/backup.toml"
result=backup-created-import-failed-preserved
npx --yes wrangler@4 d1 execute "$backup_name" --remote --config "$T/backup.toml" --file "$T/source-restore.sql" > "$T/import.log" 2>&1
result=backup-created-verification-failed-preserved
snapshot saved "$backup_name" "$T/backup.toml" "$T/source-meta.json"
jq -S '{orderedNames,expIndexes,schemaObjectsDigest,autoIndexCount,fkTotal,checkTables,tableStats}' "$T/saved-meta.json" > "$T/saved-check.json"
cmp -s "$T/source-check.json" "$T/saved-check.json"
result=backup-verified-but-source-changed
snapshot after "$source_name" _worker/wrangler.crm.toml "$T/source-meta.json"
jq -S '{orderedNames,expIndexes,schemaObjectsDigest,autoIndexCount,fkTotal,checkTables,tableStats}' "$T/after-meta.json" > "$T/after-check.json"
cmp -s "$T/source-check.json" "$T/after-check.json"
result=backup-matched-source-and-local-restore-verified
