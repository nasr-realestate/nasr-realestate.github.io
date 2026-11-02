# Draft 0011 on the Cloudflare D1 engine — rehearsal report (nothing applied anywhere real)

Companion to `CRM_PHASE2_DRIVE_0010_D1_TEST_REPORT.md`; read that one first for why a D1-engine harness
exists at all and for the governance frame, which is unchanged: **no migration applied, no write to
`nasr-crm-test-db`, `nasr-market-db` and the backup untouched, no file content read, no contact imported,
linked or merged, no Worker/Pages deploy, PR #132 not merged, no Drive file changed, no personal data in
Git or CI artifacts.**

Harness: `_worker/tests-draft/crm-file-review-0011.d1-rehearsal.py` — `wrangler 4.156.0` against a
throwaway local D1 file, 0010 applied first because 0011's barriers read 0010's ledger.
Result: **`D1_FILE_REVIEW 83/83 checks held` · `ALL_BARRIERS_HELD_ON_D1` · exit 0** (the node:sqlite
rehearsal re-ran green alongside it: 35/35).

| § | what it proves | checks |
| --- | --- | --- |
| 0 | the promotion starting state: 0002/0007/0008/0009 + 0010, 99 synthetic files, 99 bootstrap versions, one live and one revoked session | 10/10 |
| 1 | the runner applies 0011: **28 objects added** (`index=5 table=3 trigger=16 view=4`), **zero** pre-existing objects changed, zero rows changed, zero cases created | 7/7 |
| 2 | a review case for a file **with no contact** — the T2 capability — and what still cannot be faked | 12/12 |
| 3 | the decision ledger: density, chain, snapshot binding, session liveness, append-only | 15/15 |
| 4 | a link may only arrive through a named human decision, and may only leave through one | 11/11 |
| 5 | staleness: an old version cannot be closed as if it were current | 11/11 |
| 6 | the four views, each with a positive control so a clean read means something | 6/6 |
| 7 | **what an out-of-order promotion does** (0011 where 0010 is missing) | 4/4 |
| 8 | integrity, foreign keys, schema drift, and a rollback that is exact in both directions | 7/7 |

---

## 1. The additive claim, tested the hard way

0011 says "EFFECT ON EXISTING DATA: none" in its own header. On the engine, that was tested as three
separate facts rather than one:

* `changed == []` — comparing every object's stored DDL before and after the apply. Unlike 0010, 0011
  does **no `ALTER`**, so there is nothing to excuse: the registry table, 0007's indexes, all of 0008,
  all of 0009, and 0010's ledger/triggers/views are byte-identical afterwards. `set(INV0) - set(after11)`
  is also empty: it removes nothing.
* the digest of all 99 file rows (`id|content_sha256|processing_status|head_version_seq|drive_ref`, in id
  order) and of all 99 version rows (`version_ref|content_sha256|evidence_class|receipt_ref`) is
  **identical before and after** the migration — so "no row rewritten" is a measurement.
* `SELECT COUNT(*) FROM crm_drive_file_review_case` is 0 right after the apply: the migration cannot
  invent a review case for a file nobody has triaged.

## 2. The blocker T2 was about: a case with no contact

`crm_contact_id` is optional in 0011, and the harness proved both halves of that sentence on D1:

* **accepted** — a case for a new file with no contact at all: `link_state='none'`, `status='open'`,
  `has_contact_handle=0`, `freshness='current'`, bound to a version that exists;
* **refused** — the same case row *born* with a contact (`file_review_link_requires_a_recorded_decision`,
  the INSERT twin of the link barrier). That is the shape an automatic link would arrive in — a worker
  that "helpfully" fills the column while creating the row — and it cannot be written.

What stays impossible while the contact is optional: a case against a version the ledger does not carry
(no invented digest, and no case for a file the registry does not know); a second case for the same
(file, version); a hand-typed `case_ref` that does not match `('frw-' || drive_ref[0..16] || '-' || seq)`;
and any operational claim, since `import_implied`, `merge_authorized` and `contact_write_count` are nailed
to 0 by column CHECKs. The genesis anchor is written by a trigger, not by the caller, so the chain is
closed from before the first decision exists.

## 3. Decisions and links, as the engine refuses them

Refused, each with the named barrier: `file_review_decision_seq_broken` (a ledger that starts at seq 2);
`file_review_decision_snapshot_mismatch` (wrong snapshot, *and* a decision about a different version than
the case is bound to); `file_review_decision_session_not_live` (unknown token hash, **and a revoked
session** — the check is "live right now", not "a row exists"); `check constraint` on an
`'pipeline'` reviewer, on a reason containing a 9-digit id, and on all three operational nails;
`file_review_decisions_are_append_only` (UPDATE and DELETE of decisions),
`file_review_anchors_are_append_only` (UPDATE and DELETE of anchors);
`file_review_cases_are_permanent` (DELETE of a touched case);
`file_review_link_requires_explicit_human_basis` (a link written straight onto the row, a link
"approved" with no 0009 hand-off behind it, and a link erased by hand);
`escalation_target_case_not_found` (escalation must name a real case, never a label); and
`review_case_bound_version_is_stale` for both routes to a stale close (§5).

Allowed, deliberately, so the refusals above are not the whole story: a `noted` decision with no session
(it changes no state); `link_proposed` recorded by a named human with a live session, *after which* the
projection may carry `link_state='proposed'` with basis, confirmer, timestamp and pinned evidence;
an `unlink_recorded` decision, which clears the projection while the decision ledger keeps the record
(`crm_contact_id`, `link_basis` and `link_evidence_sha256` return to NULL; the three decisions stay); and
closing while the bound version is still head. Through all of it, `crm_contacts`, `crm_conversations` and
`crm_opportunities` still hold **0 rows**.

