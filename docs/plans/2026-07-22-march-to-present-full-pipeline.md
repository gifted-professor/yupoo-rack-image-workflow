# March-to-Present Full Yupoo Pipeline Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Reliably discover and process every Yupoo product whose detail page contains original pictures dated from 2026-03-01 through the execution cutoff, skip only demonstrably complete products, resume partial products, generate five review images and an XHS cover, expose them in the 8910 review desk, and synchronize evidence-backed status to Feishu without auto-publishing.

**Architecture:** Add one explicit state machine and one reconciliation layer between discovery and execution. Discovery produces an immutable source snapshot; reconciliation derives each SKU's state from catalog data plus local artifacts; the orchestrator executes only the missing stages and writes atomic checkpoints. Existing CPA image generation, deterministic price rendering, cover composition, dashboard review, and final human approval remain the production implementations rather than being duplicated.

**Tech Stack:** Node.js ESM, Python 3, Pillow, JSON manifests, existing CPA image bridge at `127.0.0.1:8907`, CPA proxy at `127.0.0.1:8317`, `gpt-image-2`, Feishu Base through `lark-cli`, Node test runner plus existing Python `unittest`, Tailscale-hosted review desk on port `8910`.

---

## 1. Fixed scope and safety contract

The production run uses these immutable boundaries:

- Start picture date: `2026-03-01`, inclusive.
- End picture date: the Asia/Shanghai calendar date captured once when discovery starts, inclusive; never use a moving `now` during pagination.
- Source: the explicitly configured Yupoo seller/account only.
- Identity: normalized SKU is the business key; Yupoo album ID and URL remain source evidence.
- Date authority: the visible Yupoo date printed under each original picture in the product detail page. Do not use the local filename date, HTTP timestamp, scrape time, album-list ordering, or an inferred album publication time.
- Inclusion rule: include a product when at least one picture has a visible Yupoo date inside the range. Once included, ingest all pictures in that product album so front/back/detail evidence is not lost.
- Mixed-date rule: preserve the date of every picture, plus `picture_date_min`, `picture_date_max`, and `in_range_picture_count`. If every picture is before the start, exclude the product. If all picture dates are missing, send it to a blocking undated report instead of silently including or excluding it.
- Generation views: `front`, `back`, `tryon_main`, `tryon_detail`, `tryon_back`.
- Publishing: stop at `REVIEW_PENDING` until a human confirms in the 8910 review desk.
- Existing `APPROVED`, queued, or published packages are immutable unless both `--force` and a specific `--sku` are supplied.
- A directory, catalog flag, or successful HTTP response alone is never completion proof.
- Every external write supports `--dry-run`; discovery snapshots and local checkpoints may be written only when explicitly running the matching non-dry command.
- A run can be interrupted after any SKU/view and resumed without regenerating successful work.

The canonical states are:

```text
DISCOVERED
INGEST_REQUIRED
INGESTED
CONFIG_REQUIRED
READY_TO_GENERATE
GENERATING
PARTIAL_RESUME
REVIEW_PENDING
REPAIR_REQUIRED
COVER_REQUIRED
COVER_READY
APPROVED
QUEUED
PUBLISHED
FAILED_RETRYABLE
FAILED_BLOCKED
SKIPPED_COMPLETE
```

## 2. Completion evidence matrix

| Stage | Required evidence | If missing |
|---|---|---|
| Discovered | SKU, album ID, canonical URL, title, per-picture visible Yupoo dates, at least one in-range picture | `FAILED_BLOCKED` |
| Ingested | `manifest.json`, at least one readable original, source URL, SHA-256 per original | `INGEST_REQUIRED` |
| Configured | classification and batch configuration, confirmed `color_authority`, valid front/back references, positive cost | `CONFIG_REQUIRED` |
| Generated | latest successful artifact for all five views, readable 1080x1440 file, matching response record | `READY_TO_GENERATE` or `PARTIAL_RESUME` |
| Price preview | front/back preview manifest matches latest source image and current sale price | rebuild preview |
| Cover | readable `four-grid.jpg`; manifest sources match current front/back previews and try-on images | `COVER_REQUIRED` |
| Review | all five current artifacts and cover visible at 8910; no unresolved factual blocker | `REVIEW_PENDING` |
| Approved | approval signal revision matches current draft and image versions | `APPROVED` |
| Queued | publish queue event exists and references finalized five-image package | `QUEUED` |
| Published | external publish ID plus timestamp and destination evidence | `PUBLISHED` |

