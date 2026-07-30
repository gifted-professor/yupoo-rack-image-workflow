#!/usr/bin/env node
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { projectRoot, resolveProjectPath, resolvePythonRuntime, runPool, writeJson } from './workflow-lib.mjs';

const execFileAsync = promisify(execFile);

function parseArgs(argv) {
  const args = { baseUrl: 'http://127.0.0.1:8910', concurrency: 4 };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--base-url') args.baseUrl = argv[++index];
    else if (value === '--concurrency') args.concurrency = Number(argv[++index]);
    else throw new Error(`Unknown argument: ${value}`);
  }
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

const args = parseArgs(process.argv.slice(2));
const response = await fetch(new URL('/api/products', args.baseUrl));
if (!response.ok) throw new Error(`Dashboard API HTTP ${response.status}`);
const { products = [] } = await response.json();
const python = await resolvePythonRuntime();
const workflow = resolveProjectPath('src/product_image_workflow.py');

function categoryEnForProduct(product) {
  const evidence = [product.title, product.short_name, product.category, ...(product.tags || [])]
    .filter(Boolean)
    .join(' ');
  return /女|女子|women|woman|female/i.test(evidence) ? 'Women' : 'Men';
}

const jobs = [];

for (const product of products) {
  if (!(Number(product.sale_price) > 0) || !(Number(product.cost_price) > 0)) continue;
  for (const view of ['front', 'back']) {
    const image = product.images?.find(item => item.view === view);
    if (!image?.relative_path) continue;
    jobs.push({ product, view, image });
  }
}

const results = await runPool(jobs, args.concurrency, async job => {
  const { product, view, image } = job;
  const input = resolveProjectPath(image.relative_path);
  const outputRelative = `work/items/${product.sku}/price-previews/${view}-sale.jpg`;
  const output = resolveProjectPath(outputRelative);
  const manifestPath = resolveProjectPath(`work/items/${product.sku}/price-previews/manifest.json`);
  const currentManifest = await fs.readFile(manifestPath, 'utf8').then(JSON.parse).catch(() => ({}));
  const categoryEn = categoryEnForProduct(product);
  const sourceStat = await fs.stat(input);
  const cached = currentManifest.views?.[view];
  const cacheValid = cached
    && cached.source === image.relative_path
    && Number(cached.source_mtime_ms) === Number(sourceStat.mtimeMs)
    && Number(cached.sale_price) === Number(product.sale_price)
    && cached.category_en === categoryEn
    && await exists(output);
  if (!cacheValid) {
    await execFileAsync(python, [
      workflow,
      'render-physical-sign',
      '--input', input,
      '--output', output,
      '--cost', String(product.cost_price),
      '--pricing', resolveProjectPath('config/pricing.json'),
      '--category', product.category || '服装',
      '--category-en', categoryEn,
    ], { cwd: projectRoot, maxBuffer: 2 * 1024 * 1024 });
  }
  return {
    ok: true,
    sku: product.sku,
    view,
    source: image.relative_path,
    source_mtime_ms: sourceStat.mtimeMs,
    sale_price: product.sale_price,
    output: outputRelative,
    category_en: categoryEn,
    cached: cacheValid,
  };
});

for (const product of products) {
  const productResults = results.filter(result => result?.ok && result.sku === product.sku);
  if (!productResults.length) continue;
  const views = Object.fromEntries(productResults.map(result => [result.view, {
    source: result.source,
    source_mtime_ms: result.source_mtime_ms,
    sale_price: result.sale_price,
    category_en: result.category_en,
    output: result.output,
  }]));
  await writeJson(`work/items/${product.sku}/price-previews/manifest.json`, {
    version: 1,
    sku: product.sku,
    generated_at: new Date().toISOString(),
    status: ['front', 'back'].every(view => views[view]) ? 'READY' : 'PARTIAL',
    views,
  });
}

const report = {
  ok: results.every(result => result?.ok),
  total: jobs.length,
  generated: results.filter(result => result?.ok && !result.cached).length,
  cached: results.filter(result => result?.ok && result.cached).length,
  failed: results.filter(result => !result?.ok).length,
  results,
};
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;
