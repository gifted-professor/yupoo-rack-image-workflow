#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { projectRoot, resolveProjectPath, resolvePythonRuntime, writeJson } from './workflow-lib.mjs';

const execFileAsync = promisify(execFile);

function parseArgs(argv) {
  const args = { snapshot: 'runs/full-20260722/discovery.json', report: 'runs/full-20260722/prepare-report.json', limit: Infinity, sku: null, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === '--snapshot') args.snapshot = argv[++i];
    else if (value === '--report') args.report = argv[++i];
    else if (value === '--limit') args.limit = Number(argv[++i]);
    else if (value === '--sku') args.sku = argv[++i];
    else if (value === '--dry-run') args.dryRun = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const snapshot = JSON.parse(await fs.readFile(resolveProjectPath(args.snapshot), 'utf8'));
  const catalog = JSON.parse(await fs.readFile(resolveProjectPath('config/sku-catalog.json'), 'utf8'));
  const included = new Set((snapshot.products || []).filter(item => item.included).map(item => item.sku));
  const selected = (catalog.items || [])
    .filter(item => included.has(item.sku) && (item.state === 'READY_TO_GENERATE' || item.state === 'CONFIG_REQUIRED'))
    .filter(item => !args.sku || item.sku === args.sku)
    .filter(item => item.sku !== 'KH2713')
    .filter(item => item.sku === 'KT3055' || item.state === 'READY_TO_GENERATE')
    .sort((a, b) => a.sku.localeCompare(b.sku))
    .slice(0, Number.isFinite(args.limit) ? args.limit : undefined);
  if (args.dryRun) {
    console.log(JSON.stringify({ ok: true, mode: 'dry-run', selected: selected.length, skus: selected.map(item => item.sku) }, null, 2));
    return;
  }
  const python = await resolvePythonRuntime();
  const workflow = resolveProjectPath('src/product_image_workflow.py');
  const results = [];
  for (const item of selected) {
    try {
      const { stdout } = await execFileAsync(python, [
        workflow, 'prepare-item',
        '--manifest', `work/items/${item.sku}/manifest.json`,
        '--classification', `config/${item.sku}.classification.json`,
        '--scenes', 'config/store-scenes.json',
        '--pricing', 'config/pricing.json',
        '--publishing', 'config/publishing.json',
        '--confirm-cost',
      ], { cwd: projectRoot, maxBuffer: 6 * 1024 * 1024 });
      const parsed = JSON.parse(stdout);
      results.push({ ok: true, sku: item.sku, sale_price: parsed.pricing?.sale_price, reference_status: { front: parsed.packs?.front?.status, back: parsed.packs?.back?.status } });
    } catch (error) {
      results.push({ ok: false, sku: item.sku, error: error?.stderr || error?.message || String(error) });
    }
  }
  const report = { version: 1, generated_at: new Date().toISOString(), requested: selected.length, succeeded: results.filter(item => item.ok).length, failed: results.filter(item => !item.ok).length, results };
  await writeJson(args.report, report);
  console.log(JSON.stringify(report, null, 2));
  if (report.failed) process.exitCode = 1;
}

main().catch(error => { console.error(`错误: ${error.message}`); process.exit(1); });