`KT3055` is the regression fixture for partial work: an existing item directory with originals/draft but no five-view generation or cover must resolve to `READY_TO_GENERATE` or `PARTIAL_RESUME`, never `SKIPPED_COMPLETE`.

---

### Task 1: Freeze the current baseline and add automation test entrypoints

**Files:**
- Modify: `package.json`
- Create: `tests/fixtures/automation/README.md`
- Create: `tests/automation-state.test.mjs`

**Step 1: Add a failing test proving an existing directory is not completion**

Create a temporary item containing only `manifest.json`, call the future reconciliation function, and assert that the state is not `SKIPPED_COMPLETE`.

```js
assert.equal(result.state, 'READY_TO_GENERATE');
assert.deepEqual(result.missing_views, REQUIRED_VIEWS);
```

**Step 2: Run the focused test**

Run:

```bash
node --test tests/automation-state.test.mjs
```

Expected: FAIL because the reconciliation module does not exist.

**Step 3: Add test scripts without changing production behavior**

Add:

```json
"test:automation": "node --test tests/*.test.mjs",
"test": "npm run test:py && npm run test:automation && npm run preflight"
```

**Step 4: Run the existing baseline**

Run:

```bash
npm run test:py
npm run preflight
```

Expected: existing 20 Python tests pass and generation preflight returns `ok: true`.

**Step 5: Commit**

```bash
git add package.json tests/automation-state.test.mjs tests/fixtures/automation/README.md
git commit -m "test: define full-pipeline automation baseline"
```

---

### Task 2: Define the catalog schema and state transition rules

**Files:**
- Create: `scripts/catalog-state.mjs`
- Create: `config/sku-catalog.schema.json`
- Modify: `config/sku-catalog.json`
- Modify: `tests/automation-state.test.mjs`

**Step 1: Write failing schema and transition tests**

Cover:

- SKU normalization trims whitespace and uppercases Latin characters.
- Duplicate discovery rows merge by normalized SKU.
- Multiple album IDs remain in `sources`.
- `PUBLISHED` cannot transition back automatically.
- `FAILED_RETRYABLE` can return to its missing stage.
- `--force` is rejected without a specific SKU.

Use catalog records shaped as:

```json
{
  "sku": "KT3055",
  "sources": [{
    "album_id": "123456789",
    "url": "https://seller.x.yupoo.com/albums/123456789",
    "picture_dates": ["2026-06-17"],
    "picture_date_min": "2026-06-17",
    "picture_date_max": "2026-06-17",
    "in_range_picture_count": 6,
    "discovered_at": "2026-07-22T01:00:00+08:00"
  }],
  "state": "READY_TO_GENERATE",
  "stage_evidence": {},
  "last_error": null,
  "updated_at": "2026-07-22T01:00:00+08:00"
}
```

**Step 2: Run tests and confirm failure**

Run `node --test tests/automation-state.test.mjs`.

Expected: FAIL on missing `catalog-state.mjs` exports.

**Step 3: Implement pure functions**

Export:

```js
normalizeSku(value)
mergeCatalog(existing, discovered)
assertTransition(previous, next, options)
isLockedState(state)
```

No filesystem or network access belongs in this module.

**Step 4: Migrate the catalog conservatively**

Convert the current `status` field into `state`, but do not translate every existing `completed` record to `SKIPPED_COMPLETE`. Mark them `NEEDS_RECONCILIATION` and let Task 5 derive the real state from artifacts.

**Step 5: Run tests**

Run `npm run test:automation`.

Expected: PASS.

**Step 6: Commit**

```bash
git add scripts/catalog-state.mjs config/sku-catalog.schema.json config/sku-catalog.json tests/automation-state.test.mjs
git commit -m "feat: add evidence-based SKU state model"
```

---

### Task 3: Replace the broken Yupoo discovery implementation

