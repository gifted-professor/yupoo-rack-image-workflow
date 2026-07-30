#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

import { projectRoot, resolveProjectPath, writeJson } from './workflow-lib.mjs';

function parseArgs(argv) {
  const args = { snapshot: 'runs/full-20260722/discovery.json', output: 'runs/full-20260722/batches/full.json', limit: Infinity, skus: null, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === '--snapshot') args.snapshot = argv[++i];
    else if (value === '--output') args.output = argv[++i];
    else if (value === '--limit') args.limit = Number(argv[++i]);
    else if (value === '--skus') args.skus = new Set(String(argv[++i]).split(',').map(item => item.trim()).filter(Boolean));
    else if (value === '--dry-run') args.dryRun = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  return args;
}

function unique(values) { return [...new Set(values.filter(Boolean))]; }

function relativeOrAbsolute(value) {
  if (path.isAbsolute(value)) return value;
  return path.relative(projectRoot, resolveProjectPath(value));
}

function sceneBrand(brand) { return brand === 'jordan' ? 'nike' : brand; }

function chooseScene(scenes, brand, productType, tags = []) {
  const candidates = scenes.filter(scene => scene.brand === sceneBrand(brand));
  const ranked = candidates.sort((a, b) => {
    const score = scene => (Number(scene.priority || 0) * 100)
      + (tags.every(tag => scene.tags?.includes(tag)) ? 20 : 0)
      + (productType && scene.tags?.includes(productType) ? 15 : 0)
      + (scene.tags?.includes('close') ? 5 : 0);
    return score(b) - score(a);
  });
  return ranked[0] || scenes.find(scene => scene.brand === 'mixed') || scenes[0];
}

function observedDetails(audit, classification) {
  return unique([
    ...(audit?.evidence?.observed_details || []),
    ...(classification.facts?.features || []),
    ...(classification.facts?.colors || []),
  ]).slice(0, 16);
}

