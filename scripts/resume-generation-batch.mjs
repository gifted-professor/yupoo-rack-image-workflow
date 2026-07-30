#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

import { collectLatestViews } from './artifact-state.mjs';
import { projectRoot, resolveProjectPath, writeJson } from './workflow-lib.mjs';

function parseArgs(argv) {
  const args = { batch: null, output: null, concurrency: 1 };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === '--batch') args.batch = argv[++i];
    else if (value === '--output') args.output = argv[++i];
    else if (value === '--concurrency') args.concurrency = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!args.batch || !args.output) throw new Error('Usage: node scripts/resume-generation-batch.mjs --batch <batch.json> --output <retry.json> [--concurrency 1]');
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const source = JSON.parse(await fs.readFile(resolveProjectPath(args.batch), 'utf8'));
  const items = [];
  const skipped = [];
  for (const item of source.items || []) {
    const views = await collectLatestViews(projectRoot, item.sku);
    const required = ['front', 'back', 'tryon_main', 'tryon_detail', 'tryon_back'];
    const missing = required.filter(view => !views[view]);
    if (!missing.length) {
      skipped.push(item.sku);
      continue;
    }
    items.push({ ...item, enabled_views: missing });
  }
  const batch = {
    ...source,
    generated_at: new Date().toISOString(),
    settings: { ...source.settings, concurrency: Math.max(1, Number(args.concurrency) || 1) },
    items,
  };
  await writeJson(args.output, batch);
  console.log(JSON.stringify({ ok: true, source: path.relative(projectRoot, resolveProjectPath(args.batch)), output: path.relative(projectRoot, resolveProjectPath(args.output)), resumed_items: items.length, skipped_complete: skipped.length, missing_by_sku: Object.fromEntries(items.map(item => [item.sku, item.enabled_views])) }, null, 2));
}

main().catch(error => { console.error(`错误: ${error.message}`); process.exit(1); });