**Files:**
- Modify: `src/product_image_workflow.py`
- Modify: `scripts/yupoo-discover.mjs`
- Create: `tests/fixtures/yupoo/list-page-1.html`
- Create: `tests/fixtures/yupoo/list-page-2.html`
- Create: `tests/fixtures/yupoo/product-page.html`
- Modify: `tests/test_workflow.py`
- Create: `tests/yupoo-discover.test.mjs`

**Step 1: Capture sanitized fixtures from the actual Yupoo account**

Save one list page with a next-page link, one last page, and product detail pages with same-date, mixed-date, and missing-date pictures. Keep album IDs, the visible date beneath each picture, title structure, and image attributes; remove cookies and unrelated private content. Include the demonstrated `KT7794` shape where all six pictures visibly show `2026-06-17`.

**Step 2: Write failing parser tests**

The Python parser must:

- derive the seller origin from the supplied Yupoo URL;
- recognize actual `/albums/<id>` links;
- return the next page/cursor;
- enter each product detail page and parse the visible date associated with each original picture;
- treat the visible `2026-06-17` under the KT7794 pictures as authoritative even if a screenshot filename contains `2026-06-16`;
- preserve the canonical album URL;
- never construct a Feishu URL;
- deduplicate repeated album links.

**Step 3: Run the focused Python tests**

Run:

```bash
.venv/bin/python -m unittest tests.test_workflow.WorkflowTests.test_discover_yupoo_listing -v
```

Expected: FAIL against the current hard-coded link logic.

**Step 4: Implement discovery as structured data**

Change `discover-album` output to:

```json
{
  "source": "https://seller.x.yupoo.com/albums",
  "captured_at": "...",
  "products": [{
    "sku": "KT7794",
    "album_id": "...",
    "url": "...",
    "pictures": [{"url": "...", "visible_date": "2026-06-17"}],
    "picture_date_min": "2026-06-17",
    "picture_date_max": "2026-06-17",
    "in_range_picture_count": 6
  }],
  "next_page": null,
  "warnings": []
}
```

If all picture dates are unavailable, return the product with `visible_date: null`, `in_range_picture_count: 0`, and a blocking warning. Do not silently include or exclude fully undated products in a date-bounded production run. If at least one picture is in range, retain the whole product and every picture, including older detail pictures needed as generation references.

**Step 5: Add pagination and fixed cutoff handling to Node**

Support:

```text
--album-url
--from 2026-03-01T00:00:00+08:00
--to <fixed ISO timestamp>
--max-pages
--snapshot <path>
--dry-run
```

Do not stop based only on album-list ordering because the authoritative date exists inside product detail pages. Stop when the next page is absent; add loop detection for repeated cursors/URLs. An optional early-stop optimization may be introduced only after a test proves the seller's list ordering and picture-date monotonicity across multiple pages.

**Step 6: Test pagination, picture-date boundaries, mixed dates, and duplicate pages**

Run:

```bash
node --test tests/yupoo-discover.test.mjs
```

Expected: inclusive boundary handling against picture-level visible dates, KT7794 included as `2026-06-17`, mixed-date albums included when at least one picture is in range, stable product count, and no duplicate SKUs/albums.

**Step 7: Live read-only acceptance**

Run the actual account with `--dry-run --snapshot` disabled first. Verify several first/middle/last products manually against the browser before permitting snapshot writes.

**Step 8: Commit**

```bash
git add src/product_image_workflow.py scripts/yupoo-discover.mjs tests/fixtures/yupoo tests/test_workflow.py tests/yupoo-discover.test.mjs
git commit -m "feat: discover date-bounded Yupoo albums reliably"
```

---

### Task 4: Make Feishu synchronization deterministic and bidirectional

**Files:**
- Modify: `scripts/sync-catalog.mjs`
- Create: `scripts/feishu-status.mjs`
- Create: `tests/fixtures/feishu/record-list.json`
- Create: `tests/feishu-sync.test.mjs`
- Modify: `config/destinations.json` only if field mapping belongs there; otherwise create `config/feishu-fields.json`

**Step 1: Write a fixture reproducing the current 44-row/22-SKU duplication**

