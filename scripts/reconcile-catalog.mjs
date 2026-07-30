#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

import { inspectSkuArtifacts } from './artifact-state.mjs';
import { isLockedState } from './catalog-state.mjs';
import { projectRoot, resolveProjectPath } from './workflow-lib.mjs';

function parseArgs(argv) {
  const args = { catalog: 'config/sku-catalog.json', snapshot: null, report: null, apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--catalog') args.catalog = argv[++index];
    else if (value === '--snapshot') args.snapshot = argv[++index];
    else if (value === '--report') args.report = argv[++index];
    else if (value === '--apply') args.apply = true;
    else if (value === '--dry-run') args.apply = false;
    else throw new Error(`Unknown argument: ${value}`);
  }
  return args;
}

async function writeAtomic(target, value) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  await fs.rename(temporary, target);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const catalogPath = resolveProjectPath(args.catalog);
  const catalog = JSON.parse(await fs.readFile(catalogPath, 'utf8'));
  let scope = new Set((catalog.items || []).map(item => item.sku));
  if (args.snapshot) {
    const snapshot = JSON.parse(await fs.readFile(resolveProjectPath(args.snapshot), 'utf8'));
    scope = new Set((snapshot.products || []).map(item => item.sku));
  }
  const results = [];
  for (const sku of [...scope].sort()) results.push(await inspectSkuArtifacts({ projectRoot, sku }));
  const counts = Object.fromEntries([...new Set(results.map(item => item.state))].sort().map(state => [state, results.filter(item => item.state === state).length]));
  const report = { version: 1, generated_at: new Date().toISOString(), scope_count: scope.size, counts, results };
  if (args.report) await writeAtomic(resolveProjectPath(args.report), report);
  if (args.apply) {
    const bySku = new Map(results.map(result => [result.sku, result]));
    catalog.items = catalog.items.map(item => {
      const result = bySku.get(item.sku);
      if (!result || isLockedState(item.state)) return item;
      return {
        ...item,
        state: result.state,
        next_action: result.next_action,
        stage_evidence: {
          completed_stages: result.completed_stages,
          available_views: result.available_views,
          missing_views: result.missing_views,
        },
        reconciled_at: report.generated_at,
      };
    });
    catalog.last_updated = report.generated_at;
    await writeAtomic(catalogPath, catalog);
  }
  console.log(JSON.stringify(report, null, 2));
}

main().catch(error => {
  console.error(`错误: ${error.message}`);
  process.exit(1);
});
