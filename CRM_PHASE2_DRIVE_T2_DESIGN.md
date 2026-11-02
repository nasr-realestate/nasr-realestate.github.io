# Phase 2 / T2 blockers — design + local proofs (nothing applied)

Scope of this task, exactly: **design and local tests only.** No migration was applied, nothing was
written to `nasr-crm-test-db`, no file content was read, no Drive call was made, nothing was deployed,
PR #132 was not merged. Two draft migrations were written into `_worker/migrations-draft/` — the
directory every `wrangler d1 migrations apply` path ignores — and two in-memory rehearsals prove what
their DDL enforces.

| blocker | draft | new objects | objects it modifies |
| --- | --- | --- | --- |
| file version tracking | `_worker/migrations-draft/0010_crm_drive_file_versions.sql` | 1 table, 8 added columns, 6 indexes, 20 triggers, 6 views | none (no `DROP`, no `UPDATE` of existing rows) |
| review of a file with no contact | `_worker/migrations-draft/0011_crm_drive_file_intake_review.sql` | 3 tables, 5 indexes, 16 triggers, 4 views | **none** — 0009 is left byte-for-byte alone |
| local proofs | `_worker/tests-draft/crm-drive-versions-0010.rehearsal.mjs` · `…-file-review-0011.rehearsal.mjs` | **42/42** · **35/35** `ALL_BARRIERS_HELD` | — |

---

## 1. Blocker 1 — every version of a file must survive

### What exists today (measured, not assumed)

`crm_drive_file_registry` (0007) has one fingerprint column per file. The live service layer writes it
with a plain overwrite: `_worker/crm-drive-file-registry.js:683` (`recordContentHash`) does
`UPDATE crm_drive_file_registry SET content_sha256 = ?, inner_content_sha256 = COALESCE(?, …)`. So a
second observation of the same file does not record a version — it **replaces** the previous digest and
the earlier content state stops existing. There is no revision column at all (no Drive revision id, no
md5), while the T1 listing shows files at Drive revisions 2–6. A content swap that preserves size and
`modifiedTime` is therefore invisible to everything built so far, including my own T1 reconciliation.

### The mechanism

A file row stops being the place where content history lives. It becomes a **projection** of an
append-only ledger:

```
crm_drive_file_version(version_ref PK, drive_ref, version_seq, content_sha256 NOT NULL,
                       inner_content_sha256, evidence_class NOT NULL, size_bytes NOT NULL,
                       drive_revision, drive_md5, drive_modified_at, observed_at, observed_by,
                       receipt_ref, repeat_of_version_ref, UNIQUE (drive_ref, version_seq))
```

Each requirement, the thing that enforces it, and the rehearsal line that shows it holding:

| requirement | enforcement | proven by |
| --- | --- | --- |
| register **every** version | `trg_drive_version_seq_dense`: `version_seq` must equal `MAX(seq)+1` for that ref — appending is the only legal write | `T2 v2 appended as seq 2`, `a version may not skip numbers` |
| store SHA-256 per version | `content_sha256 TEXT NOT NULL CHECK (length = 64 AND hex)` — a version row without a real digest is not expressible | `T3 a missing digest is refused` |
| size + `modifiedTime` are never proof of content | a version row **requires** a digest, and 0007 already requires a digest for `hashed`/`processed`; `trg_registry_status_needs_version` (+ `_insert`) closes the `downloaded` loophole | `metadata equality cannot mark the file downloaded/hashed/processed`, `a fresh row cannot be inserted at a content status with no version ledger` |
| never replace an old fingerprint with a new one | `trg_registry_fingerprint_is_a_projection` (the file row may only be set to the digest of the current head version) + `trg_registry_fingerprint_irreversible` (may not be nulled) + `trg_drive_version_no_update/no_delete` | `an already-recorded fingerprint cannot be erased`, `the registry may not be advanced onto a digest that is not the head` |
| detect change even with identical metadata | the ledger keeps both digests; `crm_drive_version_state` reports `changed_under_identical_metadata` whenever size and `modifiedTime` agree but the digests do not, and `metadata_is_silent` counts the files where metadata says nothing | `the ledger reports it as a change the metadata could not see` (asserts `head_size_bytes = registry_size_bytes` and equal mtimes in the same row) |
| keep the history | no `UPDATE`/`DELETE` on the ledger; `trg_registry_row_has_history` refuses deleting a file row that anchors versions or lineage; `trg_registry_ref_is_write_once` stops a ref being re-pointed onto another file's history | `T6a` (4 checks, including wiping the whole table) |

