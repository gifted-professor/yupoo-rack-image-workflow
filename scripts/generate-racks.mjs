#!/usr/bin/env node
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  assertReadable,
  callImageBridge,
  checkImageBridge,
  extensionFor,
  loadLocalEnv,
  makeRunId,
  parseArgs,
  projectRoot,
  readJson,
  resolveProjectPath,
  resolvePythonRuntime,
  runPool,
  saveGeneratedImage,
  writeJson,
} from './workflow-lib.mjs';

const execFileAsync = promisify(execFile);

await loadLocalEnv();

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function compilePrompt(rules, item, viewName, view, outputCanvas) {
  const isTryon = viewName.startsWith('tryon_');
  const isTryonBack = viewName === 'tryon_back';
  const modeRules = isTryonBack
    ? (rules.tryon_back_required_rules || rules.tryon_required_rules || [])
    : isTryon
      ? (rules.tryon_required_rules || [])
    : rules.required_rules;
  const directionRule = {
    front: 'The hero garment must be front-facing.',
    back: 'The hero garment must show its BACK panel to the camera — the side that lies against the wearer\'s back, opposite the chest. The front/chest is NOT visible in this photo. Any graphic, print, mesh, or stripes described in the prompt are printed on this BACK panel, not on the chest. Do not reuse or mirror the front view.',
    tryon_main: 'Show a natural front or slight three-quarter in-store mirror-selfie try-on view, framed from head or shoulders to below the garment hem; the model holds the phone up covering the face so it is not identifiable. Only the FRONT chest content is visible; any large back graphic is NOT visible from this front angle — do not migrate it onto the chest.',
    tryon_detail: 'Show a closer in-store mirror-selfie detail view that clearly reveals the garment fit, fabric, logo, neckline, sleeves, and hem; the phone still covers the face. Only the FRONT chest content is visible; any large back graphic is NOT visible from this front angle.',
    tryon_back: 'The BACK panel — including any back graphic, mesh, yoke, vent, reflective marks, stripes, pockets, or seams — must be fully visible and the front chest content must not migrate onto it. Frame from shoulders to below the garment hem.',
  }[viewName];
  const backCompositionRule = viewName === 'tryon_back'
    ? view.composition === 'side_mirror_reflection'
      ? 'Use a physically plausible two-mirror composition: the camera photographs the foreground selfie in the main mirror while one angled full-length side mirror clearly shows the same model from behind at the exact same instant. The phone-holding arm is raised in both views, with the corresponding bent elbow visible in the back reflection. Preserve the true front chest content on the foreground garment and the true back content only in the back reflection. The reflection must be large, unobstructed, anatomically coherent, and faithful to the product references.'
      : 'Use the companion-captured rear composition: another person takes the photo from behind while the model naturally faces away with relaxed arms. No phone is visible on or near the model, and no mirror is required.'
    : null;
  return [
    ...modeRules,
    `SKU: ${item.sku}. Brand: ${item.brand}. Product type: ${item.product_type}.`,
    `The sole color-authority reference is: ${view.color_authority}.`,
    view.pose_reference
      ? `The pose/composition-only reference is: ${view.pose_reference}. It controls only body, mirror, and camera placement; copy none of its garment details, colors, logos, text, or graphics.`
      : null,
    view.prompt,
    backCompositionRule,
    directionRule,
    `Compose specifically for a portrait ${outputCanvas.width}:${outputCanvas.height} final canvas (width:height = 3:4). Keep the entire hero garment, physical price sign, hanger/rack, model pose, hands, phone, and footwear where applicable inside the central safe area with comfortable space on all four sides. Do not crop any critical product detail at the top, bottom, left, or right edge.`,
  ].filter(Boolean).join('\n');
}