Include two rows or repeated projections for the same SKU and status values in the exact shapes returned by `lark-cli`.

**Step 2: Write failing tests**

Assert:

- 44 returned rows normalize to 22 unique SKUs.
- Existing catalog URLs and states are updated when Feishu contains newer source data.
- Duplicate input never creates duplicate catalog entries.
- Unknown status text produces a warning, not `pending` by default.
- dry-run produces a change set and performs zero writes.

**Step 3: Extract pure parsing and merge functions**

Export:

```js
parseFeishuRows(payload, fieldMap)
dedupeFeishuRecords(records)
planCatalogChanges(catalog, records)
planStatusWrites(catalog, records)
```

**Step 4: Implement status writeback as a separate command**

Write only these evidence-backed fields:

```text
处理状态
原图抓取
生图进度
封面状态
审核状态
最新 Run ID
错误原因
最后更新时间
审核链接
```

Use record IDs for updates. Batch writes in small groups and record every response in `runs/<run-id>/feishu/`.

**Step 5: Add `--dry-run` and `--direction pull|push|both`**

Default to `pull`. Production `push` requires a saved reconciliation report for the same run ID.

**Step 6: Run fixture tests and live pull dry-run**

Expected: 22 unique current SKUs, explicit warnings for unmapped fields, zero remote writes.

**Step 7: Commit**

```bash
git add scripts/sync-catalog.mjs scripts/feishu-status.mjs tests/fixtures/feishu tests/feishu-sync.test.mjs config/feishu-fields.json
git commit -m "feat: synchronize deduplicated SKU state with Feishu"
```

---

### Task 5: Build the local artifact reconciler

**Files:**
- Create: `scripts/reconcile-catalog.mjs`
- Create: `scripts/artifact-state.mjs`
- Modify: `tests/automation-state.test.mjs`

**Step 1: Add fixture matrices for every partial state**

Create temporary layouts representing:

- empty SKU;
- originals only;
- facts without classification;
- two of five generated views;
- five views without previews;
- previews without cover;
- complete review package;
- stale cover pointing at older images;
- approved package with a changed draft;
- queued and published package.

**Step 2: Write failing reconciliation tests**

The result must include:

```json
{
  "sku": "KT3055",
  "state": "READY_TO_GENERATE",
  "completed_stages": ["ingest", "facts"],
  "missing_views": ["front", "back", "tryon_main", "tryon_detail", "tryon_back"],
  "stale_artifacts": [],
  "blockers": [],
  "next_action": "generate"
}
```

**Step 3: Implement file validation**

Validation must check readability, dimensions, manifest/source agreement, price equality, and current revision. A filename alone is insufficient.

**Step 4: Make reconciliation read-only by default**

Command:

```bash
node scripts/reconcile-catalog.mjs --catalog config/sku-catalog.json --report runs/<run-id>/reconciliation.json --dry-run
```

Only `--apply` may update catalog states, and it must use atomic rename.

**Step 5: Test against the live 22-SKU workspace**

Acceptance includes:

- `KT3055` is not complete.
- the 21 products with five views and covers are not scheduled for regeneration unless an artifact is stale.
- approved/queued/published records remain locked.

**Step 6: Commit**

```bash
git add scripts/reconcile-catalog.mjs scripts/artifact-state.mjs tests/automation-state.test.mjs
git commit -m "feat: reconcile SKU state from real artifacts"
```

---

### Task 6: Separate ingestion from classification and generation

**Files:**
- Modify: `src/product_image_workflow.py`
- Create: `scripts/ingest-products.mjs`
- Modify: `tests/test_workflow.py`
- Create: `tests/ingest-products.test.mjs`

**Step 1: Write a failing test for ingest-only behavior**

Given cached product HTML, `ingest-album` must download/copy originals and write a manifest without requiring a pre-existing classification file.

**Step 2: Add a dedicated Python subcommand**

```text
ingest-album --album-url ... --output-root work/items --cached-html ...
```

It writes atomically:

- `manifest.json` with source URL, album ID, title, per-picture visible Yupoo dates, date range, and in-range picture count;
- numbered originals;
- SHA-256, MIME type, width, height, and original image URL for every file.

