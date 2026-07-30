# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project does

Treats a Yupoo photo album as the single source of product truth and produces five consistently-styled images per SKU: **front physical rack image**, **back physical rack image**, **store try-on main image**, **store try-on close-up**, and **store try-on back view** (`tryon_back` — either a companion-captured rear photo or a natural foreground selfie with the back shown in one adjacent full-length mirror). All other detail images ship as the original Yupoo photos. Image generation is delegated to an external image bridge; this repo owns evidence collection, prompt assembly, review gating, deterministic price-badge rendering, and publishing-draft assembly.

Supplier-specific album triage hint: a style code containing `-` is a Nike/Jordan candidate; a code without `-` is an Adidas candidate. This is only a selection shortcut for this supplier and must still be confirmed against visible product branding in the album before classification.

A hard invariant runs through everything: **Yupoo images are the sole authority for garment identity, color, construction, and logo.** Store references only control the scene. The model never generates text/numbers — price signs are generated blank, and prices are stamped deterministically by Python only onto QA-approved images.

## Commands

```bash
# Setup (macOS)
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt   # only Pillow; no third-party npm deps
cp .env.example .env

# Feishu status-table tooling (needed by sync-catalog / push-status, not by image generation):
#   npm i -g lark-cli && lark-cli login
# .env already carries FEISHU_BASE_TOKEN / FEISHU_TABLE_ID / REVIEW_URL_BASE with the shared
# status-board defaults, so no further config is needed unless you target a different table.

# Tests
# Python (pricing, gates, sign-box detection, publish draft) + Node (automation-state,
# classification-lib, feishu-sync, ingest-products, yupoo-discover) + a preflight dry-run.
npm test                                                    # all three
npm run test:py                                             # Python only
./scripts/test-python.sh
.venv/bin/python -m unittest discover -s tests -v
.venv/bin/python -m unittest tests.test_workflow.WorkflowTests.test_extract_sizes_from_yupoo_title -v   # single test
npm run test:automation                                     # node --test tests/*.test.mjs

# Dry-run a generation batch (no network, validates config + reference existence)
node scripts/generate-racks.mjs --batch config/<batch>.json --dry-run
# Real generation (requires image bridge on :8907 reachable; CPA :8317 upstream)
node scripts/generate-racks.mjs --batch config/<batch>.json
# Targeted repair (concurrency 3)
node scripts/repair-racks.mjs --batch config/<repairs>.json [--dry-run]

# Ingest a Yupoo album + build reference packs, facts, publish draft
.venv/bin/python src/product_image_workflow.py run \
  --album-url '<URL>' --classification config/<sku>.classification.json \
  --scenes config/store-scenes.json --pricing config/pricing.json --confirm-cost

# Stamp prices onto QA-approved rack images only
.venv/bin/python src/product_image_workflow.py finalize-batch \
  --review runs/<run-id>/review.json --pricing config/pricing.json \
  --report runs/<run-id>/finalize-summary.json

# Merge approved finalize summary + draft + manifest into a publish package
.venv/bin/python src/product_image_workflow.py prepare-publish \
  --draft work/items/<SKU>/publish-draft.json \
  --finalize-summary runs/<run-id>/finalize-summary.json \
  --manifest work/items/<SKU>/manifest.json --output work/items/<SKU>/publish-package.json

# Validate the exact 微购相册 field/image plan without login, upload, or submit
node scripts/upload-szwego.mjs --batch config/<szwego-upload-batch>.json \
  --dry-run --report runs/<run-id>/szwego-upload-dry-run.json

# Review dashboard (Tailscale-bound HTTP server, default 127.0.0.1:8910)
npm run dashboard -- --host 100.84.194.46 --port 8910   # bind the device's Tailscale address

# Render XHS four-grid covers (top: priced rack front/back; bottom: tryon front/back)
npm run xhs-covers -- --sku IH1976-100                 # comma-separated for multiple

# Render deterministic price-badge previews for every dashboard product
npm run price-previews

# Push local evidence (outputs/xhs-cover/publish-package/copy) back to the Feishu status table
npm run push-status -- --dry-run                # default; print the plan only
npm run push-status -- --apply                  # update existing rows via lark-cli +record-upsert
npm run push-status -- --apply --create-missing # also create rows for SKUs absent from the table

# Generate platform copy (run before push-status so the 文案/标签 columns reflect them)
npm run xianyu-copy                              # 闲鱼文案 → work/items/<SKU>/xianyu-copy.json
npm run xhs-copy                                # 小红书文案+标签 → work/items/<SKU>/xhs-copy.json

# npm-script shortcuts for the generation/repair entries above
npm run generate -- --batch config/<batch>.json        # real generation (needs bridge :8907)
npm run repair  -- --batch config/<repairs>.json
npm run preflight                                      # dry-run batch.example.json
npm run upload:szwego -- --batch config/<szwego-upload-batch>.json --dry-run
```

