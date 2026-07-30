#!/usr/bin/env node
import path from 'node:path';

import {
  assertReadable,
  callImageBridge,
  checkImageBridge,
  extensionFor,
  loadLocalEnv,
  makeRunId,
  parseArgs,
  readJson,
  resolveProjectPath,
  runPool,
  saveGeneratedImage,
  writeJson,
} from './workflow-lib.mjs';

await loadLocalEnv();

const args = parseArgs(process.argv.slice(2));
if (!args.batch) throw new Error('Usage: node scripts/repair-racks.mjs --batch <repairs.json> [--run-id id] [--dry-run]');
const batch = await readJson(args.batch);
const limit = Number(batch.settings?.max_reference_images || 5);
const jobs = (batch.jobs || []).map(job => ({
  ...job,
  references: [job.target, ...(job.references || [])],
}));

for (const job of jobs) {
  if (!job.id || !job.sku || !job.prompt) throw new Error('Every repair job requires id, sku, and prompt');
  if (job.references.length > limit) throw new Error(`${job.id}: reference limit ${limit} exceeded`);
  for (const reference of job.references) await assertReadable(reference, `${job.id} reference`);
}

if (args.dryRun) {
  console.log(JSON.stringify({ ok: true, mode: 'dry-run', configuredJobs: jobs.length, referenceLimit: limit }, null, 2));
  process.exit(0);
}

const activeJobs = jobs.filter(job => job.enabled !== false);
if (!activeJobs.length) throw new Error('No enabled repair jobs.');
const runId = args.runId || makeRunId('repair');
const bridgeUrl = process.env.IMAGE_BRIDGE_URL || batch.settings?.bridge_url || 'http://127.0.0.1:8907/api/image/generate';
const concurrency = Number(batch.settings?.concurrency || 3);
const bridgeConfig = await checkImageBridge(bridgeUrl);
const started = Date.now();

const results = await runPool(activeJobs, concurrency, async job => {
  const generated = await callImageBridge({
    bridgeUrl,
    prompt: [
      'This is a targeted correction, not a redesign.',
      'The first reference is the generated composition to repair. Preserve everything not named in the correction.',
      'The remaining Yupoo references define product truth.',
      'Keep the physical orange-and-black sign completely blank.',
      job.prompt,
    ].join('\n'),
    type: '商品原图定点修复',
    references: job.references,
    sku: job.sku,
    verifiedFacts: ['The first image is the repair target. Yupoo references define product truth.'],
  });
  const extension = extensionFor(generated.mime);
  const output = await saveGeneratedImage(path.join('runs', runId, 'review', `${job.id}.${extension}`), generated);
  await writeJson(path.join('runs', runId, 'responses', `${job.id}.json`), {
    ...generated.body,
    imageDataUrl: '[removed: saved as image file]',
    imageDataUrls: '[removed: saved as image file]',
    localMeta: { elapsedMs: generated.elapsedMs, references: job.references, output },
  });
  return { ok: true, id: job.id, sku: job.sku, elapsedMs: generated.elapsedMs, model: generated.body.model, output, status: 'REVIEW_PENDING' };
});

const summary = {
  runId,
  bridgeConfig,
  concurrency,
  elapsedMs: Date.now() - started,
  total: results.length,
  succeeded: results.filter(result => result.ok).length,
  failed: results.filter(result => !result.ok).length,
  results,
};
await writeJson(path.join('runs', runId, 'summary.json'), summary);
console.log(JSON.stringify(summary, null, 2));
