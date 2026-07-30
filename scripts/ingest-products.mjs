#!/usr/bin/env node
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { projectRoot, resolveProjectPath, resolvePythonRuntime, runPool } from './workflow-lib.mjs';

const execFileAsync = promisify(execFile);

function parseArgs(argv) {
  const args = { snapshot: null, catalog: 'config/sku-catalog.json', report: null, concurrency: 4, limit: Infinity, skus: [], dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--snapshot') args.snapshot = argv[++index];
    else if (value === '--catalog') args.catalog = argv[++index];
    else if (value === '--report') args.report = argv[++index];
    else if (value === '--concurrency') args.concurrency = Number(argv[++index]);
    else if (value === '--limit') args.limit = Number(argv[++index]);
    else if (value === '--sku') args.skus.push(...String(argv[++index]).split(',').filter(Boolean));
    else if (value === '--dry-run') args.dryRun = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!args.snapshot) throw new Error('Usage: --snapshot <discovery.json>');
  if (!(args.concurrency > 0) || !(args.limit > 0)) throw new Error('LIMIT_MUST_BE_POSITIVE');
  return args;
}

async function exists(target) {
  try { await fs.access(target); return true; } catch { return false; }
}

async function writeAtomic(target, value) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  await fs.rename(temporary, target);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const snapshot = JSON.parse(await fs.readFile(resolveProjectPath(args.snapshot), 'utf8'));
  const catalog = JSON.parse(await fs.readFile(resolveProjectPath(args.catalog), 'utf8'));
  const stateBySku = new Map(catalog.items.map(item => [item.sku, item.state]));
  const requested = new Set(args.skus);
  const selected = snapshot.products
    .filter(product => stateBySku.get(product.sku) === 'INGEST_REQUIRED')
    .filter(product => !requested.size || requested.has(product.sku))
    .slice(0, args.limit);
  if (args.dryRun) {
    console.log(JSON.stringify({ mode: 'dry-run', selected: selected.length, skus: selected.map(item => item.sku) }, null, 2));
    return;
  }
  const python = await resolvePythonRuntime();
  const workflow = resolveProjectPath('src/product_image_workflow.py');
  const results = await runPool(selected.map(product => ({ id: product.sku, ...product })), args.concurrency, async product => {
    const { stdout } = await execFileAsync(python, [
      workflow,
      'ingest-album',
      '--album-url', product.url,
      '--output-root', resolveProjectPath('work/items'),
    ], { cwd: projectRoot, maxBuffer: 32 * 1024 * 1024 });
    const manifest = JSON.parse(stdout);
    return { ok: true, sku: product.sku, album_id: product.album_id, images: manifest.images.length, manifest: `work/items/${product.sku}/manifest.json`, source_revision: manifest.source_revision };
  });
  const report = {
    generated_at: new Date().toISOString(),
    selected: selected.length,
    succeeded: results.filter(result => result.ok).length,
    failed: results.filter(result => !result.ok).length,
    results,
  };
  if (args.report) await writeAtomic(resolveProjectPath(args.report), report);
  console.log(JSON.stringify(report, null, 2));
  if (report.failed) process.exitCode = 1;
}

main().catch(error => {
  console.error(`错误: ${error.message}`);
  process.exit(1);
});
