#!/usr/bin/env node
// One-off: regenerate ONLY the 2 tryon views for IX1577-274 with corrected
// front-only prompt. Mirrors generate-racks.mjs compilePrompt + callImageBridge
// so the result is pipeline-faithful. Does not touch the fixed rack front/back.
import path from 'node:path';
import {
  loadLocalEnv, readJson, callImageBridge, saveGeneratedImage, writeJson,
  makeRunId, resolveProjectPath,
} from './workflow-lib.mjs';

await loadLocalEnv();

const batch = await readJson('config/IX1577-274.batch.json');
const rules = await readJson(batch.settings.prompt_rules);
const item = batch.items[0];
const bridgeUrl = process.env.IMAGE_BRIDGE_URL || batch.settings.bridge_url;
const runId = makeRunId('repair-tryon');

const directionRule = {
  tryon_main: 'Show a natural front or slight three-quarter in-store mirror-selfie try-on view, framed from head or shoulders to below the garment hem; the model holds the phone up covering the face so it is not identifiable.',
  tryon_detail: 'Show a closer in-store mirror-selfie detail view that clearly reveals the garment fit, fabric, logo, neckline, sleeves, and hem; the phone still covers the face.',
};

const jobs = ['tryon_main', 'tryon_detail'].map(viewName => {
  const view = item.tryon_views[viewName];
  const references = [view.scene_reference, ...(view.product_references || [])];
  const prompt = [
    ...(rules.tryon_required_rules || []),
    `SKU: ${item.sku}. Brand: ${item.brand}. Product type: ${item.product_type}.`,
    `The sole color-authority reference is: ${view.color_authority}.`,
    view.prompt,
    directionRule[viewName],
  ].join('\n');
  return { id: `${item.sku}-${viewName}`, viewName, references, prompt };
});

const results = [];
for (const job of jobs) {
  const generated = await callImageBridge({
    bridgeUrl,
    prompt: job.prompt,
    type: '商品实体店试穿上身图',
    references: job.references,
    sku: item.sku,
    verifiedFacts: [
      'Yupoo product images are the source of truth.',
      'The designated image is the sole color authority.',
      'The generated adult model and store scene are presentation only and must not change the garment.',
    ],
  });
  const ext = generated.mime === 'image/jpeg' ? 'jpg' : generated.mime.split('/')[1];
  const rel = path.join('runs', runId, 'review', `${job.id}.${ext}`);
  const output = await saveGeneratedImage(rel, generated);
  results.push({ id: job.id, view: job.viewName, output, elapsedMs: generated.elapsedMs, status: 'REVIEW_PENDING' });
  console.log(`${job.id}: ${output} (${generated.elapsedMs}ms)`);
}
await writeJson(path.join('runs', runId, 'summary.json'), { runId, results });
console.log('\nrunId=' + runId);