**Step 3: Make repeated ingestion idempotent**

Matching source hashes are retained. Changed remote images produce a new manifest revision and mark downstream generated artifacts stale; do not overwrite proof without recording the old revision.

**Step 4: Add a pooled Node ingestion runner**

Run low concurrency, use bounded retry for network errors, and checkpoint each SKU independently.

**Step 5: Run fixture and three-SKU live tests**

Expected: repeat run downloads zero unchanged images and preserves hashes.

**Step 6: Commit**

```bash
git add src/product_image_workflow.py scripts/ingest-products.mjs tests/test_workflow.py tests/ingest-products.test.mjs
git commit -m "feat: add resumable Yupoo product ingestion"
```

---

### Task 7: Generate evidence-backed classification drafts and batch configs

**Files:**
- Create: `scripts/build-classification-drafts.mjs`
- Create: `scripts/build-generation-batches.mjs`
- Create: `config/classification-rules.json`
- Create: `tests/classification-drafts.test.mjs`
- Modify: `dashboard/app.js`
- Modify: `scripts/review-dashboard.mjs`

**Step 1: Write failing deterministic tests**

Test SKU parsing, product type, known colors/sizes from titles, view reference selection, and refusal to invent cost, season, material, or function.

**Step 2: Define confidence and blockers**

Every draft contains:

```json
{
  "status": "CONFIG_REQUIRED",
  "confidence": {},
  "blockers": [],
  "evidence": {},
  "candidate_views": {},
  "confirmed": false
}
```

`color_authority`, front/back direction, product type, and positive cost are mandatory before generation.

**Step 3: Generate drafts without silently confirming them**

Reuse existing classification files when their source manifest revision still matches. Generate a candidate for new products; ambiguous products remain blocked.

**Step 4: Add configuration review to 8910**

Show originals, proposed front/back/color references, cost, and blockers. Confirmation writes a revisioned classification file; no generation starts from an unconfirmed draft.

**Step 5: Compile stable batch files**

Batch compiler uses only confirmed classifications and writes batches of configurable size. Each item contains five views and satisfies the maximum-five-reference rule.

**Step 6: Validate batches with the existing generator dry-run**

Run every produced batch through:

```bash
node scripts/generate-racks.mjs --batch <batch> --dry-run
```

Expected: no missing references, positive cost, correct 1080x1440 canvas, and five configured views.

**Step 7: Commit**

```bash
git add scripts/build-classification-drafts.mjs scripts/build-generation-batches.mjs config/classification-rules.json tests/classification-drafts.test.mjs dashboard/app.js scripts/review-dashboard.mjs
git commit -m "feat: prepare reviewable five-view generation configs"
```

---

### Task 8: Replace the placeholder auto-generator with a resumable orchestrator

**Files:**
- Rewrite: `scripts/auto-generate.mjs`
- Create: `scripts/full-run.mjs`
- Create: `tests/full-run.test.mjs`

**Step 1: Write failing orchestration tests with fake child commands**

Cover:

- dry-run invokes no mutating child command;
- complete SKU is skipped;
- partial SKU invokes only its missing stage/views;
- one SKU failure does not mark it completed or stop unrelated SKUs;
- interruption preserves completed checkpoints;
- resume uses the same discovery snapshot and cutoff;
- `--force` requires `--sku`;
- locked approval/publish states are protected.

**Step 2: Define one run directory**

```text
runs/full-<timestamp>/
├── run.json
├── discovery.json
├── reconciliation.json
├── plan.json
├── checkpoints/
├── generation/
├── feishu/
└── final-report.json
```

`run.json` stores start/end boundaries, source URL, git commit, config hashes, CPA preflight result, command arguments, and status.

**Step 3: Implement explicit modes**

```text
full-run discover
full-run plan
full-run execute
full-run resume --run-id ...
full-run status --run-id ...
```

No mode should imply a later mode. `execute` requires a saved plan whose source/config hashes still match.

**Step 4: Execute real existing components**

The orchestrator must actually call:

- Yupoo ingestion;
- classification/batch preparation;
- `generate-racks.mjs` for needed views;
- price preview builder;
- XHS cover builder;
- reconciler;
- Feishu status writer.

