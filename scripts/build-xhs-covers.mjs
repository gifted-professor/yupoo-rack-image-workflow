#!/usr/bin/env node
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { promisify } from 'node:util';

import { resolveProjectPath, resolvePythonRuntime, runPool, writeJson } from './workflow-lib.mjs';

const execFileAsync = promisify(execFile);

function parseArgs(argv) {
  const args = { baseUrl: 'http://127.0.0.1:8910', concurrency: 3, skus: [], layout: 'diagonal', zoomTop: 0 };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--base-url') args.baseUrl = argv[++index];
    else if (value === '--concurrency') args.concurrency = Number(argv[++index]);
    else if (value === '--sku') args.skus.push(...String(argv[++index]).split(',').filter(Boolean));
    else if (value === '--layout') args.layout = argv[++index];
    else if (value === '--zoom-top') args.zoomTop = Number(argv[++index]);
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

function imageFor(product, view) {
  return product.images?.find(image => image.view === view);
}

const args = parseArgs(process.argv.slice(2));
const response = await fetch(new URL('/api/products', args.baseUrl));
if (!response.ok) throw new Error(`Dashboard API HTTP ${response.status}`);
const { products = [] } = await response.json();
const requested = new Set(args.skus);
const selected = products.filter(product => !requested.size || requested.has(product.sku));
const python = await resolvePythonRuntime();
const workflow = resolveProjectPath('src/product_image_workflow.py');

const jobs = selected.map(product => {
  const front = imageFor(product, 'front');
  const back = imageFor(product, 'back');
  const tryonFront = imageFor(product, 'tryon_main');
  const tryonBack = imageFor(product, 'tryon_back');
  return {
    id: product.sku,
    sku: product.sku,
    sources: {
      front: front?.price_preview_relative_path,
      back: back?.price_preview_relative_path,
      tryon_front: tryonFront?.relative_path,
      tryon_back: tryonBack?.relative_path,
    },
  };
});

const results = await runPool(jobs, args.concurrency, async job => {
  const missing = Object.entries(job.sources).filter(([, value]) => !value).map(([key]) => key);
  if (missing.length) throw new Error(`Missing cover sources: ${missing.join(', ')}`);
  for (const [name, value] of Object.entries(job.sources)) {
    if (!(await exists(resolveProjectPath(value)))) throw new Error(`Missing ${name} file: ${value}`);
  }
  const output = `work/items/${job.sku}/xhs-cover/four-grid.jpg`;
  await execFileAsync(python, [
    workflow,
    'render-xhs-cover',
    '--front', resolveProjectPath(job.sources.front),
    '--back', resolveProjectPath(job.sources.back),
    '--tryon-front', resolveProjectPath(job.sources.tryon_front),
    '--tryon-back', resolveProjectPath(job.sources.tryon_back),
    '--output', resolveProjectPath(output),
    '--width', '1080',
    '--height', '1440',
    '--gap', '12',
    '--layout', args.layout,
    '--zoom-top', String(args.zoomTop),
  ], { maxBuffer: 2 * 1024 * 1024 });
  await writeJson(`work/items/${job.sku}/xhs-cover/manifest.json`, {
    version: 1,
    sku: job.sku,
    generated_at: new Date().toISOString(),
    status: 'REVIEW_PENDING',
    layout: ['priced_front', 'priced_back', 'tryon_front', 'tryon_back'],
    canvas: { width: 1080, height: 1440 },
    sources: job.sources,
    output,
  });
  return { ok: true, sku: job.sku, output, status: 'REVIEW_PENDING' };
});

const report = {
  ok: results.every(result => result?.ok),
  requested: args.skus,
  selected: selected.length,
  generated: results.filter(result => result?.ok).length,
  failed: results.filter(result => !result?.ok).length,
  results,
};
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;
