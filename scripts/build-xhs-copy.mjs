#!/usr/bin/env node
// 为每个 work/items/<SKU>/ 生成小红书笔记文案 xhs-copy.json。
// 风格参照「小林在奥莱」实拍笔记：{SKU} 实拍来啦～ / {品牌}{品类}{颜色}不要太好看！
// 纯模板套用，确定性：模板由 SKU 哈希选定。不调用 LLM，同输入同输出。

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { projectRoot, resolveProjectPath, runPool, writeJson } from './workflow-lib.mjs';

// 直接执行才跑 main；被测试 import 时不自动执行。
const isMain = fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || '');

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

export function hashIndex(sku, modulus) {
  let hash = 0;
  for (let i = 0; i < sku.length; i += 1) hash = (hash * 31 + sku.charCodeAt(i)) >>> 0;
  return hash % modulus;
}

async function readJsonSafe(target) {
  try { return JSON.parse(await fs.readFile(target, 'utf8')); } catch { return null; }
}

async function listLocalSkus() {
  const itemsRoot = resolveProjectPath('work/items');
  const entries = await fs.readdir(itemsRoot, { withFileTypes: true });
  return entries.filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => e.name).sort();
}

// 小红书标签池：耐克/nike/三叶草/adidas/外套/穿搭/奥莱/奥莱代购。
// 按品牌+品类确定性选 3 个，不随机——同 SKU 同标签。
export function brandTags(brand) {
  const b = String(brand || '').toLowerCase();
  if (b === 'nike' || b === 'jordan') return ['耐克', 'nike'];
  if (b === 'adidas') return ['adidas', '三叶草'];
  if (b === 'ck' || b === 'calvinklein') return ['CK'];
  return ['奥莱代购'];
}
export function isOuterwear(category) {
  return /外套|夹克|风衣|棉服|羽绒|冲锋|大衣|马甲/.test(String(category || ''));
}
export function buildTags(brand, category) {
  const bt = brandTags(brand);
  const outer = isOuterwear(category);
  let tags;
  if (bt.length >= 2) {
    tags = outer ? [bt[0], '外套', '奥莱'] : [bt[0], bt[1], '奥莱'];
  } else {
    tags = [bt[0], outer ? '外套' : '穿搭', '奥莱'];
  }
  return [...new Set(tags)].slice(0, 3);
}

// 描述式：{品牌}{品类} {主色}不要太好看！资料不全则回退到纯标题模板。
export function descriptiveTitle(facts, draft) {
  const brand = facts?.brand_display || '';
  const category = draft?.category || facts?.category || '';
  const colors = draft?.colors?.length ? draft.colors : (facts?.colors || []);
  const mainColor = colors[0] || '';
  if (!brand || !category) return null;
  const colorPart = mainColor ? `${mainColor}` : '';
  return `${brand}${category} ${colorPart}不要太好看！`.replace(/\s+/g, ' ').trim();
}

async function buildOne(sku) {
  const pkg = await readJsonSafe(resolveProjectPath(`work/items/${sku}/publish-package.json`));
  const draft = pkg || await readJsonSafe(resolveProjectPath(`work/items/${sku}/publish-draft.json`));
  const facts = await readJsonSafe(resolveProjectPath(`work/items/${sku}/product-facts.json`));

  // 模板分配：0=带～纯标题, 1=无～纯标题, 2=描述式。描述式资料不全时回退到带～。
  let tplIndex = hashIndex(sku, 3);
  let title;
  if (tplIndex === 2) {
    title = descriptiveTitle(facts, draft) || `${sku} 实拍来啦～`;
    if (!descriptiveTitle(facts, draft)) tplIndex = 0;
  } else if (tplIndex === 1) {
    title = `${sku} 实拍来啦`;
  } else {
    title = `${sku} 实拍来啦～`;
  }
  const template = ['实拍来啦～', '实拍来啦', '描述式'][tplIndex];
  const tags = buildTags(facts?.brand, draft?.category || facts?.category);
  const out = {
    version: 1,
    sku,
    template,
    title,
    tags,
    // 笔记正文：一句话补充，空着也行；小红书笔记正文通常简短。
    body: title === `${sku} 实拍来啦～` || title === `${sku} 实拍来啦`
      ? '主页均为实拍，需要咨询点击我想要～'
      : '主页均为实拍，需要咨询点击我想要～',
  };
  await writeJson(resolveProjectPath(`work/items/${sku}/xhs-copy.json`), out);
  return { sku, template, title, tags };
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

// 直接执行才跑 main；被测试 import 时不自动执行。
if (isMain) {
  main().catch(error => {
    console.error(`错误: ${error.message}`);
    process.exit(1);
  });
}