Supporting decisions:

* **`evidence_class` is mandatory**: `verified_local_recompute` (the writer hashed bytes it fetched — must
  carry a `receipt_ref`), `declared_by_writer` (a claim, which is exactly how the 99 existing rows were
  born), `bootstrap_backfill` (synthesised at promotion). `crm_drive_rehash_queue` lists every file whose
  head is not `verified_local_recompute`, so a claim can never outrank a measurement in any consumer.
* **A→B→A is visible**: re-observing a digest the same file already had must set `repeat_of_version_ref`
  to the earliest row carrying it (`trg_drive_version_repeat_marked`), and pointing at a row that did not
  carry it is refused. A cycle is a recorded fact instead of a silent overwrite or a lost row.
* **`version_ref` is derived** (`drive_ref || '#' || version_seq`), so a writer cannot smuggle a row that
  no join can find.
* **duplicate lineage is pinned**: a `duplicate` row must name `(duplicate_of_drive_ref,
  duplicate_of_version_seq)`, and `crm_drive_duplicate_lineage` reports `drift_canonical_moved_forward` /
  `drift_pinned_digest_differs` rather than letting a claim silently re-point at whatever the canonical
  row says today. `crm_drive_duplicate_evidence` groups on the outer digest **and** on
  `inner_content_sha256`, which is the two-level dedupe T1 said was needed.
* **drive_ref** (`sha256("crm-p4-v1\ndrive_ref\n<id>")`, the T1 convention, one-way) is added to the file
  row with a partial UNIQUE index so refs are joinable and unforgeable in SQL.

### Effect on existing data

Nothing is rewritten. The live table holds **99 rows, all `processed`, all with a content digest** (T1,
measured through the registry snapshot). Applying 0010:

1. 8 `ADD COLUMN`s — 6 nullable, 2 `NOT NULL DEFAULT 0`; SQLite fills the 99 rows, no row is rewritten
   by hand. (`ADD COLUMN` is the construct 0004/0005/0006 already used on this database.)
2. New empty table + triggers + views — inert.
3. The backfill `INSERT` produces **exactly 99 `bootstrap_backfill` version rows** (one per registered
   file, seq 1, `size_bytes`/`drive_modified_at` copied from the file row, `receipt_ref =
   'phase2-0010-bootstrap'`) — **and it is a no-op until `drive_ref` is filled**, because SQL has no
   SHA-256. That ordering is deliberate: the safest failure mode of this migration is "nothing
   happened", and re-running is harmless (the `NOT EXISTS` guard plus the density trigger make a second
   attempt impossible to fake as a new version).
4. **The one breaking change is in code, not data**: `recordContentHash` currently sets the fingerprint
   and the status in a single `UPDATE`, which 0010 refuses by design. T2 must therefore ship
   `insertNewDriveFileStrict`/`upsertDriveFileMetadata` → *append version row* → *advance status +
   project fingerprint*, in that order — the same order the rehearsal's fixtures use. It fails closed
   until then, which is the correct direction for a mistake.

## 2. Blocker 2 — a review case for a file that belongs to nobody

### What blocks it today

Three independent constraints in 0009's `crm_drive_review_case`, quoted in the draft header:
`case_kind IN ('file_to_contact','contact_fanout')`; the kind-shape `CHECK` that requires
`crm_contact_id IS NOT NULL` in **both** branches; and `run_key NOT NULL REFERENCES
crm_drive_analysis_run(run_key)`, which a never-analysed file cannot satisfy. So the T1 plan line
"`register_new` → review batch" was unrepresentable: there was nowhere to record "a human looked at this
file and decided to read the bytes".

### Why a sibling table rather than relaxing 0009

