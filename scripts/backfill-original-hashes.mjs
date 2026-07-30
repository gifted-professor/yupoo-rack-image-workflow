#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { projectRoot, readJson, resolveProjectPath, writeJson } from './workflow-lib.mjs';

function parseArgs(argv) {
  const args = { snapshot: 'runs/full-20260722/discovery.json', dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--snapshot') args.snapshot = argv[++index];
    else if (value === '--dry-run') args.dryRun = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const snapshot = await readJson(args.snapshot);
const results = [];

for (const product of (snapshot.products || []).filter(item => item.included)) {
  const sku = product.sku;
  const manifestPath = resolveProjectPath(`work/items/${sku}/manifest.json`);
  const manifest = await readJson(manifestPath, null);
  if (!manifest) {
    results.push({ ok: false, sku, error: 'missing manifest' });
    continue;
  }
  let changed = 0;
  for (const image of manifest.images || []) {
    const source = path.isAbsolute(image.path) ? image.path : resolveProjectPath(image.path);
    const sha256 = crypto.createHash('sha256').update(await fs.readFile(source)).digest('hex');
    if (image.sha256 !== sha256) {
      image.sha256 = sha256;
      changed += 1;
    }
  }
  if (!args.dryRun && changed) await writeJson(path.relative(projectRoot, manifestPath), manifest);
  results.push({ ok: true, sku, changed, images: (manifest.images || []).length });
}

const report = {
  version: 1,
  mode: args.dryRun ? 'dry-run' : 'write',
  products: results.length,
  changed_products: results.filter(item => item.ok && item.changed).length,
  changed_images: results.filter(item => item.ok).reduce((sum, item) => sum + item.changed, 0),
  failed: results.filter(item => !item.ok).length,
  results,
};
await writeJson('runs/full-20260722/original-hash-backfill.json', report);
console.log(JSON.stringify(report, null, 2));
if (report.failed) process.exitCode = 1;