There is no build step and no linter configured. Node scripts use only `node:` built-ins + `fetch` (production scripts) plus `axios`/`form-data` for upload; run with the system `node`. Tests run via `scripts/test-python.sh`, which auto-picks a Python runtime (`.venv/bin/python`, a codex runtime, or `python3`) and fails fast if Pillow is missing. Node tests run with the built-in `node --test` runner (no extra dependency).

## Architecture

The workflow is split by **non-deterministic vs deterministic** responsibility, and they must stay separated:

- **Node (`scripts/*.mjs`) — non-deterministic / network:** concurrent image generation via the external image bridge. `generate-racks.mjs` expands a batch file into per-view jobs, validates reference counts/`color_authority` membership, compiles prompts from `generation-prompt-rules.json`, and calls the bridge through `workflow-lib.mjs`. Output goes only to `runs/<run-id>/review/` with every status set to `REVIEW_PENDING`.
- **Python (`src/product_image_workflow.py`) — deterministic / auditable:** album ingestion, contact-sheet generation, reference-pack building, pricing math, price-sign text rendering, finalize/review gating, and publish-draft assembly. No LLM calls; everything is reproducible from inputs.

### Data flow per SKU

```
Yupoo album → ingest_album() → work/items/<SKU>/{album.html, originals/, manifest.json, contact-sheet.jpg}
classification.json (human-confirmed indices) + manifest → build_reference_packs() → reference-packs.json
manifest + classification + pricing → build_product_facts() → product-facts.json (single source of truth)
product-facts + publishing.json → build_publish_draft() → publish-draft.json (status DRAFT_REVIEW, with blockers)

batch JSON → generate-racks.mjs → runs/<run-id>/review/* + review.json (all REVIEW_PENDING)
human QA → edit review.json statuses → finalize-batch → outputs/ (price-stamped rack, copy try-on) + finalize-summary.json
finalize-summary + publish-draft + manifest → prepare-publish → publish-package.json (READY_TO_PUBLISH when no blockers)
```

### Status gates (do not bypass — these are the contract between stages)

Input gates (set in `build_reference_packs` / `run`): `BLOCKED_UNCONFIRMED_COST`, `BLOCKED_NO_BACK_DETAILS`, `SKIP_UNUSABLE_REFERENCES`, `READY`.

Output gates (in `review.json`, set by humans, consumed by `finalize_review`): `REVIEW_PENDING`, `REPAIR_REQUIRED`, `APPROVED_FOR_PRICE`, `APPROVED_FOR_PUBLISH`. `finalize_review` only writes prices for `APPROVED_FOR_PRICE` approvals with `finalization: price_badge`, and only copies try-on images with `APPROVED_FOR_PUBLISH` + `finalization: publish_copy`. Any other status is held, not finalized.

Publish blockers: `build_publish_draft` lists image/cost/facts blockers; `prepare_publish_package` clears the four image blockers only when the corresponding finalized view exists in the finalize summary and the upload image file actually exists on disk, then upgrades to `READY_TO_PUBLISH`. `FACTS_NOT_MANUALLY_VERIFIED` requires `classification.review_state == "manual_verified"`.

### Review dashboard & publish destinations

`scripts/review-dashboard.mjs` is a single-file HTTP server (default `127.0.0.1:8910`) that serves `dashboard/` (static `index.html`/`app.js`/`styles.css`) plus a JSON API. It does **not** write prices or finalize images itself — it is the human gate over the same `work/items/` and `runs/<run-id>/review/` artifacts the CLI produces.

- `REQUIRED_VIEWS` = `front, back, tryon_main, tryon_detail, tryon_back`. `REVIEW_RESOLVABLE_BLOCKERS` is the set of image/facts blockers a human approval can clear from the dashboard.
- `/api/products` aggregates per-SKU facts, prices, blockers, and the five generated images (resolved from `runs/`, `work/items`, `outputs/` via `MEDIA_ROOTS`).
- `config/destinations.json` declares each publish destination's `connector_status`: `dry_run_only` (szwego — confirmation is atomic and safe but does not call the real sender), `planned` (xiaohongshu — not clickable yet), or `active` (only `active` enters `QUEUED_FOR_DISPATCH`). Page-level confirmation requires facts + price + specs + freight + all five images, and still blocks on any non-human-review blocker.
- A confirmed approval atomically writes `work/approval-signals/` and enqueues `work/publish-queue/` in state `APPROVED_WAITING_FOR_CONNECTOR`. It never impersonates a completed publish.