Never print success before checking exit code and expected output artifacts.

**Step 5: Add bounded retry policy**

- HTTP timeout/429/5xx: retry with capped exponential backoff.
- invalid response/no image: retry once, then `FAILED_RETRYABLE`.
- missing evidence/config/cost: no retry; `FAILED_BLOCKED`.
- QA failure: `REPAIR_REQUIRED`, never automatic full regeneration.

**Step 6: Add graceful interruption**

On SIGINT/SIGTERM, stop scheduling new work, await current writes, persist checkpoints, set run state `INTERRUPTED_RESUMABLE`, and exit nonzero.

**Step 7: Run fake integration tests**

Expected: exact child command order and zero false completion.

**Step 8: Commit**

```bash
git add scripts/auto-generate.mjs scripts/full-run.mjs tests/full-run.test.mjs
git commit -m "feat: orchestrate resumable full product processing"
```

---

### Task 9: Add generation preflight, view-level resume, and production limits

**Files:**
- Modify: `scripts/generate-racks.mjs`
- Modify: `scripts/workflow-lib.mjs`
- Modify: `tests/full-run.test.mjs`

**Step 1: Write failing view-resume tests**

Given two valid current views and three missing views, assert that only the three missing jobs are sent to the bridge.

**Step 2: Add `--views` and `--resume-from` support**

Do not infer success from old filenames. Resume inputs must come from reconciliation output and match the current config/source revision.

**Step 3: Strengthen preflight**

Before production generation verify:

- `8907 /api/config` is reachable;
- `imageModel === gpt-image-2`;
- proxy reports `127.0.0.1:8317` or the approved configured equivalent;
- all references are readable;
- disk has a configured minimum free-space reserve;
- no second full-run lease is active.

**Step 4: Add a run lease**

Use an atomic lock containing run ID, PID, hostname, start time, and heartbeat. Stale takeover must be explicit and recorded.

**Step 5: Keep production concurrency at the validated default**

Start at `4`; allow reduction after 429/timeouts, but never dynamically increase above configured maximum.

**Step 6: Test with a fake bridge, then one real SKU**

Expected: exact five outputs for a new SKU, only missing outputs for a partial SKU, response evidence saved for every successful view.

**Step 7: Commit**

```bash
git add scripts/generate-racks.mjs scripts/workflow-lib.mjs tests/full-run.test.mjs
git commit -m "feat: resume generation safely at view granularity"
```

---

### Task 10: Make price previews and XHS covers provenance-aware

**Files:**
- Modify: `scripts/build-price-previews.mjs`
- Modify: `scripts/build-xhs-covers.mjs`
- Modify: `src/product_image_workflow.py`
- Modify: `tests/test_workflow.py`
- Create: `tests/postprocess.test.mjs`

**Step 1: Write failing stale-artifact tests**

Changing any of these must invalidate the relevant output:

- front/back generated image hash;
- sale price;
- try-on image hash;
- cover layout or zoom;
- renderer version.

**Step 2: Add source hashes to manifests**

Price preview and cover manifests store input paths, hashes, sale price, layout, dimensions, renderer version, and generation time.

**Step 3: Rebuild only stale outputs**

Fresh matching manifests are cache hits. Missing/mismatched sources fail closed and leave the product in `COVER_REQUIRED` or an earlier stage.

**Step 4: Preserve review status**

A newly rebuilt cover is always `REVIEW_PENDING`; rebuilding must invalidate any approval revision that referenced the old cover.

**Step 5: Run Python and Node tests**

Expected: exact 1080x1440 cover, current price on front/back previews, complete uncropped source treatment, no stale cache reuse.

**Step 6: Commit**

```bash
git add scripts/build-price-previews.mjs scripts/build-xhs-covers.mjs src/product_image_workflow.py tests/test_workflow.py tests/postprocess.test.mjs
git commit -m "feat: validate price and cover artifact provenance"
```

---

### Task 11: Extend the 8910 review desk for full-run operations

**Files:**
- Modify: `scripts/review-dashboard.mjs`
- Modify: `dashboard/app.js`
- Modify: `dashboard/index.html`
- Modify: `dashboard/styles.css`
- Create: `tests/review-dashboard.test.mjs`

