#!/usr/bin/env node
// 把本地产物证据回写到飞书表 tblUcslarq5iLEPB 的状态列。
// 判定只基于 work/items/<SKU>/ 与 outputs/ 的实物证据，不信任 catalog.state
// （sku-catalog.json 的 description 自己声明 state 仅为待对账状态，完成与否必须由本地产物重新判定）。
//
// 回写的列（全部为单选/文本，不碰输入列与上架结果列）：
//   图片生成 / 四宫格 / 图片审核 / 价格写入 / 微购文案 / 备注
// 不写：售价/拿货价/品牌/品类/颜色/尺码/分类确认/原图抓取/Yupoo链接（输入列，人工维护）
//      微购上架/闲鱼上架/小红书发布（发布结果，应由真实发布动作写，不在此预标）
//
// 默认 dry-run，只打印计划；--apply 才真写。

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { projectRoot, resolveProjectPath, runPool, loadLocalEnv } from './workflow-lib.mjs';
import { FEISHU_STATUS_OPTIONS as OPT } from './feishu-status.mjs';

const isMain = fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || '');

const execFileAsync = promisify(execFile);

// 凭证走 env（.env.example 有说明），兜底是共享状态看板。用函数而非常量，
// 这样 main() 里 await loadLocalEnv() 之后再读取，.env 覆盖才生效。
const baseToken = () => process.env.FEISHU_BASE_TOKEN || 'PYtZbqyPyafc4sscwdjcQNLNnEh';
const tableId = () => process.env.FEISHU_TABLE_ID || 'tblUcslarq5iLEPB';
const reviewUrlBase = () => process.env.REVIEW_URL_BASE || 'http://127.0.0.1:8910/';
const REQUIRED_VIEWS = ['front', 'back', 'tryon_main', 'tryon_detail', 'tryon_back'];

function parseArgs(argv) {
  const args = { apply: false, createMissing: false, full: false, catalog: 'config/sku-catalog.json', skus: [], concurrency: 3, report: null };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--apply') args.apply = true;
    else if (value === '--dry-run') args.apply = false;
    else if (value === '--full') args.full = true;
    else if (value === '--create-missing') args.createMissing = true;
    else if (value === '--catalog') args.catalog = argv[++index];
    else if (value === '--sku') args.skus.push(...String(argv[++index]).split(',').filter(Boolean));
    else if (value === '--concurrency') args.concurrency = Number(argv[++index]);
    else if (value === '--report') args.report = argv[++index];
    else throw new Error(`Unknown argument: ${value}`);
  }
  return args;
}

// 飞书单选项映射：本地 facts.brand / category → 飞书表选项。
// 品牌选项：Nike / Adidas / CK / 其他；品类选项：上衣 / 裤子 / 鞋子 / 帽子 / 背心。
export function mapBrand(brand) {
  const b = String(brand || '').toLowerCase();
  if (b === 'nike') return 'Nike';
  if (b === 'adidas') return 'Adidas';
  if (b === 'ck' || b === 'calvinklein') return 'CK';
  return '其他';
}
export function mapCategory(category) {
  const c = String(category || '');
  if (/鞋/.test(c)) return '鞋子';
  if (/帽/.test(c)) return '帽子';
  if (/背心|马甲/.test(c)) return '背心';
  if (/裤/.test(c)) return '裤子';
  return '上衣'; // 卫衣/夹克/T恤/衫等默认上衣
}

// 枚举 work/items 下所有 SKU 目录（dashboard /api/products 的同一数据源）。
async function listLocalSkus() {
  const itemsRoot = resolveProjectPath('work/items');
  try {
    const entries = await fs.readdir(itemsRoot, { withFileTypes: true });
    return entries.filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => e.name).sort();
  } catch { return []; }
}