`scripts/build-price-previews.mjs` renders deterministic price badges onto each product's rack images for display inside the dashboard (driven by the same `/api/products` feed; reports `generated` vs `cached`). The dashboard triggers a preview refresh on startup.

`scripts/build-xhs-covers.mjs` calls the Python `render-xhs-cover` subcommand (`render_xhs_four_grid_cover`) to compose a 2×2 portrait `1080×1440` cover — top row priced rack front/back, bottom row tryon front/back — written to `work/items/<SKU>/xhs-cover/four-grid.jpg` and left `REVIEW_PENDING`. It never auto-publishes. Python `render-price-badge`, `render-xhs-cover`, `ingest-album`, and `discover-album` are additional deterministic subcommands exposed by the same CLI.

### Feishu catalog status (read + write-back)

The Feishu table `tblUcslarq5iLEPB` (base token in `.env` → `FEISHU_BASE_TOKEN`) is the human-facing status board. **Prerequisite:** `lark-cli` must be installed globally and logged in (`npm i -g lark-cli && lark-cli login`) before `sync-catalog.mjs` or `push-catalog-status.mjs` can call the Feishu Base API. Credentials stay out of the repo — `sync-catalog.mjs` and `push-catalog-status.mjs` read `FEISHU_BASE_TOKEN` / `FEISHU_TABLE_ID` / `REVIEW_URL_BASE` from `.env` (via `loadLocalEnv()`) with the shared board as the fallback default, and `lark-cli` itself holds the OAuth token in its own user config. It has two halves:

- **Feishu → local** (`scripts/sync-catalog.mjs`): `lark-cli base +record-list` reads the table and merges SKU/yupoo-url/state into `config/sku-catalog.json`. Read-only; this is the existing direction.
- **Local → Feishu** (`scripts/push-catalog-status.mjs`, `npm run push-status`): the reverse. It re-derives each SKU's status **from local physical evidence only** (`outputs/` five-view count, `work/items/<SKU>/xhs-cover/four-grid.jpg`, `publish-package.json` status, `publish-draft.json` copy, `xianyu-copy.json`, `xhs-copy.json`) — **not** from `sku-catalog.json.state`, whose own description declares state is only a pending-reconciliation hint. It writes the status columns `图片生成 / 四宫格 / 图片审核 / 价格写入 / 微购文案 / 闲鱼文案 / 小红书文案 / 备注` plus the `小红书标签` text column, using the **real option values** in `FEISHU_STATUS_OPTIONS` (`scripts/feishu-status.mjs`). It never touches the human-maintained input columns (售价/拿货价/品牌/品类/分类确认/Yupoo链接) or the publish-result columns (`微购上架/闲鱼上架/小红书发布`) — those belong to humans or to the real publish action. Default `--dry-run`; `--apply` calls `lark-cli base +record-upsert` per record (one SKU may occupy multiple duplicate rows — all are written). `--create-missing` additionally creates rows for SKUs present in `work/items/` but absent from the table, filling the input columns from `product-facts.json` / `publish-package.json` / `manifest.json` (Yupoo URL from `sku-catalog.json` sources, since `manifest.album_url` is often the placeholder `"skip"`) / `classification.json` (`review_state` → 分类确认), with `品牌`/`品类` mapped to the table's single-select options. Run order: generate copy first (`npm run xianyu-copy && npm run xhs-copy`), then `npm run push-status -- --apply --create-missing`.

### Platform copy generation (deterministic, no LLM)

Each platform's copy lives in its own file under `work/items/<SKU>/`; the Feishu select columns above only store the ✅ 已生成 status, not the copy body.