Relaxing a `CHECK` means rebuilding the table. Before deciding, I measured the rebuild on this repo's
engine (`node:sqlite`, SQLite 3.51.3): `ALTER TABLE … RENAME TO` **rewrites the bodies of dependent
views** to the temporary name, so `crm_review_case_state`, `crm_review_seal_availability` and
`crm_review_ci_summary` followed `…_old` and broke when it was dropped. A correct rebuild must drop and
recreate 4 views and 19 triggers, and carry `sqlite_sequence` forward by hand — on the object set whose
whole value is that it cannot be edited, applied by a tool that runs a migration statement-by-statement
with no wrapping transaction. The live database holds 0 rows in every 0009 object, so the rebuild would
buy nothing today. **0011 therefore adds objects and modifies none**, and isolation becomes structural
instead of a convention.

### The design

`crm_drive_file_review_case` — a case that is exactly *(this file, this version)*: `case_ref` is derived
(`'frw-' || substr(drive_ref,1,16) || '-' || bound_version_seq`), `bound_content_sha256` is the bytes the
review is about, `review_disposition` is drawn from a vocabulary that contains **no** import, link, merge
or identity verb, and `import_implied` / `merge_authorized` / `contact_write_count` are `CHECK`-locked to
0 on both the case row and every decision row.

Requirement → enforcement → proof:

| requirement | enforcement | proven by |
| --- | --- | --- |
| a case exists without a contact | `crm_contact_id` is simply nullable, and no run/seal/ciphertext is required | `a case opens for a file with crm_contact_id absent`, `no analysis run, no seal and no ciphertext were needed` |
| linking is optional | the shape `CHECK` admits `link_state = 'none'` with everything else NULL | the same case above |
| never automatic | `trg_file_review_case_no_insert_link` (a case is **born** unlinked) + `trg_file_review_case_link_barrier` (a change to contact/basis/evidence is refused unless the evidence set is complete *and* a `link_proposed` decision exists) | `a contact handle cannot simply be written onto a case`, `a link cannot be created together with the case`, `a proposal with a human but no recorded decision is refused` |
| never by guessing or by name | `link_basis IN ('vcard_tel','sender_label_phone','manual_pin')` — name/similarity/matcher values do not exist; `link_confirmed_by` refuses `auto, system, agent, ai, bot, worker, cron, pipeline, matcher, algorithm, unknown, none, na, -` | `no name-based basis exists in the vocabulary at all`, `nor does "similarity", "matcher" or "auto"`, `a machine label cannot confirm a link` |
| file review never authorises a contact write | `approved_by_contact_review` additionally requires `escalated_case_ref` whose 0009 case carries a real `approve` **event** — so the phone-backed + fresh-reveal barriers of 0009 remain the only way to authorise anything | `a proposed link is not an approved one: escalation must be real and decided` |
| review independence, in SQL | `crm_drive_file_review_isolation` counts references from these objects to `crm_contacts` / `crm_conversations` / `crm_opportunities` / `file_name` / `drive_path` / `error_message`, plus loose nails and unexplained links | the three are 0, and a **positive control** (a deliberately bad sibling schema) shows the view reports `forbidden_refs=1 nails_loose=1` |
| decisions are permanent and tamper-evident | append-only triggers on decisions and anchors, dense `decision_seq` per case, prev-hash chaining to a genesis digest stored on the case row, live-session requirement (`crm_sessions`) for any state-changing decision | 9 checks under `T6b`, incl. `a decision bound to a different snapshot is refused` |
| a review dies with the bytes | `trg_file_review_case_stale_on_close` refuses `decided`/`closed_no_action` once the registry's head moved past `bound_version_seq`; `crm_drive_file_review_state.freshness` says `stale_newer_version_exists` | `the file moves to a new version while the case is open`, `a stale case cannot be closed as if it were current`, `the review stays open, and a fresh case against v2 is allowed` |
| 0009 is not weakened | nothing in 0009 changed | `the contact-matching workflow still demands a contact (0009 untouched)` |

