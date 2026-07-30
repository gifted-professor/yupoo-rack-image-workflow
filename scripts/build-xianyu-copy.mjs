#!/usr/bin/env node
// 为每个 work/items/<SKU>/ 生成闲鱼文案 xianyu-copy.json。
// 纯模板套用，确定性：模板由 SKU 哈希选定，尺码行按 publish-package/facts 的实际尺码范围填。
// 不调用 LLM，同输入同输出，可复现可审计。

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { projectRoot, resolveProjectPath, runPool, writeJson } from './workflow-lib.mjs';

const isMain = fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || '');

// 闲鱼文案模板（来自运营口述）。{size} 占位按 SKU 实际尺码范围填，如 S-XXL。
export const TEMPLATES = [
  {
    key: '撤店清仓',
    build: sizeLine => [
      '【撤店清仓】',
      '图片均为实拍',
      '支持七天无理由退换',
      '出几件 少量现货',
      sizeLine,
      '具体尺寸私聊',
    ].filter(Boolean).join('\n'),
  },
  {
    key: '出全新',
    build: () => [
      '出全新',
      '朋友买的码子不合适 还有几件',
      '具体尺码需要咨询，点击我想要',
    ].join('\n'),
  },
  {
    key: '出闲置',
    build: () => [
      '出闲置',
      '朋友买的码数不合适',
      '还有几个码数 具体点击我想要',
    ].join('\n'),
  },
  {
    key: '奥莱折扣',
    build: sizeLine => [
      '【奥莱折扣】',
      sizeLine,
      '部分 断码 数量有限',
      '主页均为实拍 需要的点击我想要咨询',
    ].filter(Boolean).join('\n'),
  },
];

function parseArgs(argv) {
  const args = { skus: [], concurrency: 6, report: null };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--sku') args.skus.push(...String(argv[++index]).split(',').filter(Boolean));
    else if (value === '--concurrency') args.concurrency = Number(argv[++index]);
    else if (value === '--report') args.report = argv[++index];
    else throw new Error(`Unknown argument: ${value}`);
  }
  return args;
}

// 确定性哈希：同 SKU 永远选同一模板，避免每次同步文案变。
export function hashIndex(sku, modulus) {
  let hash = 0;
  for (let i = 0; i < sku.length; i += 1) hash = (hash * 31 + sku.charCodeAt(i)) >>> 0;
  return hash % modulus;
}

export function sizeRange(sizes) {
  if (!Array.isArray(sizes) || sizes.length === 0) return '';
  if (sizes.length === 1) return sizes[0];
  return `${sizes[0]}-${sizes[sizes.length - 1]}`;
}

async function readJsonSafe(target) {
  try { return JSON.parse(await fs.readFile(target, 'utf8')); } catch { return null; }
}

async function listLocalSkus() {
  const itemsRoot = resolveProjectPath('work/items');
  const entries = await fs.readdir(itemsRoot, { withFileTypes: true });
  return entries.filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => e.name).sort();
}

async function buildOne(sku) {
  const pkg = await readJsonSafe(resolveProjectPath(`work/items/${sku}/publish-package.json`));
  const draft = pkg || await readJsonSafe(resolveProjectPath(`work/items/${sku}/publish-draft.json`));
  const facts = await readJsonSafe(resolveProjectPath(`work/items/${sku}/product-facts.json`));
  const sizes = draft?.sizes?.length ? draft.sizes : (facts?.sizes || []);
  const range = sizeRange(sizes);
  const tplIndex = hashIndex(sku, TEMPLATES.length);
  const tpl = TEMPLATES[tplIndex];
  const sizeLine = range ? `尺码 ${range}` : '';
  const text = tpl.build(sizeLine);
  const out = {
    version: 1,
    sku,
    template: tpl.key,
    sizes,
    size_range: range || null,
    text,
  };
  const target = resolveProjectPath(`work/items/${sku}/xianyu-copy.json`);
  await writeJson(target, out);
  return { sku, template: tpl.key, size_range: range || null };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const all = await listLocalSkus();
  const requested = new Set(args.skus);
  const skus = all.filter(sku => !requested.size || requested.has(sku));
  const results = await runPool(skus, args.concurrency, buildOne);
  const report = {
    generated: results.length,
    by_template: results.reduce((map, r) => {
      map[r.template] = (map[r.template] || 0) + 1;
      return map;
    }, {}),
    items: results,
  };
  const out = JSON.stringify(report, null, 2);
  if (args.report) await fs.writeFile(resolveProjectPath(args.report), `${out}\n`);
  console.log(out);
}

if (isMain) {
  main().catch(error => {
    console.error(`错误: ${error.message}`);
    process.exit(1);
  });
}