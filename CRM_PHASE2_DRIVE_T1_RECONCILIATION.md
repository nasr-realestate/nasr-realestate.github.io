# Phase 2 — T1: Drive ↔ registry reconciliation (final, both sides from their original source)

Task: T1 of `CRM_PHASE2_DRIVE_INTAKE_PLAN.md`. Read-only, no writes, no file contents.
Result: **Drive holds 101 files, the live registry holds 99 rows, and the plan reflects that real
difference**: `unchanged=99`, `register_new=2`, every other action `0`.

This supersedes the first attempt at T1 (commit `2235556`), which rebuilt the registry side from the
Phase 4 payload. That reconstruction is withdrawn: a reconciliation of Drive against a report about
the registry is not a reconciliation against the registry.

## 1. Drive side — how it was captured, and what is verified

Capture: `files.list` on the canonical folder, metadata only, no names, in **two pages of 51 and 50
rows** against a *frozen window*:

```
q        = '<folder> in parents and trashed = false and modifiedTime <= 2026-11-02T11:06:00Z'
order_by = modifiedTime asc, name          page_size = 51
```

* Why a window and an explicit order: the folder is **live**. A file appeared mid-task today
  (`2026-11-02T11:05:06Z`), so an unordered cursor could shift between pages and silently drop or
  repeat a row. With a frozen upper bound and a deterministic sort, arrivals cannot reorder the set.
* Why pages: one call for all 101 rows came back with the middle omitted and the connector reported
  `truncated:true`; it also holds that paging is the intended remedy. The connector offers no way to
  save a listing into the workspace (all 49 Drive tools were enumerated; none writes listing output to
  a file), so each page was written to `/tmp/p2/pageN.json` verbatim as received, and
  `listing.json` was **derived from those files by code**, not assembled by hand.
* Witness for the window: `modifiedTime > 2026-11-02T11:06:00Z` ⇒ **0 rows**, so nothing arrived after
  the bound while the capture ran. `trashed = true` ⇒ **0 rows**.
* Mechanical assertions in the builder (all passed): 51 + 50 = 101 rows; 101 distinct ids; every id
  matches `^1[0-9A-Za-z_-]{32}$`; every `size`/`version`/timestamp/mime shape valid; timestamps strictly
  ascending across the page boundary (proves the cursor neither skipped nor repeated a row); kinds
  `{zip: 90, vcf: 11}`.
* What is *not* automatic: the page contents passed through this conversation once, because no tool
  can write them to disk directly. It is therefore verified, not trusted, by three independent means
  — see §4, items 3–5. A single mistyped character in any of the 101 ids changes that row's ref and
  would break the join against the ids D1 stores for itself.

## 2. Registry side — a live, read-only D1 query, delivered programmatically

`nasr-crm-test-db.crm_drive_file_registry` is not reachable from this sandbox (no Cloudflare
credential, and `api.cloudflare.com` is not routable here), so the read runs in CI and comes back
through the one channel this sandbox can fetch reliably: a **pull-request comment**, read with
`gh api` and parsed with code. (Action logs and artifact downloads redirect to a host that is
unreachable here, which is why they are not used.)

* `scripts/crm/drive-registry-snapshot.mjs` builds the statement and formats the result; it has no
  network access and no write path. `.github/workflows/crm-drive-registry-snapshot.yml` (push-triggered
  on its own paths) resolves the database **by name**, sends that single SELECT, and publishes.
* Both sides of the join are keyed by the same function from the same source:
  `driveRefHash` imported from `_worker/crm-wa-vcard-analysis.js`, i.e.
  `sha256("crm-p4-v1\ndrive_ref\n<id>")` — a pure function with no secret, so CI's refs and the
  sandbox's refs are comparable by construction. No alternate formulation exists anywhere.
