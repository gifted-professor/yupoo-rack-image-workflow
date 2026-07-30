#!/usr/bin/env node

import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { loadLocalEnv, projectRoot, resolveProjectPath, writeJson } from './workflow-lib.mjs';
import { FEISHU_STATUS_OPTIONS as OPT } from './feishu-status.mjs';

const execFileAsync = promisify(execFile);
const maxBuffer = 32 * 1024 * 1024;
const baseToken = () => process.env.FEISHU_BASE_TOKEN || 'PYtZbqyPyafc4sscwdjcQNLNnEh';
const tableId = () => process.env.FEISHU_TABLE_ID || 'tblUcslarq5iLEPB';
const reviewUrlBase = () => (process.env.REVIEW_URL_BASE || 'http://127.0.0.1:8910/').replace(/\/$/, '');
const attachmentFields = {
  front: '货架正面图',
  back: '货架背面图',
  tryon_main: '试穿主图',
  tryon_detail: '试穿近景',
  tryon_back: '试穿背面',
  xhs_cover: '小红书四宫格',
  yupoo_original: 'Yupoo原图',
};
const generatedViews = [
  ['front', 'front-sale.jpg', 10],
  ['back', 'back-sale.jpg', 20],
  ['tryon_main', 'tryon_main.jpg', 30],
  ['tryon_detail', 'tryon_detail.jpg', 40],
  ['tryon_back', 'tryon_back.jpg', 50],
];

function parseArgs(argv) {
  const args = { dryRun: false, skipMain: false, skipImages: false, concurrency: 2, skus: [], report: null };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--dry-run') args.dryRun = true;
    else if (value === '--skip-main') args.skipMain = true;
    else if (value === '--skip-images') args.skipImages = true;
    else if (value === '--concurrency') args.concurrency = Number(argv[++index]);
    else if (value === '--sku') args.skus.push(...String(argv[++index]).split(',').filter(Boolean));
    else if (value === '--report') args.report = argv[++index];
    else throw new Error(`Unknown argument: ${value}`);
  }
  return args;
}

async function cli(args) {
  const { stdout } = await execFileAsync('lark-cli', [
    'base', ...args, '--as', 'user', '--format', 'json',
  ], { cwd: projectRoot, maxBuffer });
  return JSON.parse(stdout);
}

async function readJsonSafe(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return null; }
}

async function exists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

async function sha256(file) {
  const hash = crypto.createHash('sha256');
  hash.update(await fs.readFile(file));
  return hash.digest('hex');
}

function relativePath(file) {
  return path.relative(projectRoot, file).split(path.sep).join('/');
}

function scalar(value) {
  if (Array.isArray(value)) return value.length === 1 ? value[0] : value;
  return value;
}

function attachmentNames(value) {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return new Set(values.map(item => item?.name).filter(Boolean));
}

async function listRecords(fields) {
  const payload = await cli([
    '+record-list', '--base-token', baseToken(), '--table-id', tableId(), '--limit', '200',
    ...fields.flatMap(field => ['--field-id', field]),
  ]);
  const data = payload.data || {};
  const names = data.fields || fields;
  const rows = data.data || [];
  const ids = data.record_id_list || [];
  return rows.map((row, index) => ({
    record_id: ids[index] || null,
    fields: Object.fromEntries(names.map((name, fieldIndex) => [name, scalar(row[fieldIndex])])),
  }));
}

function mapBrand(brand) {
  const value = String(brand || '').toLowerCase();
  if (value === 'nike') return 'Nike';
  if (value === 'adidas') return 'Adidas';
  if (value === 'ck' || value === 'calvinklein') return 'CK';
  return '其他';
}

function mapCategory(category) {
  const value = String(category || '');
  if (/鞋/.test(value)) return '鞋子';
  if (/帽/.test(value)) return '帽子';
  if (/背心|马甲/.test(value)) return '背心';
  if (/裤/.test(value)) return '裤子';
  return '上衣';
}