A case cannot even be opened against bytes nobody recorded (`file_review_case_requires_a_recorded_version`
reads 0010's ledger), and a healthy chain reads `broken_links = 0, seq_gaps = 0, anchor_mismatches = 0`
— the lesson taken from 0009's genesis fix: a gate that is red on a good database is a gate that gets
switched off.

**Effect on existing data: none.** No `ALTER`, no backfill; existing files simply have zero intake cases
until someone opens one. Dependency: 0011 must be promoted **after** 0010 (it reads
`crm_drive_file_version`) and after 0009 (escalation FK).

## 3. Tests

```bash
node _worker/tests-draft/crm-drive-versions-0010.rehearsal.mjs   # VERSIONS 42/42 checks held
node _worker/tests-draft/crm-file-review-0011.rehearsal.mjs      # FILE_REVIEW 35/35 checks held
```

Both open `new DatabaseSync(':memory:')`, apply `_worker/migrations/0001..0009` then the drafts (the
harnesses follow a draft into `_worker/migrations/` automatically, so no edit is needed at promotion),
and make **no** network call, no Drive call, no wrangler call. Six required behaviours map to `T1`,
`T2`, `T3` (0010) and `T4`, `T5`, `T6` (0011) labels printed per line. Negative controls are paired with
positive ones: 0010 replays its views against a copy of itself with the triggers regex-stripped and
insists the views *see* the damage (`counter_mismatches=1 dangling_heads=1`,
`projection_state=registry_fingerprint_not_head`); 0011 does the same for the isolation view. Both also
assert that nothing operational moved (`operational tables untouched (6 tables)`, all counts 0).

Regression state of the rest of the repo: `npm test` → **588 pass / 12 fail**, identical to the recorded
`16b40fd` worktree baseline ⇒ **0 regressions**, including the repo-wide PII canary test that walks every
`.sql`/`.mjs` file (my four new files are inside that walk). CI: the two harnesses are now steps in
`.github/workflows/crm-review-0009-verify.yml` (13 steps, 17 trigger paths on both `pull_request` and
`push`), and that gate's privacy sweep already whitelists `_worker/migrations-draft` and
`_worker/tests-draft`, so the drafts are scanned on every change: **clean over 26 files**.

## 4. What the rehearsal found *in the drafts* (this is the point of writing them locally)

1. **Two refusals sharing one message.** `trg_registry_duplicate_pin_update` conflated "no pin" with
   "pin points at yourself"; the harness caught it as *refused for the wrong reason*. Split into two
   triggers so the abort names the actual violation.
2. **A barrier that existed only on `UPDATE`.** The status-needs-a-version rule let a **fresh** row be
   inserted straight at `hashed`/`processed` with a self-declared digest and no ledger — reachable in
   practice, since `recordContentHash` writes new registrations. Added `trg_registry_status_needs_version_insert`.
3. **The same class of hole in 0011**: `trg_file_review_case_link_barrier` guarded `UPDATE`, so a case
   could be *created* already linked — the most plausible way an "automatic" link would actually arrive.
   Added `trg_file_review_case_no_insert_link`.
4. **A `CHECK` that could never be erased** — the unlink path was unreachable, because the ledger's own
   projection `UPDATE` tripped the link barrier. The barrier now admits a transition to `none` only when
   an `unlink_recorded` decision exists, which is both stronger and actually usable.
5. **Two SQLite grammar rules** that no amount of reading 0007/0009 would teach, since those files never
   break them: a `CREATE TABLE` must list **all columns before all table-level constraints** (a column
   after a table `CHECK` is a syntax error, reported unhelpfully at the next column name), and a
   **table-level** `CHECK` may only reference columns declared to its left (a column-level `CHECK` may
   reference later ones). Both drafts were rewritten by a small deterministic reordering tool, and
   `PRAGMA` lines were dropped because no applied migration in this repo has ever contained one.
6. **Misuse of a correlated aggregate** in `crm_drive_file_review_state` (`MAX()` inside a subquery) —
   rewritten as a grouped derived table plus a join on `last_seq`.
7. Two failures were my *test's* own bugs (a placeholder/argument mismatch, and an expected string
   containing a literal `|` treated as a substring); recorded because a harness that only ever passes is
   not evidence.

## 5. Remaining risks (what approval should be thinking about)

1. **Engine gap.** The drafts are proven on `node:sqlite` 3.51.3, **not yet on D1's SQLite**. The only
   construct without precedent in this repo's applied migrations is `ALTER TABLE … ADD COLUMN … CHECK`
   (the `ADD COLUMN` part is precedented — 0004/0005/0006; the `CHECK` on an added column is not).
   Before promotion, both drafts must be applied to a throwaway D1 database
   (`wrangler d1 create` a scratch name, `--local`, `d1 migrations apply`, then
   `sqlite_master` counts + `integrity_check` + `foreign_key_check`), exactly as
   `_worker/tests-draft/crm-review-sql-0009.d1-rehearsal.py` does. Fallback if D1 refuses the CHECK: drop
   it from the `ADD COLUMN` and keep the identical rule as a trigger (which is what enforces it today for
   `head_*` columns anyway).
