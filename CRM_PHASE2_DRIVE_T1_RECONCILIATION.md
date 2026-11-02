# Phase 2 — T1: Drive ↔ registry reconciliation (read-only)

Task: T1 of `CRM_PHASE2_DRIVE_INTAKE_PLAN.md`. Compare the live Drive folder with the file registry,
classify every file into one intake action, and report. **No writes anywhere, no file contents read.**
Status: complete. Result: `unchanged=99`, `register_new=1`, no other action fires.

## 1. Inputs and how they were obtained

| side | source | how |
| --- | --- | --- |
| Drive | folder `15HXNA…BE7a` («قاعده العملاء نظام CRM», parent `0AGx…PVA`) | 4 read-only `files.list` calls, **metadata only**, captured 2026-11-02 ~10:30–10:43 UTC |
| registry | `nasr-crm-test-db.crm_drive_file_registry` (99 rows, CI-measured) | reconstructed from the committed payload, see §3 |

Drive calls: full listing (100 rows, `next_page_token=null`, `incomplete_search=false`), the same
listing split by `mimeType='application/zip'` (90) and `'text/x-vcard'` (10), and `trashed = true` (0).

* File **names were deliberately not requested**. The connector truncates long Arabic names mid-response,
  and names are customer-facing bytes that this reconciliation does not need — content type comes from
  MIME and, in T2, from magic bytes, not from a suffix.
* The captured listing was transcribed to `/tmp/p2/drive.tsv` (dir `0700`, outside the repo).
  Transcription was then **proved**, not trusted: all 100 computed refs join the 100 payload refs
  (a mistyped id would orphan), and every joined row matches the payload on `size` and `modifiedTime`
  (`sizeMismatch=0 mtimeMismatch=0`). The 10 vCard ids were confirmed by an independent `mimeType`
  query whose sizes match the transcription exactly.
* Refs were produced by the Worker's own `driveRefHash` (`_worker/crm-wa-vcard-analysis.js`), imported by
  the discovery tool — not a local re-implementation. `ref_scheme = crm-p4-v1/drive_ref`.

## 2. Result

`node scripts/crm/drive-intake-discovery.mjs plan --listing /tmp/p2/listing.json --registry /tmp/p2/registry.json`

| action | count | meaning |
| --- | --- | --- |
| `unchanged` | 99 | same ref, same size, same `drive_modified_at` as registered |
| `register_new` | 1 | first sighting of this reference |
| `register_duplicate` | 0 | — |
| `register_new_version` | 0 | — |
| `link_verified_hash_pending` | 0 | — |
| `missing_from_listing` | 0 | nothing registered has disappeared from the folder |

`files_in_listing=100`, `files_in_registry=99`, kinds `{zip: 90, vcf: 10}`, `provisional_only=100`.

The single new row (the whole delta of T1):

```
ref 86362b958a1fc41f8e8cef3115f1ce3e3177d9cfee838e360496ea231694795b
kind vcf · size 514 B · drive_modified_at 2026-11-01T09:14:21.221Z · drive_version 2
fingerprint_level provisional · review_status not_required (classification only, see §5)
```

Digests — `plan_sha256 fdfc30be4966d306d4ae418bace5bdb61dc66cb89fab0df79a6ea7d817572af4`
(canonical, computed by the tool over the plan minus its own digest field); captured artifact digests
`listing.json 64b6391da8c437a8…`, `registry.json e8d53d1059f8b498…`, committed plan file
`1e08a41b04ec1100…` (sha256 of the file bytes; it differs from `plan_sha256` by design).

Every action set carries `not_authorized: [import_to_crm, link_contact, merge_contact, drive_write,
declare_duplicate_from_provisional_fingerprint]` — the plan is a proposal, not an instruction.

## 3. Why the registry side is trustworthy as a reconstruction

There is no Cloudflare credential in this sandbox, so the registry side was rebuilt from
`_worker/analysis/drive-phase4-payload.json` `registryUpdates` (100 rows, all `processing_status=processed`)
**minus the one row CI did not apply**. That subtraction is forced, not chosen:

* CI asserted `registryRows.length >= 99` and `deferredRefs.length <= 1`, where `deferredRefs` = payload
  rows absent from the live registry (`crm-phase4-analysis.yml:626-630`). Live registry measured 99 rows,
  payload has 100 ⇒ **exactly one** deferred row, and the registry's 99 rows are a subset of the payload.
* For those 99 rows the CI guard `SOURCE_DRIFT_AFTER_REGISTRATION` compares live `file_size` /
  `drive_modified_at` against the payload's `expected_size` / `expected_modified_at` and the run passed ⇒
  **on the only two fields T1 can compare, the live registry equals the payload**. The reconstruction is
  therefore equivalent to a live read for reconciliation purposes.
* The deferred row is identified as the 514 B vCard: its `expected_modified_at` (2026-11-01T09:14:21.221Z)
  is ~33 h newer than every other row (next newest 2026-10-30T23:59:31.255Z), and CI's own comment on that
  assert reads "exactly one file was added to Drive after the Phase 3 inventory". `driveRefHash` of that
  file's id equals that row's ref.

What the reconstruction does *not* reproduce: `file_name`, `original_file_name`, `drive_file_id`,
`last_seen_at` — D1-only columns T1 neither reads nor needs.