- **微购文案** = `publish-draft.json` (the album publish draft: title/short_name/description/price/tags). Already produced by the Python `run`/`prepare-publish` flow; the Feishu column just records whether it has copy.
- **闲鱼文案** (`scripts/build-xianyu-copy.mjs`, `npm run xianyu-copy`) → `xianyu-copy.json`. Four templates (撤店清仓 / 出全新 / 出闲置 / 奥莱折扣) from operator-supplied wording; template chosen **deterministically by SKU hash** (not `Math.random`, so re-runs don't churn the copy), size line filled from `publish-package.sizes` (e.g. `尺码 S-XXL`).
- **小红书文案** (`scripts/build-xhs-copy.mjs`, `npm run xhs-copy`) → `xhs-copy.json` (`title` + `body` + `tags`). Style mirrors the 「小林在奥莱」 real-shot notes: three templates (`{SKU} 实拍来啦～` / `{SKU} 实拍来啦` / descriptive `{brand_display}{category} {主色}不要太好看！`), chosen by SKU hash; descriptive falls back to the plain title when brand/category are missing. `tags` picks ~3 from the pool 耐克/nike/三叶草/adidas/外套/穿搭/奥莱/奥莱代购 by brand+category (nike/jordan→耐克,nike; adidas→adidas,三叶草; outerwear→外套; always +奥莱), and `push-catalog-status.mjs` writes them to the `小红书标签` column.

`feishu-status.mjs` also exports a `feishuPatchForState(item)` helper that derives the status columns from a catalog item's `stage_evidence` for offline preview; `push-catalog-status.mjs` is the live writer and is the one that touches the table.

### Key constraints baked into the code

- **Pricing** (`calculate_price`, `config/pricing.json`): `sale = ceil(cost / cost_ratio_target)` then bumped up to the next price ending in `price_ending` (9), within `round_step` (10). 135→229, 60→109. With `cost_ratio_target` set, a ceiling check guarantees sale ≥ raw target. List price / discount are only computed if `target_discount` exists — and the production config deliberately omits it, so **no fake RRP, no discount rate** is ever shown.
- **Reference limits**: each view ≤ 5 references (1 scene + 1 blank sign for rack mode + up to 3 product). `color_authority` must be one of the product_references (enforced in both `generate-racks.mjs` and `build_reference_packs`). Try-on views omit the blank sign reference.
- **Output canvas**: production generation is fixed to portrait `1080x1440` (`3:4` width:height). Prompts reserve a safe area, then Python deterministically places the complete image on the exact canvas with a blurred extension when the source ratio differs; it does not crop away critical product content. Price rendering preserves this canvas.
- **Size expansion**: `extract_sizes_from_title` expands Yupoo `S-XXL` ranges only along the fixed `SIZE_ORDER` ladder — it never invents sizes. Colors must come from Yupoo/official/manual; never guessed from color codes.
- **Tags**: `derive_publish_tags` only keeps tags present in `publishing.json` `existing_tags` whitelist; unmatched tags are dropped, never auto-created.
- **Price-sign text** (`render_physical_sign_text`): draws 门店特惠 / ¥price / category 中+英 onto the auto-detected (`detect_physical_sign_boxes`) orange upper + black lower panels. The model must have generated these panels **blank**; this step is the only place text is added.

### Config roles

- `config/generation-prompt-rules.json` — `required_rules` (rack) vs `tryon_required_rules`, plus the `qa_gate` / `tryon_qa_gate` check lists that humans apply.
- `config/batch.example.json` — one SKU with `views` (front/back) and `tryon_views` (tryon_main/tryon_detail, plus optional tryon_back). `output_canvas` is fixed to `1080x1440`. `tryon_main`/`tryon_detail` must be configured together or not at all for a normal batch; `enabled_views` may select only failed views in an explicit retry batch. `tryon_back` is an optional add-on. Its default `composition` is `companion_rear`; set `composition: "side_mirror_reflection"` and provide a `pose_reference` for the side-mirror layout. Front/back are always required. Copy to a new file and set `enabled: true` to run.
- `config/classification.example.json` — human-confirmed grid indices (`roles`) and `facts`; `review_state: manual_verified` unlocks VERIFIED facts.
- `config/publishing.json` — szwego defaults: inventory 10/variant, 全国统一运费 10元, the `existing_tags` whitelist, `brand_tags` and `category_tags` maps.
- `config/repairs.example.json` — targeted repair jobs; note the repair script prepends `job.target` (the failed image) to the reference list, so keep `target` pointing at the image to correct.

## Conventions

- Paths in batch/review/approval JSON are **repo-relative**; the Python CLI resolves them against `--project-root` (default `.`) and the Node lib resolves against `projectRoot` (repo root computed from the script location). Always invoke the Python CLI from the repo root or pass `--project-root`.
- Run IDs are timestamped by `makeRunId` (e.g. `rack-20260720T0928Z`); pass `--run-id` to reuse one. The image-bridge route is `this project → bridge :8907 → CPA :8317 → gpt-image-2`; `checkImageBridge` rejects any model other than `gpt-image-2`.
- Generated JSON files (`summary.json`, `review.json`, `responses/*.json`) strip the embedded data-URL to keep diffs reviewable; the actual image is saved beside them.
- All user-facing copy is Simplified Chinese; keep that consistent when adding category names, tags, or badge text.