function expandJobs(batch, rules) {
  const maxReferences = Number(batch.settings?.max_reference_images || 5);
  const signReference = batch.settings?.sign_reference;
  const outputCanvas = batch.settings?.output_canvas || { width: 1080, height: 1440 };
  if (Number(outputCanvas.width) !== 1080 || Number(outputCanvas.height) !== 1440) {
    throw new Error('output_canvas must be the production 1080x1440 portrait 3:4 standard');
  }
  const jobs = [];
  for (const item of batch.items || []) {
    const configuredViews = {
      front: item.views?.front,
      back: item.views?.back,
      tryon_main: item.tryon_views?.tryon_main,
      tryon_detail: item.tryon_views?.tryon_detail,
      tryon_back: item.tryon_views?.tryon_back,
    };
    for (const requiredView of ['front', 'back']) {
      if (!configuredViews[requiredView]) {
        throw new Error(`${item.sku}: missing ${requiredView} view configuration`);
      }
    }
    const hasAnyTryon = Boolean(configuredViews.tryon_main || configuredViews.tryon_detail);
    if (
      hasAnyTryon
      && !Array.isArray(item.enabled_views)
      && !(configuredViews.tryon_main && configuredViews.tryon_detail)
    ) {
      throw new Error(`${item.sku}: tryon_main and tryon_detail must be configured together`);
    }
    for (const [viewName, view] of Object.entries(configuredViews)) {
      if (!view) continue;
      const mode = viewName.startsWith('tryon_') ? 'tryon' : 'rack';
      const references = unique([
        view.scene_reference,
        view.pose_reference,
        mode === 'rack' ? signReference : null,
        ...(view.product_references || []),
      ]);
      if (!view.color_authority || !(view.product_references || []).includes(view.color_authority)) {
        throw new Error(`${item.sku}/${viewName}: color_authority must be included in product_references`);
      }
      if (references.length > maxReferences) {
        throw new Error(`${item.sku}/${viewName}: ${references.length} references exceed limit ${maxReferences}`);
      }
      jobs.push({
        id: `${item.sku}-${viewName}`,
        sku: item.sku,
        enabled: item.enabled !== false && (
          !Array.isArray(item.enabled_views) || item.enabled_views.includes(viewName)
        ),
        view: viewName,
        mode,
        cost: item.cost,
        category: item.category,
        categoryEn: item.category_en,
        references,
        prompt: compilePrompt(rules, item, viewName, view, outputCanvas),
        outputCanvas,
      });
    }
  }
  return jobs;
}

async function validateJobs(jobs) {
  for (const job of jobs) {
    for (const reference of job.references) await assertReadable(reference, `${job.id} reference`);
    if (!job.prompt.trim()) throw new Error(`${job.id}: prompt is empty`);
    if (!Number.isFinite(Number(job.cost)) || Number(job.cost) <= 0) {
      throw new Error(`${job.id}: cost must be a positive confirmed number`);
    }
  }
}

const args = parseArgs(process.argv.slice(2));
if (!args.batch) throw new Error('Usage: node scripts/generate-racks.mjs --batch <batch.json> [--run-id id] [--dry-run]');

const batch = await readJson(args.batch);
const rules = await readJson(batch.settings?.prompt_rules || 'config/generation-prompt-rules.json');
const jobs = expandJobs(batch, rules);
await validateJobs(jobs);

if (args.dryRun) {
  console.log(JSON.stringify({
    ok: true,
    mode: 'dry-run',
    projectRoot,
    configuredJobs: jobs.length,
    enabledJobs: jobs.filter(job => job.enabled).length,
    referenceLimit: batch.settings?.max_reference_images || 5,
  }, null, 2));
  process.exit(0);
}

const activeJobs = jobs.filter(job => job.enabled);
if (!activeJobs.length) throw new Error('No enabled jobs. Set item.enabled=true in the batch file.');
const runId = args.runId || makeRunId('rack');
const runDir = resolveProjectPath(path.join('runs', runId));
const bridgeUrl = process.env.IMAGE_BRIDGE_URL || batch.settings?.bridge_url || 'http://127.0.0.1:8907/api/image/generate';
const concurrency = Number(batch.settings?.concurrency || 4);
const bridgeConfig = await checkImageBridge(bridgeUrl);
const started = Date.now();

