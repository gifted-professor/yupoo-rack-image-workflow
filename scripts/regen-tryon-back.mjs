#!/usr/bin/env node
// Generate ONLY the tryon_back view for every SKU across the known batches.
// Mirrors generate-racks.mjs compilePrompt + callImageBridge for tryon mode.
// Does NOT touch existing front/back/tryon_main/tryon_detail images.
import path from 'node:path';
import {
  loadLocalEnv, readJson, callImageBridge, saveGeneratedImage, writeJson,
  makeRunId, runPool, extensionFor, projectRoot,
} from './workflow-lib.mjs';

await loadLocalEnv();

const BATCHES = [
  'config/IX1577-274.batch.json',
  'config/HM9699-897.batch.json',
  'config/adidas666888-top3.batch.json',
  'config/adidas666888-next10-20260720.batch.json',
  'config/adidas-nodash-test3-20260721.batch.json',
];

function parseCli(argv) {
  const args = {
    batches: BATCHES,
    sku: null,
    excludeSkus: new Set(),
    runId: null,
    mirror: false,
    dryRun: false,
  };
  let customBatches = false;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--batch') {
      if (!customBatches) args.batches = [];
      customBatches = true;
      args.batches.push(argv[++index]);
    }
    else if (value === '--sku') args.sku = argv[++index];
    else if (value === '--exclude-sku') args.excludeSkus.add(argv[++index]);
    else if (value === '--run-id') args.runId = argv[++index];
    else if (value === '--mirror') args.mirror = true;
    else if (value === '--dry-run') args.dryRun = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  return args;
}

const args = parseCli(process.argv.slice(2));
const directionRule = 'The BACK panel — including any back graphic, mesh, yoke, vent, reflective marks, stripes, pockets, or seams — must be fully visible and the front chest content must not migrate onto it. Frame from shoulders to below the garment hem.';
const defaultMirrorPose = 'assets/store-scenes/25-mirror-assisted-back-pose.png';

const jobs = [];
const seenSkus = new Set();
for (const batchPath of args.batches) {
  const batch = await readJson(batchPath);
  const rules = await readJson(batch.settings.prompt_rules);
  const bridgeUrl = process.env.IMAGE_BRIDGE_URL || batch.settings.bridge_url;
  for (const item of batch.items || []) {
    if (item.enabled === false) continue;
    if (args.sku && item.sku !== args.sku) continue;
    if (args.excludeSkus.has(item.sku) || seenSkus.has(item.sku)) continue;
    const view = item.tryon_views?.tryon_back;
    if (!view) continue;
    seenSkus.add(item.sku);
    const mirrorMode = args.mirror || view.composition === 'side_mirror_reflection';
    const poseReference = mirrorMode ? (view.pose_reference || defaultMirrorPose) : view.pose_reference;
    const backReferences = [...new Set([
      view.color_authority,
      ...(view.product_references || []),
    ].filter(Boolean))];
    const frontView = item.views?.front || item.tryon_views?.tryon_main;
    const frontReferences = [...new Set([
      frontView?.color_authority,
      ...(frontView?.product_references || []),
    ].filter(Boolean))];
    const selectedBackReferences = backReferences.slice(0, 2);
    const selectedFrontReference = frontReferences.find(reference => !selectedBackReferences.includes(reference))
      || frontReferences[0];
    const references = [...new Set((mirrorMode ? [
      poseReference,
      view.scene_reference,
      ...selectedBackReferences,
      selectedFrontReference,
    ] : [
      view.scene_reference,
      poseReference,
      ...backReferences,
    ]).filter(Boolean))].slice(0, batch.settings.max_reference_images || 5);
    const compositionRule = mirrorMode
      ? 'Use a physically plausible two-mirror composition: the camera photographs the foreground selfie in the main mirror while one angled full-length side mirror clearly shows the same model from behind at the exact same instant. The phone-holding arm is raised in both views, with the corresponding bent elbow visible in the back reflection. Preserve the true front-facing garment content in the foreground and the true back content only in the back reflection. The reflection must be large, unobstructed, anatomically coherent, and faithful to the product references.'
      : 'Use the companion-captured rear composition: another person takes the photo from behind while the model naturally faces away with relaxed arms. No phone is visible on or near the model, and no mirror is required.';
    const lowerBodyStylingRule = mirrorMode && ['shorts', 'pants'].includes(item.product_type)
      ? 'This is a lower-body product. The model must wear the same plain solid-color short-sleeve T-shirt in the foreground and back reflection. No jacket, outerwear, bold stripes, large swoosh, or graphic top is allowed, and no garment may be copied from the pose reference.'
      : null;
    const prompt = [
      ...(rules.tryon_back_required_rules || rules.tryon_required_rules || []),
      `SKU: ${item.sku}. Brand: ${item.brand}. Product type: ${item.product_type}.`,
      `The sole color-authority reference is: ${view.color_authority}.`,
      poseReference
        ? `The pose/composition-only reference is: ${poseReference}. It controls only body, mirror, and camera placement; copy none of its garment details, colors, logos, text, or graphics.`
        : null,
      view.prompt,
      lowerBodyStylingRule,
      mirrorMode && selectedFrontReference
        ? `The foreground front-facing garment content must follow this front product reference: ${selectedFrontReference}. Do not leave its real front logos, graphics, panels, pockets, stripes, or construction blank.`
        : null,
      mirrorMode
        ? `The mirror-visible back must follow only these back product references: ${selectedBackReferences.join(', ')}. Do not move front details onto the back or back details onto the front.`
        : null,
      mirrorMode
        ? 'The foreground and reflection are the same person wearing the exact same complete outfit at the exact same instant. Do not change, add, or remove any garment between the two views.'
        : null,
      compositionRule,
      directionRule,
    ].filter(Boolean).join('\n');
    jobs.push({
      id: `${item.sku}-tryon_back`,
      sku: item.sku,
      bridgeUrl,
      references,
      prompt,
      cost: item.cost,
      category: item.category,
      categoryEn: item.category_en,
      mirrorMode,
    });
  }
}

