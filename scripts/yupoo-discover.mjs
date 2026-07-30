#!/usr/bin/env node
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { mergeCatalog } from './catalog-state.mjs';
import { makeRunId, projectRoot, resolveProjectPath, resolvePythonRuntime } from './workflow-lib.mjs';

const execFileAsync = promisify(execFile);

export function parseDiscoveryArgs(argv) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
  const args = {
    albumUrl: null,
    fromDate: '2026-03-01',
    toDate: today,
    maxPages: 100,
    maxProducts: 10000,
    dryRun: false,
    snapshot: null,
    catalog: 'config/sku-catalog.json',
    cachedHtml: null,
    cachedProductDir: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--album-url') args.albumUrl = argv[++index];
    else if (value === '--from') args.fromDate = argv[++index];
    else if (value === '--to') args.toDate = argv[++index];
    else if (value === '--max-pages') args.maxPages = Number(argv[++index]);
    else if (value === '--max-products' || value === '--max-new') args.maxProducts = Number(argv[++index]);
    else if (value === '--snapshot') args.snapshot = argv[++index];
    else if (value === '--catalog') args.catalog = argv[++index];
    else if (value === '--cached-html') args.cachedHtml = argv[++index];
    else if (value === '--cached-product-dir') args.cachedProductDir = argv[++index];
    else if (value === '--dry-run') args.dryRun = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!args.albumUrl) throw new Error('请提供 --album-url 参数');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(args.toDate)) {
    throw new Error('DATE_MUST_BE_YYYY_MM_DD');
  }
  if (args.fromDate > args.toDate) throw new Error('FROM_DATE_AFTER_TO_DATE');
  if (!(args.maxPages > 0) || !(args.maxProducts > 0)) throw new Error('LIMIT_MUST_BE_POSITIVE');
  return args;
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function discoverOnePage(url, args, pageIndex) {
  const python = await resolvePythonRuntime();
  const command = [
    resolveProjectPath('src/product_image_workflow.py'),
    'discover-album',
    '--album-url', url,
    '--from-date', args.fromDate,
    '--to-date', args.toDate,
    '--max-products', String(Math.max(1, args.maxProducts)),
  ];
  if (args.cachedHtml && pageIndex === 0) command.push('--cached-html', resolveProjectPath(args.cachedHtml));
  if (args.cachedProductDir) command.push('--cached-product-dir', resolveProjectPath(args.cachedProductDir));
  const { stdout, stderr } = await execFileAsync(python, command, {
    cwd: projectRoot,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (stderr.trim()) process.stderr.write(stderr);
  return JSON.parse(stdout);
}

export function combineDiscoveryPages(pages, options = {}) {
  const byAlbum = new Map();
  const warnings = [];
  for (const page of pages) {
    warnings.push(...(page.warnings || []));
    for (const product of page.products || []) {
      const key = String(product.album_id || product.url || '');
      if (!key || byAlbum.has(key)) continue;
      byAlbum.set(key, product);
    }
  }
  const allProducts = [...byAlbum.values()];
  const included = allProducts.filter(product => product.included === true && product.sku);
  const excluded = allProducts.filter(product => product.included !== true && product.picture_dates?.length);
  const undated = allProducts.filter(product => !product.picture_dates?.length);
  return {
    version: 1,
    source: options.source,
    from_date: options.fromDate,
    to_date: options.toDate,
    captured_at: options.capturedAt || new Date().toISOString(),
    pages_scanned: pages.length,
    albums_scanned: allProducts.length,
    included_count: included.length,
    excluded_count: excluded.length,
    undated_count: undated.length,
    products: included,
    excluded_products: excluded,
    undated_products: undated,
    warnings,
  };
}

async function writeAtomic(target, value) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  await fs.rename(temporary, target);
}

export async function runDiscovery(args) {
  const pages = [];
  const seenPages = new Set();
  let current = args.albumUrl;
  for (let pageIndex = 0; current && pageIndex < args.maxPages; pageIndex += 1) {
    if (seenPages.has(current)) throw new Error(`PAGINATION_LOOP:${current}`);
    seenPages.add(current);
    process.stderr.write(`扫描 Yupoo 第 ${pageIndex + 1} 页: ${current}\n`);
    const page = await discoverOnePage(current, args, pageIndex);
    pages.push(page);
    if (pages.reduce((total, item) => total + (item.products?.length || 0), 0) >= args.maxProducts) break;
    current = page.next_page;
    if (args.cachedHtml) break;
  }
  if (current && pages.length >= args.maxPages) throw new Error(`MAX_PAGES_REACHED:${args.maxPages}`);
  return combineDiscoveryPages(pages, {
    source: args.albumUrl,
    fromDate: args.fromDate,
    toDate: args.toDate,
  });
}

async function main() {
  const args = parseDiscoveryArgs(process.argv.slice(2));
  const snapshot = await runDiscovery(args);
  if (!args.dryRun) {
    const snapshotPath = resolveProjectPath(args.snapshot || path.join('runs', makeRunId('discovery'), 'discovery.json'));
    await writeAtomic(snapshotPath, snapshot);
    let catalog = { version: 2, items: [] };
    const catalogPath = resolveProjectPath(args.catalog);
    if (await exists(catalogPath)) catalog = JSON.parse(await fs.readFile(catalogPath, 'utf8'));
    const discovered = snapshot.products.map(product => ({
      sku: product.sku,
      title: product.title,
      state: 'DISCOVERED',
      sources: [{
        album_id: product.album_id,
        url: product.url,
        picture_dates: product.picture_dates,
        picture_date_min: product.picture_date_min,
        picture_date_max: product.picture_date_max,
        in_range_picture_count: product.in_range_picture_count,
        discovered_at: snapshot.captured_at,
      }],
    }));
    await writeAtomic(catalogPath, mergeCatalog(catalog, discovered, { now: snapshot.captured_at }));
    snapshot.snapshot_path = path.relative(projectRoot, snapshotPath);
  }
  console.log(JSON.stringify(snapshot, null, 2));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch(error => {
    console.error(`错误: ${error.message}`);
    process.exit(1);
  });
}