**Step 1: Write API tests**

Assert that the API exposes catalog state, missing stages/views, per-picture Yupoo dates, picture-date range, in-range count, run ID, cover revision, and blockers. A partial SKU must remain visible with a clear resume state.

**Step 2: Add operational filters**

Provide filters for:

- date range;
- new/partial/blocked/review/approved/published;
- missing view;
- run ID;
- destination.

**Step 3: Separate actions by authority**

- “确认配置” only confirms classification.
- “重新生成视角” creates a repair request, not an immediate untracked call.
- “确认、写价并入队” remains the final human gate.
- published products cannot be mutated from the ordinary review action.

**Step 4: Display provenance**

Show Yupoo URL/date, latest image run, source revision, cover status, price-preview status, and Feishu sync status.

**Step 5: Add validation-only approval tests**

Use the existing `validate_only` path to prove approval eligibility without writing final images, queue files, or signals.

**Step 6: Run dashboard tests and live smoke check**

Expected: 22 current products still render, `KT3055` clearly shows incomplete, and no existing approval signal changes.

**Step 7: Commit**

```bash
git add scripts/review-dashboard.mjs dashboard tests/review-dashboard.test.mjs
git commit -m "feat: expose full-run state in review dashboard"
```

---

### Task 12: Produce audit reports, metrics, and recovery tooling

**Files:**
- Create: `scripts/full-run-report.mjs`
- Create: `scripts/verify-full-run.mjs`
- Create: `tests/full-run-report.test.mjs`

**Step 1: Write failing report tests**

The report must reconcile every discovered SKU into exactly one final state and reject count mismatches.

**Step 2: Generate machine and human reports**

Write:

```text
runs/<run-id>/final-report.json
runs/<run-id>/final-report.md
```

Include:

- fixed picture-date window and source snapshot hash;
- discovered albums and unique SKUs;
- excluded before/after-date counts;
- new, complete-skip, partial-resume, blocked, generated, review, repair, approved, queued, published, and failed counts;
- per-view generation attempts and failures;
- CPA/model evidence;
- Feishu pull/push counts;
- unresolved SKU table with exact next action.

**Step 3: Add verifier invariants**

Fail if:

- discovered total does not equal the sum of terminal run buckets;
- a `SKIPPED_COMPLETE` SKU lacks required evidence;
- a generated SKU lacks response records;
- a cover source is stale;
- an approved/queued product has a stale revision;
- Feishu claims a later state than local evidence.

**Step 4: Add repair-plan export**

Produce a new input plan containing only retryable failures and `REPAIR_REQUIRED` views. It must never include complete or locked products.

**Step 5: Run tests**

Expected: intentional fixture mismatches fail with the affected SKU and invariant name.

**Step 6: Commit**

```bash
git add scripts/full-run-report.mjs scripts/verify-full-run.mjs tests/full-run-report.test.mjs
git commit -m "feat: audit and verify full pipeline runs"
```

---

### Task 13: Document operator commands and stop/resume procedures

**Files:**
- Modify: `README.md`
- Modify: `docs/WORKFLOW.md`
- Modify: `docs/RUNBOOK.md`
- Modify: `docs/DECISIONS.md`

**Step 1: Document the exact production sequence**

```bash
node scripts/full-run.mjs discover --album-url '<URL>' --from '2026-03-01T00:00:00+08:00' --to '<FIXED_CUTOFF>' --dry-run
node scripts/full-run.mjs discover --album-url '<URL>' --from '2026-03-01T00:00:00+08:00' --to '<FIXED_CUTOFF>'
node scripts/full-run.mjs plan --run-id '<RUN_ID>'
node scripts/full-run.mjs execute --run-id '<RUN_ID>' --dry-run
node scripts/full-run.mjs execute --run-id '<RUN_ID>'
node scripts/full-run.mjs status --run-id '<RUN_ID>'
node scripts/full-run.mjs resume --run-id '<RUN_ID>'
node scripts/verify-full-run.mjs --run-id '<RUN_ID>'
```

**Step 2: Document stop behavior**