// 为缺行的 SKU 构造建行字段：输入列（来自 facts/package/manifest/classification）+ 状态列。
async function buildCreatePatch(sku, catalogItem) {
  const facts = await readJsonSafe(resolveProjectPath(`work/items/${sku}/product-facts.json`));
  const pkg = await readJsonSafe(resolveProjectPath(`work/items/${sku}/publish-package.json`));
  const draft = pkg || await readJsonSafe(resolveProjectPath(`work/items/${sku}/publish-draft.json`));
  const manifest = await readJsonSafe(resolveProjectPath(`work/items/${sku}/manifest.json`));
  const classification = await readJsonSafe(resolveProjectPath(`config/${sku}.classification.json`));

  const statusPatch = await buildPatch(sku, catalogItem);
  const patch = {
    SKU: sku,
    原图抓取: '✅ 已完成', // 凡入 work/items 的都已抓取
    分类确认: classification?.review_state === 'manual_verified' ? '✅ 已确认' : '❌ 待确认',
    ...statusPatch,
  };
  // Yupoo链接：优先 catalog sources，回退 manifest.album_url（但 manifest 里常存占位符 "skip"，需过滤）。
  const yupooUrl = catalogItem?.sources?.find(source => source.url)?.url
    || (typeof manifest?.album_url === 'string' && /^https?:\/\//.test(manifest.album_url) ? manifest.album_url : null);
  if (yupooUrl) patch.Yupoo链接 = yupooUrl;
  if (Number(draft?.cost_price) > 0) patch.拿货价 = Number(draft.cost_price);
  if (Number(draft?.sale_price) > 0) patch.售价 = Number(draft.sale_price);
  if (facts?.brand || draft?.brand) patch.品牌 = mapBrand(facts?.brand || draft?.brand);
  if (draft?.category || facts?.category) patch.品类 = mapCategory(draft?.category || facts?.category);
  const colors = draft?.colors?.length ? draft.colors : (facts?.colors || []);
  if (colors.length) patch.颜色 = colors.join('、');
  const sizes = draft?.sizes?.length ? draft.sizes : (facts?.sizes || []);
  if (sizes.length) patch.尺码 = sizes.join('-');
  return patch;
}

async function createRecord(patch) {
  const { stdout } = await execFileAsync('lark-cli', [
    'base', '+record-upsert',
    '--base-token', baseToken(),
    '--table-id', tableId(),
    '--json', JSON.stringify(patch),
  ], { cwd: projectRoot, maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

async function exists(target) {
  try { await fs.access(target); return true; } catch { return false; }
}

async function readJsonSafe(target) {
  try { return JSON.parse(await fs.readFile(target, 'utf8')); } catch { return null; }
}

// 拉飞书表，建 SKU -> record_id 映射（一个 SKU 可能有多行，去重后取第一个）。
async function loadFeishuSkuMap() {
  const { stdout } = await execFileAsync('lark-cli', [
    'base', '+record-list',
    '--base-token', baseToken(),
    '--table-id', tableId(),
    '--field-id', 'SKU',
    '--limit', '200',
    '--json',
  ], { cwd: projectRoot, maxBuffer: 16 * 1024 * 1024 });
  const payload = JSON.parse(stdout);
  const fields = payload.data?.fields || [];
  const rows = payload.data?.data || [];
  const recordIds = payload.data?.record_id_list || [];
  const skuIndex = fields.indexOf('SKU');
  if (skuIndex < 0) throw new Error('飞书表无 SKU 列');
  const map = new Map();
  rows.forEach((row, rowIndex) => {
    const sku = row[skuIndex];
    if (!sku) return;
    const id = recordIds[rowIndex];
    if (!id) return;
    if (!map.has(sku)) map.set(sku, []);
    map.get(sku).push(id);
  });
  return map;
}

// 基于实物证据计算单个 SKU 的回写 patch。
async function buildPatch(sku, catalogItem) {
  const itemDir = resolveProjectPath(`work/items/${sku}`);
  const hasItem = await exists(itemDir);

  // 五张成品图（outputs/）
  const genCount = (await Promise.all(REQUIRED_VIEWS.map(async view => {
    const name = view === 'front' || view === 'back'
      ? `outputs/${sku}-${view}-sale.jpg`
      : `outputs/${sku}-${view}.jpg`;
    return (await exists(resolveProjectPath(name))) ? 1 : 0;
  }))).reduce((a, b) => a + b, 0);

  const coverExists = await exists(resolveProjectPath(`work/items/${sku}/xhs-cover/four-grid.jpg`));
  const frontPriced = await exists(resolveProjectPath(`outputs/${sku}-front-sale.jpg`));
  const xianyuCopyExists = await exists(resolveProjectPath(`work/items/${sku}/xianyu-copy.json`));
  const xhsCopy = await readJsonSafe(resolveProjectPath(`work/items/${sku}/xhs-copy.json`));
  const xhsCopyExists = Boolean(xhsCopy);

  const pkg = await readJsonSafe(resolveProjectPath(`work/items/${sku}/publish-package.json`));
  const draft = await readJsonSafe(resolveProjectPath(`work/items/${sku}/publish-draft.json`));
  const hasFinalize = await exists(resolveProjectPath(`work/items/${sku}/finalize-summary.json`));

  const pkgReady = pkg?.status === 'READY_TO_PUBLISH';
  const hasDraftCopy = Boolean(draft?.title || draft?.short_name || draft?.description);

  const 图片生成 = genCount >= 5 ? OPT.图片生成.done
    : genCount > 0 ? OPT.图片生成.partial
    : OPT.图片生成.none;
  const 四宫格 = coverExists ? OPT.四宫格.yes : OPT.四宫格.no;
  const 价格写入 = frontPriced ? OPT.价格写入.yes : OPT.价格写入.no;
  const 微购文案 = hasDraftCopy ? OPT.微购文案.yes : OPT.微购文案.no;
  const 闲鱼文案 = xianyuCopyExists ? OPT.闲鱼文案.yes : OPT.闲鱼文案.no;
  const 小红书文案 = xhsCopyExists ? OPT.小红书文案.yes : OPT.小红书文案.no;
  // 审核态：READY_TO_PUBLISH 才算通过；finalize 过但被 blocker 挡算需修复；否则待审核。
  const 图片审核 = pkgReady ? OPT.图片审核.passed
    : hasFinalize ? OPT.图片审核.repair
    : OPT.图片审核.pending;

  const localSummary = pkgReady ? 'READY_TO_PUBLISH'
    : hasItem ? (hasFinalize ? 'FINALIZED_BLOCKED' : 'IN_REVIEW')
    : 'NOT_STARTED';
  const 备注 = `本地：${localSummary}；成品图 ${genCount}/5；价格${frontPriced ? '已写入' : '未写入'}；审核台 ${reviewUrlBase()}?sku=${encodeURIComponent(sku)}`;

  return {
    图片生成,
    四宫格,
    图片审核,
    价格写入,
    微购文案,
    闲鱼文案,
    小红书文案,
    ...(xhsCopy?.tags?.length ? { 小红书标签: xhsCopy.tags.join('、') } : {}),
    备注,
  };
}

async function upsertRecord(recordId, patch) {
  const { stdout } = await execFileAsync('lark-cli', [
    'base', '+record-upsert',
    '--base-token', baseToken(),
    '--table-id', tableId(),
    '--record-id', recordId,
    '--json', JSON.stringify(patch),
  ], { cwd: projectRoot, maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

async function main() {
  await loadLocalEnv();
  const args = parseArgs(process.argv.slice(2));
  const catalog = JSON.parse(await fs.readFile(resolveProjectPath(args.catalog), 'utf8'));
  const bySku = new Map((catalog.items || []).map(item => [item.sku, item]));
  const feishuMap = await loadFeishuSkuMap();

  const requested = new Set(args.skus);
  const targetSkus = [...feishuMap.keys()]
    .filter(sku => !requested.size || requested.has(sku));

  const plans = [];
  for (const sku of targetSkus) {
    const recordIds = feishuMap.get(sku);
    const patch = await buildPatch(sku, bySku.get(sku));
    for (const recordId of recordIds) {
      plans.push({ sku, record_id: recordId, patch });
    }
  }

  // 缺行 SKU：飞书表没有、但本地 work/items 有的。默认只报告；--create-missing 时建行。
  const feishuSkus = new Set(feishuMap.keys());
  const allLocalSkus = await listLocalSkus();
  const missingSkus = allLocalSkus
    .filter(sku => !feishuSkus.has(sku))
    .filter(sku => !requested.size || requested.has(sku));

  const createPlans = [];
  if (args.createMissing) {
    for (const sku of missingSkus) {
      createPlans.push({ sku, patch: await buildCreatePatch(sku, bySku.get(sku)) });
    }
  }

  let results = [];
  if (args.apply && plans.length) {
    results = await runPool(plans, args.concurrency, async (plan) => {
      await upsertRecord(plan.record_id, plan.patch);
      return { sku: plan.sku, ok: true };
    });
  }
  let createResults = [];
  if (args.apply && args.createMissing && createPlans.length) {
    createResults = await runPool(createPlans, args.concurrency, async (plan) => {
      await createRecord(plan.patch);
      return { sku: plan.sku, ok: true };
    });
  }

  const report = {
    mode: args.apply ? 'apply' : 'dry-run',
    feishu_skus: feishuMap.size,
    planned_updates: plans.length,
    create_missing: args.createMissing,
    planned_creates: createPlans.length,
    local_skus_missing_feishu_row: missingSkus,
    updates: plans.map(p => ({ sku: p.sku, record_id: p.record_id, patch: p.patch })),
    creates: createPlans.map(p => ({ sku: p.sku, patch: p.patch })),
    apply_results: results,
    create_results: createResults,
  };

  const out = JSON.stringify(report, null, 2);
  if (args.report) await fs.writeFile(resolveProjectPath(args.report), `${out}\n`);
  console.log(out);
  if (args.apply) {
    const failed = [...results, ...createResults].filter(r => r && r.ok === false);
    if (failed.length) console.error(`\n${failed.length} 条失败`);
  }
  if (args.full) {
    const fullArgs = [resolveProjectPath('scripts/push-feishu-yupoo.mjs')];
    if (!args.apply) fullArgs.push('--dry-run');
    if (args.skus.length) fullArgs.push('--sku', args.skus.join(','));
    const { stdout } = await execFileAsync(process.execPath, fullArgs, {
      cwd: projectRoot,
      maxBuffer: 32 * 1024 * 1024,
    });
    console.log(stdout);
  }
}

if (isMain) {
  main().catch(error => {
    console.error(`错误: ${error.message}`);
    process.exit(1);
  });
}