## 4. Diff against the prior inventory (nothing drifted)

* 100 files, 90 ZIP + 10 VCF — identical to the Phase-4 baseline. 0 trashed, **0 subfolders**.
* Newest file unchanged since capture: `514 B`, md5 `e99d8320…`, the same one recorded on 2026-11-01.
* No file's `modifiedTime` post-dates the payload `scanTimestamp 2026-11-01T10:25:53.055Z`; the largest
  file is `57 858 B`, so no upload has landed in the 24 h since. **The Phase-2 delta starts at 1 file.**
* Governance subfolders (`00_inbox`, `01_vcf_contacts`, `02_whatsapp_exports`, `90_archive_processed`,
  `91_archive_duplicates`, `99_review_hold`) **do not exist yet** — the folder is flat. T2 must treat the
  flat folder as the inbox and must not assume a move-based dedupe (T1 has no `drive_write` anyway).

## 5. Limits found while doing this (feed into T2)

1. **A metadata listing cannot prove content equality.** All 100 rows are `provisional` here, so
   `register_duplicate` can never fire from discovery alone — content bytes must be hashed to dedupe
   (governance rule 4). The tool encodes this by making provisional fingerprints ineligible for the
   duplicate verdict, and by listing it in `not_authorized`.
2. **The registry has no revision field.** `0007_crm_drive_file_registry.sql` stores `file_size`,
   `drive_modified_at`, `content_sha256`, `inner_content_sha256` — but no `drive_version`/md5/etag. A
   same-size, same-mtime content swap is invisible to this reconciliation. T2 should store `drive_version`
   (and treat re-hash as the only authoritative change test).
3. `drive_version` values in the folder are 2–6 — revisions *have* happened historically, so the risk in
   (2) is not hypothetical.
4. The new file already has a payload-measured `content_sha256`. Registration must **re-verify bytes**
   rather than adopt a ~24 h-old hash; adopting it silently would make the registry's claim
   "verified content" false.
5. Payload analysis found 100 distinct `content_sha256` but only 97 distinct `inner_content_sha256`
   (**3 inner-duplicate groups**) — different wrappers, same extracted content. Dedupe at intake must be
   two-level (container vs payload) or these three will re-appear as "new" files forever.
6. `review_status: not_required` in a `register_new` action means "no *classification* review needed", not
   "no governance review". Nothing in T1 authorises an import, a contact link, or a Drive write.

## 6. Privacy verification of committed artifacts

Run over the committed plan JSON (`_worker/analysis/drive-phase2-t1-plan.json`), using the repo's own
guard patterns plus direct containment tests: raw Drive ids present **0/100**; listing md5s present **0**;
`id_like` hits (the `crm-phase4-analysis.yml:151` regex) **0**; Arabic codepoints **0**; e-mail matches
**0**; digit runs ≥ 9 outside hex **0**; `BEGIN:VCARD`/`FN:`/`tel`/`+20` **0**; all 100 refs in the plan are
already present in the committed payload ⇒ **no new disclosure**. The plan carries hashed refs, sizes,
mtimes and versions only. `listing.json`, `registry.json`, `drive.tsv` and `plan.json` (with ids/md5s in
the first three) stay in `/tmp/p2` (`0700`) and are not committed.

### 6.1 A CI blind spot found while checking this, and repaired

Replaying the review gate's privacy-sweep step in this sandbox made it fail on
`scripts/crm/build-review-case-register.mjs` — a line of that script that *is* the guard's own
armor-header detector (five dashes then `BEGIN`). Investigating why CI never said so showed the step had been
**measuring nothing**: its file list was `git diff --name-only origin/master...HEAD`, and with
`actions/checkout@v4` at the default depth the base ref does not exist, so `git diff` failed into the
trailing `|| true` and the sweep ran over zero files and reported "clean". Two consequences, both fixed
here:

1. the list is now the explicit whitelist (`git ls-files` over 11 fixed paths), and an empty list is a
   hard error rather than a green check — it sweeps **20 files** and passes;
2. that script's detector is assembled at run time, so it can no longer trip the check it implements
   (selftest still `16/16 ALL_OK`).

Any earlier statement in this branch's history that "CI swept these files" was therefore weaker than it
sounded; from this commit on, it is a measurement.

## 7. Writes performed

Drive: 4 reads, **0 writes**. Cloudflare: **0 calls**. D1: **0 statements**. CRM tables: untouched
(`import=0`, `auto_link=0` as before).

Repository changes in this commit: this report; `_worker/analysis/drive-phase2-t1-plan.json` (the plan
artifact, privacy-scanned as §6); the ref-scheme fix in `scripts/crm/drive-intake-discovery.mjs`
(`selftest 18/18 ALL_OK`); the T1 status + two declared deviations in
`CRM_PHASE2_DRIVE_INTAKE_PLAN.md` §10; and the privacy-sweep repair of §6.1
(`.github/workflows/crm-review-0009-verify.yml` + the one-line detector change in
`scripts/crm/build-review-case-register.mjs`). No deploy, no PR merge, no T2 work.

## 8. Next

T2 (intake of the 1 new file + `drive_version`/`last_seen_at` handling) needs explicit authorisation: it
requires downloading file content, hashing it, and writing the registry. Nothing here pre-authorises it.