One interrupt stops new scheduling and saves a resumable checkpoint. Explain how to verify the run is inactive before resuming.

**Step 3: Document recovery by state**

Provide exact actions for network errors, CPA 429/5xx, invalid images, missing cost, ambiguous view direction, stale previews, failed cover composition, Feishu mismatch, and approval revision conflict.

**Step 4: Document non-goals**

- no automatic final publication;
- no bypass of configuration/image review;
- no regeneration of approved/published products by default;
- no use of catalog `completed` flags without artifact verification.

**Step 5: Run all checks**

```bash
npm test
git diff --check
```

Expected: all tests pass and no whitespace errors.

**Step 6: Commit**

```bash
git add README.md docs/WORKFLOW.md docs/RUNBOOK.md docs/DECISIONS.md
git commit -m "docs: add full-run operations and recovery guide"
```

---

## 3. Production rollout plan

Implementation completion does not authorize immediately running the whole date range. Use these gates in order.

### Gate A: Read-only inventory

Run discovery, Feishu pull, and reconciliation with zero external writes. Manually verify:

- five newest products;
- five oldest in-range products;
- five random middle products;
- all duplicate SKUs;
- all products with every picture date missing;
- mixed-date products and their in-range picture counts;
- KT7794 showing six pictures dated `2026-06-17`;
- `KT3055` partial-state handling.

Acceptance:

- no Yupoo page omitted between cursors;
- picture-level date boundaries are correct;
- unique SKU count is stable across two repeated dry-runs;
- discovery snapshot hashes match;
- zero local catalog mutation and zero Feishu writes in dry-run.

### Gate B: Three-SKU canary

Select:

1. one entirely new SKU;
2. `KT3055` or another partial SKU;
3. one complete SKU that must be skipped.

Acceptance:

- new SKU reaches `REVIEW_PENDING` with five views, price previews, and cover;
- partial SKU resumes only missing work;
- complete SKU sends zero generation requests;
- all three appear correctly at 8910;
- Feishu dry-run proposes correct changes;
- no final approval, queue, or publication occurs.

### Gate C: Ten-SKU pilot

Use a representative mix of shirts, shorts, jackets, simple/complex back designs, new and partial products.

Acceptance:

- interruption and resume are tested once deliberately;
- count reconciliation is exact;
- generation failures remain attached to the correct view;
- retry does not duplicate successful work;
- cover provenance matches latest images;
- CPA preflight and model evidence are saved.

### Gate D: Full March-to-cutoff execution

Freeze the approved discovery snapshot and plan. Process in bounded batches, newest first unless business priority specifies another deterministic order.

After every batch:

- reconcile artifacts;
- refresh 8910;
- write Feishu status in controlled batches;
- save a batch report;
- stop if invariant checks fail or failure rate crosses the configured threshold.

Do not wait until the end to discover systematic image/config errors.

### Gate E: Human review and repair waves

Review at 8910 by batches. Route failed views into repair-only plans. A repaired view invalidates dependent price preview/cover/approval revisions and rebuilds only those downstream artifacts.

### Gate F: Final closure

Run the full verifier and produce the final report. Closure requires:

- every in-range discovered SKU assigned exactly one state;
- no false `SKIPPED_COMPLETE` records;
- no untracked generation output;
- no stale cover or price preview;
- all unresolved products listed with an exact blocker and next action;
- Feishu state no later than local evidence;
- all publish actions still behind human confirmation.

---

## 4. Required final acceptance report

The final handoff must state concrete values, not “completed successfully”:

```text
Run ID:
Yupoo source:
Date window:
Discovery snapshot SHA-256:
Albums discovered:
Unique SKUs in range:
Previously complete and skipped:
Partial products resumed:
New products ingested:
Products blocked at configuration:
Five-view sets generated:
Individual views generated/reused/failed:
Price preview sets ready:
XHS covers ready:
Products awaiting 8910 review:
Repair-required products/views:
Approved / queued / published:
Feishu records pulled/updated/failed:
CPA image model and proxy evidence:
Unresolved blockers:
External publications performed:
```

For this workflow, the expected value of `External publications performed` remains `0` unless the user separately authorizes publication after review.
