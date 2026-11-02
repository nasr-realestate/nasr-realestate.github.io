# Draft 0010 on the Cloudflare D1 engine — rehearsal report (nothing applied anywhere real)

Scope of this task, exactly: **run the already-written draft `0010_crm_drive_file_versions.sql` and its
contract against the database engine production actually uses**, in a throwaway local file, and report
what that engine does differently from `node:sqlite`. No migration was applied to any real database.
Nothing was written to `nasr-crm-test-db`; `nasr-market-db` and the reference backup were not touched.
No file content was read, no Drive call was made, no Worker or Pages deploy happened, PR #132 was not
merged, and no contact was imported, linked or merged.

Harness: `_worker/tests-draft/crm-drive-versions-0010.d1-rehearsal.py`
Engine: `wrangler 4.156.0` → `d1 migrations apply --local` / `d1 execute --local`, `--persist-to` a
temporary directory, `api.cloudflare.com` never contacted.
Result: **`D1_VERSIONS 69/69 checks held` · `ALL_BARRIERS_HELD_ON_D1` · exit 0.**

| what it does | file | result |
| --- | --- | --- |
| D1 engine rehearsal, 0010 | `_worker/tests-draft/crm-drive-versions-0010.d1-rehearsal.py` | **69/69 held** |
| node:sqlite rehearsal, 0010 (re-run after these edits) | `_worker/tests-draft/crm-drive-versions-0010.rehearsal.mjs` | 42/42 `ALL_BARRIERS_HELD` |
| CI gate now running both | `.github/workflows/crm-review-0009-verify.yml` | 15 steps, both D1 rehearsals wired |

---

## 1. Why a second harness was needed

The draft's first proof ran on `node:sqlite`, which is the same SQLite dialect but **not the same
environment**: D1 wraps the engine in an authorizer, exposes SQL only through `wrangler d1 execute`,
and runs migrations through wrangler's own runner (statement splitting, a `_cf_*_d1_migrations` counter,
per-file transaction behaviour). Every one of those is a place where "it works in node" could have been
wrong. Three of them turned out to matter, and the harness now measures rather than assumes:

* `PRAGMA integrity_check` and `SELECT sqlite_version()` are **refused by D1's authorizer**
  (`not authorized: SQLITE_AUTH`, `not authorized to use function`) while `node:sqlite` allows both.
  The integrity check in §9 therefore runs against **the file D1 wrote**, with python's `sqlite3`.
  This changes the repo's own promotion checklist (see §5).
* `ALTER TABLE … ADD COLUMN … CHECK (…)` has no precedent anywhere in 0001–0009. On D1 the column CHECK
  is live: a valid 64-hex `drive_ref` is accepted, `zzzz` and a 63-character value are both refused (§2).
* The runner is what turns a `.sql` file into applied DDL. It applied all 515 lines of the draft —
  8 `ALTER`s, 1 table, 20 triggers, 6 views, 6 indexes, 19 `RAISE(ABORT …)` — with no split error.

## 2. What was measured, section by section

| § | what it proves | checks |
| --- | --- | --- |
| 0 | the state a promotion starts from: 0002/0007/0008/0009 applied, 74 objects, inventory digest `97a419360af43f36`, empty registry | 2/2 |
| 1 | the runner applies 0010; **33 objects added** (`index=6 table=1 trigger=20 view=6`); the *only* pre-existing object whose DDL changed is `table:crm_drive_file_registry`; 0007 indexes/CHECKs and every 0008/0009 object byte-identical; all 8 projected columns present | 7/7 |
| 2 | `ADD COLUMN … CHECK` on the real engine, in both directions (accepted / refused / refused by length) | 4/4 |
| 3 | 99 **synthetic** `SYNTH…` file rows; the bootstrap; the projection; idempotency | 14/14 |
| 4 | 12 tampering attempts, each refused with the named trigger firing | 12/12 |
| 5 | content change under identical metadata, backdating, and A→B→A | 10/10 |
| 6 | the rehash queue, provenance view, duplicate-evidence view, and that no view exposes a name or path | 5/5 |
| 7 | D1 vs `node:sqlite` on the same three statements | 5/5 |
| 8 | what a failed migration file does to the database | 1/1 |
| 9 | integrity, foreign keys, schema drift, rollback | 9/9 |