console.log(`tryon_back jobs: ${jobs.length}`);
if (!jobs.length) throw new Error('No matching tryon_back jobs');

if (args.dryRun) {
  console.log(JSON.stringify({
    ok: true,
    jobs: jobs.map(job => ({
      id: job.id,
      mirrorMode: job.mirrorMode,
      referenceCount: job.references.length,
      references: job.references,
    })),
  }, null, 2));
  process.exit(0);
}

const runId = args.runId || makeRunId('tryon-back');
const results = await runPool(jobs, 4, async job => {
  const generated = await callImageBridge({
    bridgeUrl: job.bridgeUrl,
    prompt: job.prompt,
    type: '商品实体店试穿上身图',
    references: job.references,
    sku: job.sku,
    verifiedFacts: [
      'Yupoo product images are the source of truth.',
      'The designated image is the sole color authority.',
      'The generated adult model and store scene are presentation only and must not change the garment.',
    ],
  });
  const ext = extensionFor(generated.mime);
  const rel = path.join('runs', runId, 'review', `${job.id}.${ext}`);
  const output = await saveGeneratedImage(rel, generated);
  console.log(`${job.id}: ${output} (${generated.elapsedMs}ms)`);
  return {
    ok: true,
    id: job.id,
    sku: job.sku,
    output,
    elapsedMs: generated.elapsedMs,
    status: 'REVIEW_PENDING',
    cost: job.cost,
    category: job.category,
    category_en: job.categoryEn,
  };
});

await writeJson(path.join('runs', runId, 'summary.json'), { runId, total: results.length, results });
await writeJson(path.join('runs', runId, 'review.json'), {
  version: 1,
  runId,
  instructions: '背面试穿通过后改为 APPROVED_FOR_PUBLISH；不合格改为 REPAIR_REQUIRED。',
  qaChecks: {
    tryon: [
      '商品颜色、后背图案和结构与商品参考一致',
      '使用同行者后方直拍，或前景自拍加侧边镜中完整背影',
      '没有手机贴后脑、手臂绕后、重复人物或镜像动作不一致',
      '镜面构图中前景正面图案与镜中后背图案均正确，举手机手臂在两处姿势一致',
      '没有从姿势参考图复制衣物、Logo、文字、图案或配色',
    ],
  },
  approvals: results.filter(result => result.ok).map(result => ({
    sku: result.sku,
    view: 'tryon_back',
    mode: 'tryon',
    status: 'REVIEW_PENDING',
    input: path.relative(projectRoot, result.output),
    output: `outputs/${result.sku}-tryon_back.jpg`,
    finalization: 'publish_copy',
    cost: result.cost,
    category: result.category,
    category_en: result.category_en,
    notes: '',
  })),
});
console.log(`\nrunId=${runId}  ok=${results.filter(r => r.ok).length}/${results.length}`);