2. **A migration is applied statement-by-statement, without a transaction.** A mid-file failure can leave
   a partial schema. 0010 is written so this is survivable (every object `IF NOT EXISTS`, additive
   columns first, ledger second, inert backfill last) but it is not *impossible* — hence risk 3.
3. **Code and schema must move together.** If 0010 is applied before `recordContentHash` is reordered,
   live ingest writes start failing closed (registration of new files, and the hash step of retries).
   That is a safe direction, but it is an outage, so promotion order should be: 0010 → worker release
   with the version-first write → backfill `drive_ref` → bootstrap versions → verify counts. Never the
   reverse.
4. **Digests are still supplied by the writer.** D1 has no SHA-256, so `content_sha256` in the ledger is
   what the tool computed; `evidence_class` is what the tool declared. 0010 makes an unverified digest
   impossible to *confuse* with a verified one and makes every projection auditable, but detecting a
   forged or stale `evidence_class` requires the read-only recomputation pass (the
   `verify-review-event-chain.mjs` pattern). That pass is a T2 companion, not something this design provides.
5. **Revision/md5 are optional in the schema** (`drive_revision`, `drive_md5` nullable — Drive does not
   always supply them) so a writer can forget them; `crm_drive_version_provenance` counts the gaps
   (`without_revision`, `without_md5`) rather than pretending they are absent. T2's contract should make
   them mandatory for `verified_local_recompute` rows; I left it a countable fact instead of an
   over-tight CHECK that would refuse legitimate Google responses.
6. **`crm_drive_duplicate_evidence` is only as good as coverage.** With 99 rows of `bootstrap_backfill`
   and 2 unregistered files, the outer/inner grouping currently has nothing verified to group on. Until
   bytes are read, the honest output is "no duplicate claim may be made" — which is what T1 already said.
7. **Growth is unbounded by design** — one row per observed content state per file, never pruned by a
   trigger. Fine at 101 files; if a future process re-hashes daily it becomes the dominant table, and any
   future retention rule must go through the same append-only discipline (a tombstone decision, not a
   delete).
8. **0011's escalation FK points into 0009.** A rollback of 0009 would break 0011's case table creation;
   the rollback note for both drafts therefore has to be `DROP`-in-dependent-order (views → triggers →
   tables, 0011 before 0010 before 0009) and must not touch `d1_migrations` rows of earlier migrations.
9. **Names in code.** The vocabulary blacklists (`auto`, `system`, `pipeline`, `matcher`, …) are labels,
   not identity: as in 0009, `reviewer_attestation = 'session_label_not_independent_identity'` records
   that honestly. A reviewer label is not proof of who the human was.

## 6. What is needed to approve T2

1. **Review the two drafts as SQL** (they are short by design; every refusal is in the file, not in a
   convention document). Say which of the two you approve, or neither.
2. **Decide the promotion order** (§5.3): schema → worker write-order change → `drive_ref` backfill →
   bootstrap versions → verification. Approving 0010 without step 2 is an outage, not a feature.
3. **Decide whether 0011 needs a ledger UI at all** in T2, or whether `crm_drive_file_review_state` read
   from the Worker/CI is enough for now (my recommendation: read-only first, exactly as 0009 was run).
4. **Explicit go-ahead for the T2 data step itself**, which is the first act that: reads file bytes for the
   two unregistered vCards (`0800b5e061ed…` 1540 B, `86362b958a1f…` 514 B), computes their digests, and
   writes to `nasr-crm-test-db`. Also decide the scope: those two only, **or** re-hash all 99 so
   `bootstrap_backfill` claims become `verified_local_recompute` measurements (my recommendation: both,
   in one pass, because the 99 rows are the ones that can silently lie today).
5. **No** production deploy, no Pages deploy, no merge of #132, no Drive write, and no
   `import/link/merge` of any contact remains in scope for T2; `import_performed = 0` is welded by a
   `CHECK` in both 0008 and 0011 so the boundary is in the data, not only in this sentence.

**Status: stopped here, awaiting your approval.** Nothing in this document pre-authorises reading file
contents or writing to D1.