The three findings worth pulling out of §1 and §3:

* **"Purely additive" was proved at token level, not by eyeballing text.** D1 rewrites the stored DDL of
  an altered table, so a line diff is meaningless. The harness instead asserts that every word of the old
  `crm_drive_file_registry` DDL still appears, in the same order, inside the new one (subsequence), and
  that every word the change *added* is a word 0010 itself wrote. So nothing was edited, dropped,
  reordered, or invented by the engine.
* **The live state cannot be mirrored before the ledger exists.** Inserting a file row at
  `processing_status='processed'` — which is exactly what a naive bootstrap would do to the 99 real rows —
  is refused on D1 by `trg_registry_status_needs_version`. The 99 rows may only advance *after* the
  bootstrap versions are recorded. The promotion order in the design report is therefore not cosmetic;
  it is enforced by the schema.
* The bootstrap creates exactly 99 versions, all `version_seq = 1`, all `evidence_class =
  'bootstrap_backfill'`, all with `drive_revision` and `drive_md5` **NULL** — the draft does not guess
  values it cannot observe — and re-running it adds nothing.

## 3. The refusals (§4, §5) — every one with the named barrier

`registry_fingerprint_must_match_recorded_head_version` · `registry_fingerprint_cannot_be_erased` ·
`registry_head_is_maintained_by_the_ledger` · `drive_version_seq_not_next` ·
`drive_version_verified_needs_recompute_evidence` · `drive_version_digest_must_be_derived` ·
`file_versions_are_append_only` (UPDATE and DELETE) · `file_versions_anchor_registry_rows` ·
`drive_ref_is_write_once` · `check constraint` (non-hex `drive_ref`, 63-hex `drive_ref`, a row born
claiming a head, a version with no fingerprint at all — `NOT NULL`) ·
`drive_version_time_moved_backwards` · `drive_version_repeat_needs_same_sha`.

Two of these earned their keep in a way I did not expect. The harness originally failed because a
backdated version was refused — and the reason was real: `crm_drive_file_registry.last_seen_at` has
`DEFAULT CURRENT_TIMESTAMP`, and the bootstrap derives `observed_at` from `COALESCE(r.last_seen_at,
r.created_at)`. A file row whose `last_seen_at` was never written therefore stamps its bootstrap version
with "now". On the live database `last_seen_at` *is* written by the scanner, so the semantic is correct
("the version was observed as of the last time the file row saw it"), but it is now stated explicitly in
the design report instead of being an accident of defaults.

§5 then does the thing T2 exists for: a second version with **the same size and the same
`modifiedTime`, different bytes** is recorded as a new row, the ledger reports it as a change the
metadata could not see, the file row keeps pointing at the old digest until the projection is legally
advanced, an unmarked return to an old digest is refused, and a *marked* repeat gets its own row pointing
at the earliest version carrying that digest — so `A→B→A` leaves three rows and two distinct digests.
History is never resurrected or overwritten.

## 4. What D1 does with the file, and with a bad file (§7, §8, §9)

* **The differential came back clean.** Three statements were run against both engines. Same verdict in
  all three, and after normalising only the CLI banner and the `at offset N` annotation, **the same
  sentence**: `drive_version_ref_not_registered`, `near "b": syntax error`, and
  `registry_head_is_maintained_by_the_ledger` appear identically on both. The only two real differences
  are capability differences, printed by the harness rather than remembered: `sqlite_version()` and
  `PRAGMA integrity_check` are blocked by D1's authorizer, allowed by `node:sqlite`.
  This is what makes the 42-check node rehearsal evidence *about D1* rather than about a similar engine.
* **A failed migration file does not leave a half-built schema.** A deliberately broken file (a valid
  `CREATE TABLE` followed by an invalid `ALTER`) was applied: local D1 **rolled back** the statement that
  had succeeded (`probe_atomic` present = 0), and re-applying 0010 afterwards lands on exactly the schema
  digest a clean apply produces. Whatever a future runner does with a mid-file failure, the draft is
  re-runnable and idempotent — that is the property the promotion plan depends on.
