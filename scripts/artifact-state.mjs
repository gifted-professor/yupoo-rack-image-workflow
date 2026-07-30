import fs from 'node:fs/promises';
import path from 'node:path';

export const REQUIRED_VIEWS = ['front', 'back', 'tryon_main', 'tryon_detail', 'tryon_back'];

export async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function safeJson(target, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(target, 'utf8'));
  } catch {
    return fallback;
  }
}

function resolveEvidencePath(projectRoot, value) {
  if (!value) return null;
  return path.isAbsolute(value) ? value : path.resolve(projectRoot, value);
}

async function originalsEvidence(projectRoot, itemRoot) {
  const manifestPath = path.join(itemRoot, 'manifest.json');
  const manifest = await safeJson(manifestPath);
  if (!manifest) return { ready: false, manifest: null, readable: 0, total: 0 };
  const images = manifest.images || [];
  let readable = 0;
  for (const image of images) {
    const target = resolveEvidencePath(projectRoot, image.path);
    if (target && await exists(target)) readable += 1;
  }
  return {
    ready: images.length > 0 && readable === images.length,
    manifest,
    readable,
    total: images.length,
    hash_complete: images.length > 0 && images.every(image => Boolean(image.sha256)),
  };
}

export async function collectLatestViews(projectRoot, sku) {
  const runsRoot = path.join(projectRoot, 'runs');
  const best = new Map();
  const runEntries = await fs.readdir(runsRoot, { withFileTypes: true }).catch(() => []);
  for (const runEntry of runEntries) {
    if (!runEntry.isDirectory()) continue;
    const reviewRoot = path.join(runsRoot, runEntry.name, 'review');
    const files = await fs.readdir(reviewRoot, { withFileTypes: true }).catch(() => []);
    for (const view of REQUIRED_VIEWS) {
      const prefix = `${sku}-${view}.`;
      const match = files.find(entry => entry.isFile() && entry.name.startsWith(prefix));
      if (!match) continue;
      const absolute = path.join(reviewRoot, match.name);
      const stat = await fs.stat(absolute);
      const current = best.get(view);
      if (current && current.mtime_ms >= stat.mtimeMs) continue;
      const response = path.join(runsRoot, runEntry.name, 'responses', `${sku}-${view}.json`);
      best.set(view, {
        view,
        run_id: runEntry.name,
        path: path.relative(projectRoot, absolute),
        mtime_ms: stat.mtimeMs,
        size: stat.size,
        response_path: await exists(response) ? path.relative(projectRoot, response) : null,
      });
    }
  }
  return Object.fromEntries(best);
}

async function classificationEvidence(projectRoot, itemRoot, sku) {
  const candidates = [
    path.join(itemRoot, 'confirmed-classification.json'),
    path.join(itemRoot, 'classification.json'),
    path.join(projectRoot, 'config', `${sku}.classification.json`),
  ];
  for (const candidate of candidates) {
    const value = await safeJson(candidate);
    if (value) return { ready: true, path: path.relative(projectRoot, candidate), value };
  }
  return { ready: false, path: null, value: null };
}

async function coverEvidence(projectRoot, itemRoot) {
  const output = path.join(itemRoot, 'xhs-cover', 'four-grid.jpg');
  const manifest = await safeJson(path.join(itemRoot, 'xhs-cover', 'manifest.json'));
  return {
    ready: await exists(output) && Boolean(manifest),
    path: await exists(output) ? path.relative(projectRoot, output) : null,
    manifest,
  };
}

async function pricePreviewEvidence(projectRoot, itemRoot) {
  const manifest = await safeJson(path.join(itemRoot, 'price-previews', 'manifest.json'));
  const readyViews = [];
  for (const view of ['front', 'back']) {
    const output = resolveEvidencePath(projectRoot, manifest?.views?.[view]?.output);
    if (output && await exists(output)) readyViews.push(view);
  }
  return { ready: readyViews.length === 2, ready_views: readyViews, manifest };
}