* `drive_file_id` is read **only** to reproduce that key and is dropped from the output; the emitted
  fields are `ref, size_bytes, content_sha256, inner_content_sha256, drive_modified_at, last_seen_at,
  drive_created_at, mime_type, content_type, processing_status, review_status`.
* Refusals, exercised by `selftest` (21/21 ALL_OK) and re-checked in shell before sending: anything not
  starting with SELECT/WITH, stacked statements, write/DDL keywords, and the columns `file_name`,
  `original_file_name`, `drive_path`, `drive_parent_id`, `error_message`, `processing_receipt_ref`, `id`
  — refused both in the SQL and in the returned rows; plus an **empty result** (reconciling against a
  zero-row registry would classify every file as new and look like a legitimate first intake), an
  implausible size, any value off its shape whitelist, and the raw id appearing in its own output.
* Measured from the published comment: `rows=99 uniq_refs=99 hashed=99 statuses={"processed":99}`,
  `min_modified_at=2026-10-29T17:17:43.226Z`, `max_modified_at=2026-10-30T23:59:31.255Z`,
  `refs_sha256=300c442a0c87885da6ffc1b1c52942a5732e47f6e725bb01e472b7d81c450504`. The digest was
  recomputed locally from the parsed rows and **matches** ⇒ the comment was not altered in transit and
  the rows are internally consistent. Marker `run=41447587696 sha=b155797…` ties it to this commit.

## 3. Result

`node scripts/crm/drive-intake-discovery.mjs plan --listing /tmp/p2/listing.json --registry /tmp/p2/registry.json`
→ `files_in_listing=101`, `files_in_registry=99`, `ref_scheme=crm-p4-v1/drive_ref`

| action | count |
| --- | --- |
| `unchanged` | **99** |
| `register_new` | **2** |
| `register_duplicate` / `register_new_version` / `link_verified_hash_pending` / `missing_from_listing` / `ignore_trash` | **0** |

`plan_sha256 = eae1efe2a36283913c01bf53ed942e4063159348d52023e44513e1f2c0bb617d`
(committed artifact `_worker/analysis/drive-phase2-t1-plan.json`, sha256 of the file bytes
`5633855070c0abb829a9041840a1214b8003270fc037c5bf9e5b526b89d4fcd9`; the two differ by design, the first
is over canonical JSON with the digest field nulled). `provisional_only=101`: a metadata listing yields
no content hash, so nothing here can or does assert a duplicate.

The two unregistered files, and nothing else:

| ref (first 12) | kind | size | drive_modified_at | version |
| --- | --- | --- | --- | --- |
| `0800b5e061ed` | vcf | 1540 | 2026-11-02T11:05:06.873Z | 2 |
| `86362b958a1f` | vcf | 514 | 2026-11-01T09:14:21.221Z | 2 |

Both are `register_new` with `review_status: not_required`, which means *no classification review is
needed for the file kind* — not that anything may be imported. Every plan carries
`not_authorized: [import_to_crm, link_contact, merge_contact, drive_write,
declare_duplicate_from_provisional_fingerprint]`.

## 4. The six checks that were asked for, and what they measured

1. **Drive file count** — 101, from `files.list` pages (51+50) with `next_page_token=null` on the last
   page, and a `> window` witness of 0 rows.
2. **D1 registry count** — 99, from the live `SELECT` (CI run 41447587696). `101 ≠ 99` is reported as
   the finding; no row was removed from the listing to force agreement, and no row was invented for the
   registry.
3. **Id uniqueness (Drive)** — 101 distinct ids over 101 rows, all shape-valid.
   **Ref uniqueness (registry)** — `uniq_refs=99` of 99 rows; the tool also refuses a duplicate ref.
4. **Registered set ⊆ Drive set** — all 99 registry refs are present in the listing; combined with the
   count that makes the registry set exactly the 99 oldest files, so `missing_from_listing=0` and the
   only asymmetry is the two newest files.
