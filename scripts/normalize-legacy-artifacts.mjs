#!/usr/bin/env node
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { collectLatestViews, REQUIRED_VIEWS } from './artifact-state.mjs';
import {
  projectRoot,
  readJson,
  resolveProjectPath,
  resolvePythonRuntime,
  writeJson,
} from './workflow-lib.mjs';

const execFileAsync = promisify(execFile);

function parseArgs(argv) {
  const args = {
    snapshot: 'runs/full-20260722/discovery.json',
    runId: 'full-20260722-legacy-normalized',
    skus: [],
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--snapshot') args.snapshot = argv[++index];
    else if (value === '--run-id') args.runId = argv[++index];
    else if (value === '--sku') args.skus.push(...String(argv[++index]).split(',').map(item => item.trim()).filter(Boolean));
    else if (value === '--dry-run') args.dryRun = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  return args;
}

async function normalizeView(source, output) {
  const python = await resolvePythonRuntime();
  const workflow = resolveProjectPath('src/product_image_workflow.py');
  const { stdout } = await execFileAsync(python, [
    workflow,
    'normalize-canvas',
    '--input', source,
    '--output', output,
    '--width', '1080',
    '--height', '1440',
  ], { cwd: projectRoot, maxBuffer: 2 * 1024 * 1024 });
  return JSON.parse(stdout);
}

const args = parseArgs(process.argv.slice(2));
const snapshot = await readJson(args.snapshot);
const scope = (snapshot.products || [])
  .filter(item => item.included)
  .map(item => item.sku)
  .filter(sku => !args.skus.length || args.skus.includes(sku));
const runRoot = resolveProjectPath(path.join('runs', args.runId));
const results = [];

for (const sku of scope) {
  const views = await collectLatestViews(projectRoot, sku);
  const missing = REQUIRED_VIEWS.filter(view => !views[view]);
  if (missing.length) {
    results.push({ ok: false, sku, missing, error: 'cannot normalize an incomplete product' });
    continue;
  }
  const itemResult = { ok: true, sku, views: {} };
  for (const view of REQUIRED_VIEWS) {
    const source = resolveProjectPath(views[view].path);
    const output = path.join(runRoot, 'review', `${sku}-${view}.png`);
    const response = path.join(runRoot, 'responses', `${sku}-${view}.json`);
    if (!args.dryRun) {
      await fs.mkdir(path.dirname(output), { recursive: true });
      await fs.mkdir(path.dirname(response), { recursive: true });
      const canvas = await normalizeView(source, output);
      await writeJson(path.relative(projectRoot, response), {
        version: 1,
        sku,
        view,
        status: 'REVIEW_PENDING',
        legacy: true,
        provenance: 'legacy-artifact-normalization',
        warning: 'Original legacy artifact was preserved and normalized to the production 1080x1440 canvas; no upstream response body was available for this historical artifact.',
        localMeta: {
          source: views[view].path,
          source_run_id: views[view].run_id,
          output: path.relative(projectRoot, output),
          canvas,
        },
      });
    }
    itemResult.views[view] = {
      source: views[view].path,
      source_run_id: views[view].run_id,
      output: path.relative(projectRoot, output),
      response: path.relative(projectRoot, response),
    };
  }
  results.push(itemResult);
}

const report = {
  version: 1,
  run_id: args.runId,
  mode: args.dryRun ? 'dry-run' : 'write',
  scope_count: scope.length,
  succeeded: results.filter(item => item.ok).length,
  failed: results.filter(item => !item.ok).length,
  results,
};
if (!args.dryRun) await writeJson(path.join('runs', args.runId, 'legacy-normalization.json'), report);
console.log(JSON.stringify(report, null, 2));
if (report.failed) process.exitCode = 1;