async function loadItems(args) {
  const catalog = await readJsonSafe(resolveProjectPath('config/sku-catalog.json')) || { items: [] };
  const catalogBySku = new Map((catalog.items || []).map(item => [item.sku, item]));
  const itemsRoot = resolveProjectPath('work/items');
  const entries = await fs.readdir(itemsRoot, { withFileTypes: true });
  const skus = entries
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .map(entry => entry.name)
    .filter(sku => !args.skus.length || args.skus.includes(sku))
    .sort();
  const items = [];
  for (const sku of skus) {
    const root = resolveProjectPath(`work/items/${sku}`);
    const facts = await readJsonSafe(path.join(root, 'product-facts.json')) || {};
    const packageData = await readJsonSafe(path.join(root, 'publish-package.json'));
    const draft = packageData || await readJsonSafe(path.join(root, 'publish-draft.json')) || {};
    const manifest = await readJsonSafe(path.join(root, 'manifest.json')) || {};
    const classification = await readJsonSafe(resolveProjectPath(`config/${sku}.classification.json`)) || {};
    const xianyu = await readJsonSafe(path.join(root, 'xianyu-copy.json'));
    const xhs = await readJsonSafe(path.join(root, 'xhs-copy.json'));
    const catalogItem = catalogBySku.get(sku);
    const sourceUrl = catalogItem?.sources?.find(source => source.url)?.url
      || (typeof manifest.album_url === 'string' && /^https?:\/\//.test(manifest.album_url) ? manifest.album_url : null);
    const finalFiles = new Set(await fs.readdir(resolveProjectPath('outputs')).catch(() => []));
    const images = [];
    for (const [view, filename, order] of generatedViews) {
      const file = resolveProjectPath(`outputs/${sku}-${filename}`);
      if (finalFiles.has(path.basename(file))) images.push({ view, field: attachmentFields[view], file, order });
    }
    const cover = resolveProjectPath(`work/items/${sku}/xhs-cover/four-grid.jpg`);
    if (await exists(cover)) images.push({ view: 'xhs_cover', field: attachmentFields.xhs_cover, file: cover, order: 60 });
    for (const image of manifest.images || []) {
      const file = resolveProjectPath(image.path);
      if (await exists(file)) images.push({
        view: 'yupoo_original',
        field: attachmentFields.yupoo_original,
        file,
        order: Number(image.index || 0),
        sourceUrl: image.source_url || null,
      });
    }
    const generatedCount = images.filter(image => image.view !== 'xhs_cover' && image.view !== 'yupoo_original').length;
    const packageReady = packageData?.status === 'READY_TO_PUBLISH';
    const blockers = Array.isArray(draft.blockers) ? draft.blockers : [];
    const colors = draft.colors?.length ? draft.colors : (facts.colors || []);
    const sizes = draft.sizes?.length ? draft.sizes : (facts.sizes || []);
    const productDescription = [
      draft.title ? `标题：${draft.title}` : null,
      draft.short_name ? `简称：${draft.short_name}` : null,
      draft.description ? `描述：${draft.description}` : null,
      Number(draft.sale_price) > 0 ? `售价：${draft.sale_price}` : null,
      colors.length ? `颜色：${colors.join('、')}` : null,
      sizes.length ? `尺码：${sizes.join('、')}` : null,
    ].filter(Boolean).join('\n');
    const frontExists = images.some(image => image.view === 'front');
    items.push({
      sku, facts, draft, packageData, manifest, classification, xianyu, xhs, images,
      mainPatch: {
        SKU: sku,
        ...(sourceUrl ? { Yupoo链接: sourceUrl } : {}),
        '原图抓取': '✅ 已完成',
        '分类确认': classification.review_state === 'manual_verified' ? '✅ 已确认' : '❌ 待确认',
        ...(Number(draft.cost_price) > 0 ? { 拿货价: Number(draft.cost_price) } : {}),
        ...(Number(draft.sale_price) > 0 ? { 售价: Number(draft.sale_price) } : {}),
        ...(facts.brand || draft.brand ? { 品牌: mapBrand(facts.brand || draft.brand) } : {}),
        ...(draft.category || facts.category ? { 品类: mapCategory(draft.category || facts.category) } : {}),
        ...(colors.length ? { 颜色: colors.join('、') } : {}),
        ...(sizes.length ? { 尺码: sizes.join('-') } : {}),
        '图片生成': generatedCount >= 5 ? OPT.图片生成.done : generatedCount > 0 ? OPT.图片生成.partial : OPT.图片生成.none,
        '四宫格': images.some(image => image.view === 'xhs_cover') ? OPT.四宫格.yes : OPT.四宫格.no,
        '价格写入': frontExists ? OPT.价格写入.yes : OPT.价格写入.no,
        '微购文案': draft.title || draft.description ? OPT.微购文案.yes : OPT.微购文案.no,
        '闲鱼文案': xianyu?.text ? OPT.闲鱼文案.yes : OPT.闲鱼文案.no,
        '小红书文案': xhs?.title ? OPT.小红书文案.yes : OPT.小红书文案.no,
        '小红书标签': xhs?.tags?.length ? xhs.tags.join('、') : null,
        '图片审核': packageReady ? OPT.图片审核.passed : OPT.图片审核.pending,
        商品标题: draft.title || null,
        商品简称: draft.short_name || null,
        商品描述: draft.description || null,
        微购文案内容: productDescription || null,
        闲鱼文案内容: xianyu?.text || null,
        小红书标题: xhs?.title || null,
        小红书正文: xhs?.body || null,
        商品包状态: packageData?.status || draft.status || 'DRAFT_REVIEW',
        审核阻塞项: blockers.length ? blockers.join('、') : '无',
        备注: `本地：${packageReady ? 'READY_TO_PUBLISH' : 'IN_REVIEW'}；成品图 ${generatedCount}/5；素材 ${images.length} 张；审核台 ${reviewUrlBase()}/?sku=${encodeURIComponent(sku)}`,
      },
    });
  }
  return items;
}

async function upsert(recordId, patch) {
  const args = ['+record-upsert', '--base-token', baseToken(), '--table-id', tableId(), '--json', JSON.stringify(patch)];
  if (recordId) args.push('--record-id', recordId);
  return cli(args);
}

async function syncMain(items, dryRun) {
  const rows = await listRecords(['SKU']);
  const bySku = new Map();
  for (const row of rows) {
    const sku = row.fields.SKU;
    if (!sku) continue;
    if (!bySku.has(sku)) bySku.set(sku, []);
    bySku.get(sku).push(row.record_id);
  }
  const results = [];
  const canonical = new Map();
  for (const item of items) {
    const ids = bySku.get(item.sku) || [null];
    for (const recordId of ids) {
      if (dryRun) {
        results.push({ sku: item.sku, record_id: recordId, ok: true, mode: recordId ? 'update' : 'create' });
        if (!canonical.has(item.sku)) canonical.set(item.sku, recordId);
        continue;
      }
      try {
        const response = await upsert(recordId, item.mainPatch);
        const createdId = response.data?.record_id || response.data?.record?.record_id || response.data?.record_id_list?.[0] || recordId;
        results.push({ sku: item.sku, record_id: createdId, ok: true, mode: recordId ? 'update' : 'create' });
        if (!canonical.has(item.sku)) canonical.set(item.sku, createdId);
      } catch (error) {
        results.push({ sku: item.sku, record_id: recordId, ok: false, error: error.message });
      }
      if (results.length % 20 === 0) console.log(`商品主表 ${results.length} 条处理完成`);
    }
  }
  return {
    existing_skus: bySku.size,
    duplicate_rows: [...bySku.values()].filter(ids => ids.length > 1).reduce((sum, ids) => sum + ids.length - 1, 0),
    planned_rows: results.length,
    ok: results.filter(row => row.ok).length,
    failed: results.filter(row => !row.ok).length,
    results,
    canonical,
  };
}

async function syncImages(items, dryRun, canonical, concurrency) {
  const fields = ['SKU', ...Object.values(attachmentFields)];
  const rows = await listRecords(fields);
  const currentBySku = new Map();
  for (const row of rows) {
    const sku = row.fields.SKU;
    if (sku && !currentBySku.has(sku)) currentBySku.set(sku, row);
  }
  const groups = [];
  for (const item of items) {
    const row = currentBySku.get(item.sku);
    const recordId = canonical.get(item.sku) || row?.record_id;
    if (!recordId) {
      groups.push({ sku: item.sku, ok: false, error: '商品主表没有可用 record_id' });
      continue;
    }
    const attachmentsByField = new Map();
    for (const image of item.images) {
      if (!attachmentsByField.has(image.field)) attachmentsByField.set(image.field, []);
      attachmentsByField.get(image.field).push(image);
    }
    for (const [field, images] of attachmentsByField) {
      const existing = attachmentNames(row?.fields[field]);
      const pending = images.filter(image => !existing.has(path.basename(image.file)));
      if (pending.length) groups.push({ sku: item.sku, recordId, field, images: pending });
    }
  }
  if (dryRun) {
    const fileCount = groups.reduce((sum, group) => sum + (group.images?.length || 0), 0);
    return { groups: groups.length, files: fileCount, uploaded_groups: 0, uploaded_files: 0, failed: 0, dry_run: true };
  }
  const results = new Array(groups.length);
  let cursor = 0;
  async function worker() {
    while (cursor < groups.length) {
      const index = cursor++;
      const group = groups[index];
      if (!group.images) { results[index] = group; continue; }
      try {
        for (let offset = 0; offset < group.images.length; offset += 50) {
          const chunk = group.images.slice(offset, offset + 50);
          await cli([
            '+record-upload-attachment', '--base-token', baseToken(), '--table-id', tableId(),
            '--record-id', group.recordId, '--field-id', group.field,
            ...chunk.flatMap(image => ['--file', `./${relativePath(image.file)}`]),
          ]);
        }
        results[index] = { sku: group.sku, field: group.field, files: group.images.length, ok: true };
      } catch (error) {
        results[index] = { sku: group.sku, field: group.field, files: group.images.length, ok: false, error: error.message };
      }
      const done = results.filter(Boolean).length;
      if (done % 10 === 0 || done === groups.length) console.log(`商品附件 ${done}/${groups.length} 组处理完成`);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(Number(concurrency) || 1, 2)) }, worker));
  return {
    groups: groups.length,
    files: groups.reduce((sum, group) => sum + (group.images?.length || 0), 0),
    uploaded_groups: results.filter(result => result?.ok).length,
    uploaded_files: results.filter(result => result?.ok).reduce((sum, result) => sum + result.files, 0),
    failed: results.filter(result => result && !result.ok).length,
    failed_items: results.filter(result => result && !result.ok),
  };
}

await loadLocalEnv();
const args = parseArgs(process.argv.slice(2));
const items = await loadItems(args);
console.log(`本地范围：${items.length} 个 SKU，${items.reduce((sum, item) => sum + item.images.length, 0)} 个图片素材`);
const main = args.skipMain ? { skipped: true, canonical: new Map() } : await syncMain(items, args.dryRun);
const images = args.skipImages ? { skipped: true } : await syncImages(items, args.dryRun, main.canonical, args.concurrency);
const report = {
  version: 2,
  mode: args.dryRun ? 'dry-run' : 'apply',
  table_id: tableId(),
  sku_count: items.length,
  image_count: items.reduce((sum, item) => sum + item.images.length, 0),
  main: { ...main, canonical: undefined },
  images,
};
if (args.report) await writeJson(args.report, report);
console.log(JSON.stringify(report, null, 2));