async function latestSignal(projectRoot, sku) {
  const root = path.join(projectRoot, 'work', 'approval-signals');
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const values = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.includes(`-${sku}-`) || !entry.name.endsWith('.json')) continue;
    const value = await safeJson(path.join(root, entry.name));
    if (value) values.push(value);
  }
  return values.sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)))[0] || null;
}

export async function inspectSkuArtifacts({ projectRoot, sku }) {
  const itemRoot = path.join(projectRoot, 'work', 'items', sku);
  const itemExists = await exists(itemRoot);
  const originals = itemExists ? await originalsEvidence(projectRoot, itemRoot) : { ready: false, total: 0, readable: 0 };
  const classification = await classificationEvidence(projectRoot, itemRoot, sku);
  const views = await collectLatestViews(projectRoot, sku);
  const availableViews = REQUIRED_VIEWS.filter(view => Boolean(views[view]));
  const missingViews = REQUIRED_VIEWS.filter(view => !views[view]);
  const pricePreviews = itemExists ? await pricePreviewEvidence(projectRoot, itemRoot) : { ready: false, ready_views: [] };
  const cover = itemExists ? await coverEvidence(projectRoot, itemRoot) : { ready: false, path: null };
  const signal = await latestSignal(projectRoot, sku);
  let state;
  let nextAction;
  if (signal?.decision === 'APPROVED') {
    state = signal.queue_state === 'QUEUED_FOR_DISPATCH' ? 'QUEUED' : 'APPROVED';
    nextAction = 'locked';
  } else if (!itemExists || !originals.ready) {
    state = 'INGEST_REQUIRED';
    nextAction = 'ingest';
  } else if (!classification.ready) {
    state = 'CONFIG_REQUIRED';
    nextAction = 'review_config';
  } else if (missingViews.length === REQUIRED_VIEWS.length) {
    state = 'READY_TO_GENERATE';
    nextAction = 'generate';
  } else if (missingViews.length) {
    state = 'PARTIAL_RESUME';
    nextAction = 'generate_missing_views';
  } else if (!pricePreviews.ready || !cover.ready) {
    state = 'COVER_REQUIRED';
    nextAction = pricePreviews.ready ? 'build_cover' : 'build_price_previews';
  } else {
    state = 'REVIEW_PENDING';
    nextAction = 'skip_generation_review';
  }
  return {
    sku,
    state,
    next_action: nextAction,
    missing_views: missingViews,
    available_views: availableViews,
    completed_stages: [
      originals.ready && 'ingest',
      classification.ready && 'config',
      availableViews.length === REQUIRED_VIEWS.length && 'generation',
      pricePreviews.ready && 'price_previews',
      cover.ready && 'cover',
    ].filter(Boolean),
    evidence: { item_exists: itemExists, originals, classification, views, price_previews: pricePreviews, cover, approval_signal: signal },
  };
}

export async function classifyItemArtifacts({ itemRoot, availableViews = [] }) {
  const manifestReady = await exists(path.join(itemRoot, 'manifest.json'));
  const classificationReady = await exists(path.join(itemRoot, 'classification.json'))
    || await exists(path.join(itemRoot, 'confirmed-classification.json'));
  const viewSet = new Set(availableViews);
  const missingViews = REQUIRED_VIEWS.filter(view => !viewSet.has(view));
  if (!manifestReady) return { state: 'INGEST_REQUIRED', missing_views: missingViews, completed_stages: [] };
  if (!classificationReady) return { state: 'CONFIG_REQUIRED', missing_views: missingViews, completed_stages: ['ingest'] };
  if (missingViews.length === REQUIRED_VIEWS.length) return { state: 'READY_TO_GENERATE', missing_views: missingViews, completed_stages: ['ingest', 'config'] };
  if (missingViews.length) return { state: 'PARTIAL_RESUME', missing_views: missingViews, completed_stages: ['ingest', 'config', 'generation_partial'] };
  return { state: 'REVIEW_PENDING', missing_views: [], completed_stages: ['ingest', 'config', 'generation'] };
}
