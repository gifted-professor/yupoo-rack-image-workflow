#!/usr/bin/env node
import fs from 'node:fs/promises';

import {
  projectRoot,
  readJson,
  resolveProjectPath,
  writeJson,
} from './workflow-lib.mjs';

function parseUploadArgs(argv) {
  const args = { dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--dry-run') args.dryRun = true;
    else if (value === '--batch') args.batch = argv[++index];
    else if (value === '--report') args.report = argv[++index];
    else throw new Error(`Unknown argument: ${value}`);
  }
  return args;
}

async function fileExists(value) {
  try {
    await fs.access(resolveProjectPath(value));
    return true;
  } catch {
    return false;
  }
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

const REQUIRED_GENERATED_VIEWS = [
  'front',
  'back',
  'tryon_main',
  'tryon_detail',
  'tryon_back',
];

async function inspectItem(item) {
  const publishPackage = await readJson(item.package);
  const review = await readJson(item.review);
  const approvals = new Map(
    (review.approvals || [])
      .filter(approval => approval.sku === item.sku)
      .map(approval => [approval.view, approval]),
  );
  const finalImages = publishPackage.final_images || {};
  const plannedGenerated = REQUIRED_GENERATED_VIEWS.map(view => {
    const approval = approvals.get(view);
    const finalPath = finalImages[view];
    return {
      view,
      path: finalPath || approval?.input || null,
      source: finalPath ? 'approved_final' : approval?.input ? 'review_preview_only' : 'missing',
      approval_status: approval?.status || 'MISSING',
    };
  });
  const plannedYupoo = (publishPackage.yupoo_images || []).map((image, index) => ({
    view: `yupoo_${index + 1}`,
    path: image,
    source: 'yupoo_original',
    approval_status: 'SOURCE_EVIDENCE',
  }));
  const imagePlan = [...plannedGenerated, ...plannedYupoo];
  const fileChecks = await Promise.all(imagePlan.map(async image => ({
    ...image,
    exists: image.path ? await fileExists(image.path) : false,
  })));
  const variants = publishPackage.variants || [];
  const variantKeys = variants.map(variant => `${variant.color}\u0000${variant.size}`);
  const validation = {
    target_is_szwego: publishPackage.publish_target === 'szwego',
    package_ready: publishPackage.status === 'READY_TO_PUBLISH',
    no_blockers: (publishPackage.blockers || []).length === 0,
    title_present: Boolean(publishPackage.title?.trim()),
    sku_present: Boolean(publishPackage.sku?.trim()),
    sale_price_positive: Number(publishPackage.sale_price) > 0,
    front_back_price_signs_rendered: publishPackage.price_display?.status === 'READY'
      && ['front', 'back'].every(view => publishPackage.price_display?.rendered_views?.includes(view))
      && Number(publishPackage.price_display?.sale_price) === Number(publishPackage.sale_price),
    tags_present: Array.isArray(publishPackage.tags) && publishPackage.tags.length > 0,
    variants_present: variants.length > 0,
    variants_unique: variantKeys.length === unique(variantKeys).length,
    variant_inventory_positive: variants.every(variant => Number(variant.inventory) > 0),
    shipping_configured: Number(publishPackage.shipping?.fee) >= 0
      && Boolean(publishPackage.shipping?.template_name),
    five_generated_views_present: plannedGenerated.every(image => image.path),
    five_generated_views_finalized: plannedGenerated.every(image => image.source === 'approved_final'),
    all_planned_images_exist: fileChecks.every(image => image.exists),
    human_final_action_preserved: publishPackage.final_action === 'HUMAN_CONFIRM_REQUIRED',
  };
  const failedChecks = Object.entries(validation)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  const totalInventory = variants.reduce(
    (total, variant) => total + Number(variant.inventory || 0),
    0,
  );
  return {
    sku: item.sku,
    package: item.package,
    review: item.review,
    dry_run_status: failedChecks.length ? 'DRY_RUN_BLOCKED' : 'DRY_RUN_READY',
    eligible_for_live_upload: failedChecks.length === 0,
    live_submit_attempted: false,
    external_writes: 0,
    blockers: publishPackage.blockers || [],
    failed_checks: failedChecks,
    validation,
    szwego_field_preview: {
      title: publishPackage.title,
      short_name: publishPackage.short_name,
      description: publishPackage.description,
      sku: publishPackage.sku,
      category: publishPackage.category,
      sale_price: publishPackage.sale_price,
      cost_price: publishPackage.cost_price,
      tags: publishPackage.tags,
      colors: publishPackage.colors,
      sizes: publishPackage.sizes,
      variants,
      total_inventory: totalInventory,
      shipping: publishPackage.shipping,
      image_count: fileChecks.length,
      image_plan: fileChecks,
    },
  };
}

const args = parseUploadArgs(process.argv.slice(2));
if (!args.batch || !args.dryRun) {
  throw new Error('Usage: node scripts/upload-szwego.mjs --batch <upload-batch.json> --dry-run [--report report.json]. Live upload is intentionally disabled.');
}
const batch = await readJson(args.batch);
if (batch.target !== 'szwego') throw new Error('Upload batch target must be szwego');
const results = [];
for (const item of batch.items || []) results.push(await inspectItem(item));
const report = {
  version: 1,
  mode: 'dry-run',
  target: 'szwego',
  publish_url: batch.publish_url || 'https://www.szwego.com/',
  project_root: projectRoot,
  live_submit_attempted: false,
  external_writes: 0,
  total: results.length,
  ready: results.filter(result => result.eligible_for_live_upload).length,
  blocked: results.filter(result => !result.eligible_for_live_upload).length,
  results,
};
if (args.report) await writeJson(args.report, report);
console.log(JSON.stringify(report, null, 2));