function promptFor({ sku, brand, productType, facts, details, view, partialBack }) {
  const product = `${facts.brand_display || brand} ${facts.gender?.join(' ') || ''} ${facts.category || productType} ${sku}`.trim();
  const detailLine = details.length ? `Observed product details to preserve exactly: ${details.join('; ')}.` : '';
  const partialLine = partialBack ? 'The rear reference is partial. Keep any unobserved lower/back construction hidden or naturally occluded; do not invent it.' : '';
  const viewLine = {
    front: 'Show the exact product FRONT-FACING on a black hanger in the store scene.',
    back: 'Show the exact product BACK-FACING on a black hanger. Only rear-panel details supported by the references may be visible.',
    tryon_main: 'Show an adult model naturally trying on the exact product in a retail-store mirror selfie, front or slight three-quarter view, with the phone covering the face.',
    tryon_detail: 'Show a close chest-to-hem retail-store mirror-selfie detail of an adult model wearing the exact product; keep the phone covering the face and preserve the product construction.',
    tryon_back: 'Show the exact product BACK panel on an adult model using the supplied back-pose reference; keep front-only graphics out of the rear view.',
  }[view];
  return [
    viewLine,
    `SKU: ${sku}. Product: ${product}. Product type: ${productType}.`,
    detailLine,
    partialLine,
    'Yupoo originals are the sole product source of truth. Preserve silhouette, color, fabric, logo, print, seams, pockets, neckline, sleeves, hem, stripes, and all visible details exactly.',
    view.startsWith('tryon_') ? 'The scene, model, pose, and lighting are presentation only; do not redesign or recolor the garment.' : 'Use the supplied store scene only for rack, hanger, lighting, and composition. The physical orange-and-black sign must remain blank.',
    'Do not add text overlays, prices, QR codes, extra logos, accessories, or unsupported product features.',
  ].filter(Boolean).join(' ');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const snapshot = JSON.parse(await fs.readFile(resolveProjectPath(args.snapshot), 'utf8'));
  const catalog = JSON.parse(await fs.readFile(resolveProjectPath('config/sku-catalog.json'), 'utf8'));
  const scenesConfig = JSON.parse(await fs.readFile(resolveProjectPath('config/store-scenes.json'), 'utf8'));
  const inScope = new Set((snapshot.products || []).filter(item => item.included).map(item => item.sku));
  const candidates = (catalog.items || [])
    .filter(item => inScope.has(item.sku) && item.state === 'READY_TO_GENERATE')
    .filter(item => !args.skus || args.skus.has(item.sku))
    .sort((a, b) => a.sku.localeCompare(b.sku));
  const selected = candidates.slice(0, Number.isFinite(args.limit) ? args.limit : undefined);
  const items = [];
  const errors = [];
  for (const entry of selected) {
    try {
      const sku = entry.sku;
      const itemRoot = resolveProjectPath(`work/items/${sku}`);
      const classification = JSON.parse(await fs.readFile(resolveProjectPath(`config/${sku}.classification.json`), 'utf8'));
      const manifest = JSON.parse(await fs.readFile(path.join(itemRoot, 'manifest.json'), 'utf8'));
      const packs = JSON.parse(await fs.readFile(path.join(itemRoot, 'reference-packs.json'), 'utf8'));
      const pricing = JSON.parse(await fs.readFile(path.join(itemRoot, 'pricing.json'), 'utf8'));
      const audit = JSON.parse(await fs.readFile(path.join(itemRoot, 'classification-audit.json'), 'utf8').catch(() => '{}'));
      if (pricing.status !== 'READY' || !Number.isFinite(Number(pricing.cost_price)) || Number(pricing.cost_price) <= 0) throw new Error('pricing is not confirmed');
      const byIndex = new Map(manifest.images.map(image => [image.index, image]));
      const color = byIndex.get(Number(classification.color_authority));
      if (!color) throw new Error('color_authority does not resolve to a manifest image');
      const frontRefs = unique([color.path, ...(packs.front.product_references || [])]).slice(0, 3).map(relativeOrAbsolute);
      const backRefs = unique([color.path, ...(packs.back.product_references || [])]).slice(0, 3).map(relativeOrAbsolute);
      if (!frontRefs.includes(relativeOrAbsolute(color.path)) || !backRefs.includes(relativeOrAbsolute(color.path))) throw new Error('color authority missing from product references');
      const brand = classification.brand;
      const productType = classification.product_type;
      const frontScene = chooseScene(scenesConfig.scenes, brand, productType, ['front']);
      const backScene = chooseScene(scenesConfig.scenes, brand, productType, ['back']);
      const tryonScene = chooseScene(scenesConfig.scenes, brand, productType, ['front', 'close']);
      const partialBack = (audit.evidence?.warnings || []).some(item => /BACK_VIEW_PARTIAL/i.test(item))
        || (classification.roles?.evidence_warnings || []).some(item => /BACK_VIEW_PARTIAL/i.test(item));
      const facts = classification.facts || {};
      const details = observedDetails(audit, classification);
      const common = { sku, brand, productType, facts, details, partialBack };
      items.push({
        enabled: true,
        sku,
        brand,
        product_type: productType,
        cost: Number(pricing.cost_price),
        category: facts.category || '服装',
        category_en: facts.gender?.some(value => String(value).includes('女')) ? 'Women' : 'Men',
        views: {
          front: {
            scene_reference: relativeOrAbsolute(frontScene.path),
            color_authority: relativeOrAbsolute(color.path),
            product_references: frontRefs,
            prompt: promptFor({ ...common, view: 'front' }),
          },
          back: {
            scene_reference: relativeOrAbsolute(backScene.path),
            color_authority: relativeOrAbsolute(color.path),
            product_references: backRefs,
            prompt: promptFor({ ...common, view: 'back' }),
          },
        },
        tryon_views: {
          tryon_main: {
            scene_reference: relativeOrAbsolute(tryonScene.path),
            color_authority: relativeOrAbsolute(color.path),
            product_references: frontRefs,
            prompt: promptFor({ ...common, view: 'tryon_main' }),
          },
          tryon_detail: {
            scene_reference: relativeOrAbsolute(tryonScene.path),
            color_authority: relativeOrAbsolute(color.path),
            product_references: frontRefs,
            prompt: promptFor({ ...common, view: 'tryon_detail' }),
          },
          tryon_back: {
            scene_reference: relativeOrAbsolute(tryonScene.path),
            pose_reference: relativeOrAbsolute('assets/store-scenes/25-mirror-assisted-back-pose.png'),
            composition: 'side_mirror_reflection',
            color_authority: relativeOrAbsolute(color.path),
            product_references: backRefs,
            prompt: promptFor({ ...common, view: 'tryon_back' }),
          },
        },
      });
    } catch (error) {
      errors.push({ sku: entry.sku, error: error?.message || String(error) });
    }
  }
  const batch = {
    version: 1,
    generated_at: new Date().toISOString(),
    settings: {
      concurrency: 4,
      bridge_url: 'http://127.0.0.1:8907/api/image/generate',
      max_reference_images: 5,
      prompt_rules: 'config/generation-prompt-rules.json',
      sign_reference: 'assets/price-sign-reference.png',
      output_canvas: { width: 1080, height: 1440 },
    },
    items,
  };
  const report = { ok: errors.length === 0, selected: selected.length, compiled: items.length, errors, output: path.relative(projectRoot, resolveProjectPath(args.output)) };
  if (!args.dryRun) await writeJson(args.output, batch);
  console.log(JSON.stringify({ report, batch: args.dryRun ? { items: items.length } : undefined }, null, 2));
  if (errors.length) process.exitCode = 1;
}

main().catch(error => { console.error(`错误: ${error.message}`); process.exit(1); });