* **`integrity_check` is `ok` on the file D1 wrote** after the apply *and* after 12 refused tampering
  attempts; `PRAGMA foreign_key_check` (which D1 does allow) is empty; the inventory digest is unchanged
  across the whole run; and a rollback removes 0010's own 33 objects while 0007/0008/0009 come through
  byte-identical — with one honest exception the harness names out loud: the 8 added columns **cannot** be
  dropped (SQLite has no `DROP COLUMN`), so a rollback leaves the empty projection columns behind. The
  99 file rows are untouched in either direction, and the migration counter is rewound for 0010 only.

## 5. Consequences for the promotion checklist

Two wording changes are needed in `_worker/migrations-draft/README.md` (applied in the same commit as
this report):

1. `PRAGMA integrity_check = ok` **cannot be executed through D1's SQL interface** — local or remote. It
   must run on a downloaded copy or a backup of the database file (as this rehearsal does), or be
   replaced by `foreign_key_check` plus the CI object-count comparison.
2. The bootstrap's `observed_at` derives from `last_seen_at`/`created_at`, and `last_seen_at` defaults
   to `CURRENT_TIMESTAMP`. That is now written down as item 3b of the design report's promotion effects,
   so nobody reads a bootstrap timestamp as a Drive timestamp.

## 6. Limits of this evidence — what is still not proven

* **Remote D1 was never contacted.** `api.cloudflare.com` is unreachable from this sandbox and no token
  exists, so `--remote` was not exercised. The scratch database is the same engine and the same runner,
  not the same network path or the same console.
* **The 99 real rows were never backfilled.** Everything here uses synthetic `SYNTH…` fixtures with
  fabricated digests; no file content was read, so no real `content_sha256` exists anywhere in this work.
* **The service layer does not exist yet.** `recordVersion()` is not written; `_worker/crm-drive-file-
  registry.js` still overwrites `content_sha256`. 0010 alone is not deployable: the writer must record the
  version row, then the projection, then the status, or every content-state write will be refused.
* **`drive_revision`/`drive_md5` stay NULL** for anything the API did not supply; the design keeps them
  nullable so the schema cannot be filled with guesses.
* Duplicate detection across files is still *evidence*, not a conclusion: `crm_drive_duplicate_evidence`
  shows nothing for bootstrap claims, and declaring two files duplicates remains a human act.

## 7. Effect on existing data (unchanged by this task)

Applied for real, 0010 would: add 8 columns to `crm_drive_file_registry` (all nullable or defaulted, no
row rewritten), create one append-only table, 20 triggers, 6 views, 6 indexes, and run a backfill that is
**inert until `drive_ref` is populated by the writer**. It would not update, delete or re-type any
existing value, not relax any 0007/0008/0009 rule, not touch a file row's `processing_receipt_ref`, and
not create a single review case. Today it creates nothing at all: it is a file in a directory
`wrangler d1 migrations apply` does not read.

## 8. What T2 still needs from you

1. Approval of the *design* as written (version ledger, projection columns, evidence classes) — and the
   two engine-level consequences in §5.
2. Approval of the companion service change (`recordVersion()` write order). Without it the migration is
   inert, and any attempt to mirror the live `processed` state is refused by design.
3. Permission to read Drive file content (the digests are the point of the ledger; nothing can be
   *verified* — only declared — until then). That is the gate I have stopped at, and it is why every
   digest in this rehearsal is fabricated.
4. A decision on the `crm-test-deploy` environment gate (`CRM_PHASE4_REVIEW_SECURITY.md` §5) before any
   push that touches `_worker/crm-ui/**` or `_worker/crm-worker.js`.

Reproduce locally (nothing external is touched):

```bash
npm install --no-save wrangler@4.156.0
KEEP=1 WRANGLER=$PWD/node_modules/.bin/wrangler \
  python3 _worker/tests-draft/crm-drive-versions-0010.d1-rehearsal.py
```