const results = await runPool(activeJobs, concurrency, async job => {
  const isTryon = job.mode === 'tryon';
  const generated = await callImageBridge({
    bridgeUrl,
    prompt: job.prompt,
    type: isTryon ? '商品实体店试穿上身图' : '商品正反面实体货架图',
    references: job.references,
    sku: job.sku,
    verifiedFacts: isTryon ? [
      'Yupoo product images are the source of truth.',
      'The designated image is the sole color authority.',
      'The generated adult model and store scene are presentation only and must not change the garment.',
    ] : [
      'Yupoo product images are the source of truth.',
      'The designated image is the sole color authority.',
      'The physical orange-and-black sign must remain completely blank.',
    ],
  });
  const extension = extensionFor(generated.mime);
  const relativeOutput = path.join('runs', runId, 'review', `${job.id}.${extension}`);
  const output = await saveGeneratedImage(relativeOutput, generated);
  const python = await resolvePythonRuntime();
  const workflow = resolveProjectPath('src/product_image_workflow.py');
  const { stdout: canvasStdout } = await execFileAsync(python, [
    workflow,
    'normalize-canvas',
    '--input', output,
    '--output', output,
    '--width', String(job.outputCanvas.width),
    '--height', String(job.outputCanvas.height),
  ], { cwd: projectRoot, maxBuffer: 2 * 1024 * 1024 });
  const canvas = JSON.parse(canvasStdout);
  await writeJson(path.join('runs', runId, 'responses', `${job.id}.json`), {
    ...generated.body,
    imageDataUrl: '[removed: saved as image file]',
    imageDataUrls: '[removed: saved as image file]',
    localMeta: { elapsedMs: generated.elapsedMs, references: job.references, output, canvas },
  });
  return {
    ok: true,
    id: job.id,
    sku: job.sku,
    view: job.view,
    mode: job.mode,
    cost: job.cost,
    category: job.category,
    category_en: job.categoryEn,
    elapsedMs: generated.elapsedMs,
    model: generated.body.model,
    responsesModel: generated.body.responsesModel,
    output,
    canvas,
    status: 'REVIEW_PENDING',
  };
});

const summary = {
  runId,
  route: `${bridgeUrl} -> CPA :8317 -> gpt-image-2`,
  bridgeConfig,
  concurrency,
  elapsedMs: Date.now() - started,
  total: results.length,
  succeeded: results.filter(result => result.ok).length,
  failed: results.filter(result => !result.ok).length,
  results,
};
await writeJson(path.join('runs', runId, 'summary.json'), summary);
await writeJson(path.join('runs', runId, 'review.json'), {
  version: 1,
  runId,
  instructions: '货架图通过后改为 APPROVED_FOR_PRICE；试穿图通过后改为 APPROVED_FOR_PUBLISH；不合格统一改为 REPAIR_REQUIRED。',
  qaChecks: {
    rack: rules.qa_gate?.checks || [],
    tryon: rules.tryon_qa_gate?.checks || [],
  },
  approvals: results.filter(result => result.ok).map(result => ({
    sku: result.sku,
    view: result.view,
    mode: result.mode,
    status: 'REVIEW_PENDING',
    input: path.relative(projectRoot, result.output),
    output: result.mode === 'tryon'
      ? `outputs/${result.sku}-${result.view}.jpg`
      : `outputs/${result.sku}-${result.view}-sale.jpg`,
    finalization: result.mode === 'tryon' ? 'publish_copy' : 'price_badge',
    cost: result.cost,
    category: result.category,
    category_en: result.category_en,
    notes: '',
  })),
});
console.log(JSON.stringify(summary, null, 2));
if (summary.failed > 0) process.exitCode = 1;