## 4. Staleness — the reason a file review cannot silently expire

A `close_no_action` decision closes the case while it is current. A new version then lands in 0010's
ledger (seq 2, forward timestamp), which moves the head. At that point:

* setting `status='decided'` by hand is refused — `review_case_bound_version_is_stale`;
* a *decision* that would close it is refused too, because the barrier sits on the projection update the
  decision itself triggers — so there is no route around it via the ledger;
* the refused decision left **nothing behind**: the ledger is still dense at four rows (a rolled-back
  AFTER trigger does not burn a sequence number), and `crm_drive_file_review_state` reports
  `stale_newer_version_exists` for the case while a further `noted` row is still accepted — history
  continues, conclusions do not;
* a new case cannot reuse the version that was already reviewed (the `(drive_ref, version_seq)` slot stays
  taken even after closing), and the second case for the new head is exactly what the design wants: two
  cases, each bound to its own version, readable side by side.

## 5. The finding that changes the promotion checklist

**Applying 0011 where 0010 is missing does not fail — D1 accepts it.** A trigger body is not resolved
against tables that do not exist yet, so the out-of-order apply in a second scratch database created 0011's
3 tables, 4 views, 5 indexes and 16 triggers with a green ✅ and no error. The ordering risk is silent.

It is, however, **fail-closed**: the first attempt to write a case hits `crm_drive_file_version` and errors,
so not one invented case can exist in that state; and applying 0010 afterwards, then re-running the runner,
leaves 0011 complete — 3/16/4/5 objects, the same as the ordered database — with the barrier now answering
in its own voice (`file_review_case_requires_a_recorded_version`) rather than as a missing-table crash. No
hand repair was needed; but it must not be relied on, because nothing in the apply output warns you.

So the promotion checklist gains a preflight assertion, which the CI job can run for free:

```sql
SELECT CASE WHEN EXISTS (SELECT 1 FROM sqlite_master
                          WHERE type='table' AND name='crm_drive_file_version')
            THEN 'ok' ELSE 'abort: 0010 must be applied before 0011' END AS preflight;
```

`_worker/migrations-draft/README.md` now carries this item; the ordering line ("0010 first") is no longer
just a convention.

## 6. Views, integrity, rollback

* `crm_drive_file_review_chain_integrity` reads the 5 decisions as dense (`seq_gaps=0`), linked
  (`broken_links=0`), anchored (`anchor_mismatches=0`, `anchors=5`, `first_seq=1`, `last_seq=5`).
* `crm_drive_file_review_isolation` returns `{forbidden_refs: 0, nails_loose: 0, unexplained_links: 0}` —
  and the harness proves the predicate behind those zeros can fire, by running the identical expression
  over a probe object that *does* reference `crm_contacts`: it returns 1. A clean read is a measurement.
* `crm_drive_file_review_ci_summary` exposes only dispositions and counts — the check asserts the row
  keys are a subset of `{review_disposition, cases, untouched, links_proposed, links_approved,
  stale_cases, decided, max_decisions, broken_links, seq_gaps, anchor_mismatches}` — so a CI log cannot
  leak a reviewer label, a contact handle or a digest; and it truthfully reports the stale case and the
  closed one.
* `PRAGMA integrity_check` is `ok` **on the file D1 wrote** (D1's SQL interface refuses that PRAGMA —
  measured in the 0010 rehearsal), `PRAGMA foreign_key_check` is empty, the schema digest did not move
  while 20-odd refusals and accepted writes ran (0011 gives data no path to DDL), and a rollback of 0011
  is **exact in both directions**: every pre-existing object survives byte-identical, none of its own 28
  objects remains, 0010's ledger still holds all 100 versions, and the 99 file rows and 100 versions are
  bit-for-bit what they were. Unlike 0010 there is no residual, because 0011 altered nothing.

## 7. Limits of this evidence

* **The full approved-link path was exercised only as a refusal.** The scratch database has no real 0009
  contact-review case, so `link_state='approved_by_contact_review'` was proven unreachable *without* one;
  reaching it requires an escalated case plus an `approve` event on that case, which is 0009's own
  contract, rehearsed separately (116 checks, plus this workflow's abuse harness at 113).
* No remote D1, no real rows, no content read: every digest and ref here is fabricated, and `SYNTH…` ids
  are the only file identifiers in the database.
* `head_version_seq_at_decision` is an audit field the writer supplies; the draft binds the *case* to a
  version and enforces staleness at close, but does not verify that number against the head at the moment
  of the decision. Stated, not hidden.
* 0011 is not deployable on its own either: the intake path that opens a case (`review_disposition`,
  snapshot and genesis hashes) has to be written against these columns, and until it is, the tables stay
  empty — which is the correct resting state, not a broken one.

## 8. What T2 still needs from you

Same four gates as the 0010 report: approval of the design (now including the preflight assertion in §5),
approval of the companion writer changes, permission to read Drive file content, and a decision on the
`crm-test-deploy` environment gate. Until you say otherwise I stop here: drafts, rehearsals and CI only.

Reproduce locally:

```bash
npm install --no-save wrangler@4.156.0
KEEP=1 WRANGLER=$PWD/node_modules/.bin/wrangler \
  python3 _worker/tests-draft/crm-file-review-0011.d1-rehearsal.py
```