5. **The unregistered files land in the right class** — both are `register_new` (not duplicate, not
   version, not pending), and each was independently re-read with `files.get`, which returned the same
   size, mtime, version, mime and `trashed=false` as the capture.
6. **No personal data in committed output** — see §5.

## 5. Privacy of what is committed

Over `_worker/analysis/drive-phase2-t1-plan.json`: raw Drive ids present **0/101**; md5 values **0**;
Arabic codepoints **0**; e-mail matches **0**; digit runs ≥ 9 after masking hex **0**; `BEGIN:VCARD`,
`FN:`, `TEL`, `+20` **0**; 100 of its 101 refs already published in the committed payload, the 101st
being a one-way hash of the new file's id — the handle governance §5.5.2 prescribes for the repo.
The PR comment carries no raw id either (checked: 0 of 101 ids present). `listing.json`, the page files
and `registry.json` stay in `/tmp/p2`, `0700`/`0600`, never staged. The review gate's privacy sweep now
covers both new files and passes over 22 files.

## 6. Two defects found while doing this, both fixed here

1. **The registry side of the previous T1 was a reconstruction.** The corrected method found a
   difference it could not have seen: the folder has **101** files today, so the delta is **two**
   unregistered vCards, not one, and the 514-byte file is still unregistered two days after appearing.
2. **A privacy guard that rejected its own correct output.** The first draft refused any 11+ digit run,
   and a sha256 can easily contain twelve digits — the dry run failed on it. Hex digests are masked
   before that test now, and there is a regression case for exactly that. Two selftest fixtures that
   planted Arabic text and an address are assembled at run time so the committed source contains
   neither (the CI sweep would otherwise be right to reject the file).

During the push a sandbox reset dropped the branch ref onto `master`, so a commit was made against the
wrong parent. It was repaired by a soft reset onto the true tip after proving the two trees differed
only in these three files; the pushed commit `b155797` is `3 files changed, 389 insertions(+),
1 deletion(-)` — nothing else was carried along.

## 7. Writes performed

Drive: 7 read-only calls in this task (`files.list` × 5 — a 20-row probe, one whole-folder call that
came back truncated, the two capture pages, and the `> window` witness — plus `files.get` × 2),
**0 writes**. Cloudflare: 1 read-only `POST …/query` with a single SELECT,
executed by CI; **no migration, no DDL, no write statement**. GitHub: 2 pushes to this branch, 1
automated PR comment. D1 tables: untouched by this task. No deploy, no merge.

## 8. Standing findings for T2 (unchanged by the correction, and still not acted on)

1. A metadata listing cannot decide `register_duplicate`; dedupe needs bytes. Provisional fingerprints
   are ineligible for that verdict by construction.
2. `0007_crm_drive_file_registry.sql` stores `file_size`, `drive_modified_at`, `content_sha256`,
   `inner_content_sha256` and `last_seen_at`, but **no revision field** (`drive_version`/md5/etag),
   although the folder contains files at versions 2–6. A same-size, same-mtime content swap is
   invisible to any metadata reconciliation. T2 should store the revision and treat a re-hash as the
   only authoritative change test.
3. `link_verified_hash_pending` and `register_new_version` did not fire for the 99, so no registered
   file changed since it was recorded. That is a real negative result, now measured against D1 rather
   than against the payload.
4. The 514-byte vCard is now 2 days old and still unregistered; the 1540-byte one arrived at 11:05Z
   today. Awaiting registration is a policy state, not a discovery failure.
5. Neither `register_new` can open a 0009 review case yet: `crm_drive_review_case` requires
   `crm_contact_id NOT NULL` and `case_kind ∈ {file_to_contact, contact_fanout}`. That is a design
   question for T2, not a gap in T1.

## 9. Next — awaiting approval

T2 (register the two files: download, hash, write registry rows with `last_seen_at`, store the
revision) requires your explicit go-ahead: it is the first step that reads file contents and writes to
D1. Nothing in this report pre-authorises it.
