#!/usr/bin/env node
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';

import { projectRoot, readJson, resolveProjectPath, resolvePythonRuntime } from './workflow-lib.mjs';

const execFileAsync = promisify(execFile);

const REQUIRED_VIEWS = ['front', 'back', 'tryon_main', 'tryon_detail', 'tryon_back'];
const REVIEW_RESOLVABLE_BLOCKERS = new Set([
  'FACTS_NOT_MANUALLY_VERIFIED',
  'FRONT_IMAGE_NOT_APPROVED',
  'BACK_IMAGE_NOT_APPROVED',
  'TRYON_MAIN_IMAGE_NOT_APPROVED',
  'TRYON_DETAIL_IMAGE_NOT_APPROVED',
  'TRYON_BACK_IMAGE_NOT_APPROVED',
]);
const MEDIA_ROOTS = ['runs', 'work/items', 'outputs'].map(value => resolveProjectPath(value));
const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};
let pricePreviewRefresh = null;

async function refreshPricePreviews(args) {
  if (pricePreviewRefresh) return pricePreviewRefresh;
  const previewHost = ['0.0.0.0', '::'].includes(args.host) ? '127.0.0.1' : args.host;
  pricePreviewRefresh = execFileAsync(process.execPath, [
    resolveProjectPath('scripts/build-price-previews.mjs'),
    '--base-url', `http://${previewHost}:${args.port}`,
    '--concurrency', '4',
  ], { cwd: projectRoot, maxBuffer: 16 * 1024 * 1024 })
    .then(({ stdout }) => {
      const report = JSON.parse(stdout);
      console.log(`Price previews ready: ${report.total - report.failed}/${report.total} (${report.generated} generated, ${report.cached} cached)`);
      return report;
    })
    .catch(error => {
      console.error(`Price preview refresh failed: ${error?.message || error}`);
      return null;
    })
    .finally(() => {
      pricePreviewRefresh = null;
    });
  return pricePreviewRefresh;
}

function parseArgs(argv) {
  const args = { host: '127.0.0.1', port: 8910 };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--host') args.host = argv[++index];
    else if (value === '--port') args.port = Number(argv[++index]);
    else throw new Error(`Unknown argument: ${value}`);
  }
  return args;
}

async function exists(target) {
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

function json(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(`${JSON.stringify(body, null, 2)}\n`);
}

function cleanRelative(target) {
  return path.relative(projectRoot, target).split(path.sep).join('/');
}

function mediaUrl(relativePath) {
  return relativePath ? `/media?path=${encodeURIComponent(relativePath)}` : null;
}

async function latestSignal(sku) {
  const directory = resolveProjectPath('work/approval-signals');
  if (!(await exists(directory))) return null;
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const matching = entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.json') && entry.name.includes(`-${sku}-`))
    .map(entry => path.join(directory, entry.name));
  const signals = (await Promise.all(matching.map(file => safeJson(file)))).filter(Boolean);
  return signals.sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)))[0] || null;
}

async function collectLatestImages(sku) {
  const runsRoot = resolveProjectPath('runs');
  const best = new Map();
  const runEntries = await fs.readdir(runsRoot, { withFileTypes: true }).catch(() => []);
  for (const runEntry of runEntries) {
    if (!runEntry.isDirectory()) continue;
    const runRoot = path.join(runsRoot, runEntry.name);
    const reviewRoot = path.join(runRoot, 'review');
    if (!(await exists(reviewRoot))) continue;
    const review = await safeJson(path.join(runRoot, 'review.json'), { approvals: [] });
    const files = await fs.readdir(reviewRoot, { withFileTypes: true });
    for (const view of REQUIRED_VIEWS) {
      const prefix = `${sku}-${view}.`;
      const match = files.find(entry => entry.isFile() && entry.name.startsWith(prefix));
      if (!match) continue;
      const absolute = path.join(reviewRoot, match.name);
      const stat = await fs.stat(absolute);
      const current = best.get(view);
      if (current && current.mtime_ms >= stat.mtimeMs) continue;
      const approval = (review.approvals || []).find(item => item.sku === sku && item.view === view);
      best.set(view, {
        view,
        run_id: runEntry.name,
        relative_path: cleanRelative(absolute),
        url: mediaUrl(cleanRelative(absolute)),
        approval_status: approval?.status || 'REVIEW_PENDING',
        mtime_ms: stat.mtimeMs,
      });
    }
  }
  return REQUIRED_VIEWS.map(view => best.get(view) || {
    view,
    run_id: null,
    relative_path: null,
    url: null,
    approval_status: 'MISSING',
    mtime_ms: 0,
  });
}

async function loadPackage(itemRoot) {
  const candidates = [
    path.join(itemRoot, 'publish-package.json'),
    path.join(itemRoot, 'publish-package-dryrun.json'),
  ];
  const available = [];
  for (const candidate of candidates) {
    if (await exists(candidate)) available.push({ candidate, stat: await fs.stat(candidate) });
  }
  available.sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs);
  return available.length ? safeJson(available[0].candidate) : null;
}

async function loadProduct(sku, destinations) {
  const itemRoot = resolveProjectPath(path.join('work/items', sku));
  const draft = await safeJson(path.join(itemRoot, 'publish-draft.json'), {});
  const facts = await safeJson(path.join(itemRoot, 'product-facts.json'), {});
  const manifest = await safeJson(path.join(itemRoot, 'manifest.json'), { images: [] });
  const publishPackage = await loadPackage(itemRoot);
  const reviewImages = await collectLatestImages(sku);
  const pricePreviewManifest = await safeJson(path.join(itemRoot, 'price-previews', 'manifest.json'), {});
  const signal = await latestSignal(sku);

  // Load XHS cover
  const xhsCoverPath = path.join(itemRoot, 'xhs-cover', 'four-grid.jpg');
  const xhsCoverManifest = await safeJson(path.join(itemRoot, 'xhs-cover', 'manifest.json'), {});
  const xhsCoverExists = await exists(xhsCoverPath);
  const xhsCover = xhsCoverExists ? {
    relative_path: cleanRelative(xhsCoverPath),
    url: mediaUrl(cleanRelative(xhsCoverPath)),
    status: xhsCoverManifest.status || 'REVIEW_PENDING',
    layout: xhsCoverManifest.layout || [],
    generated_at: xhsCoverManifest.generated_at || null,
  } : null;
  const blockers = draft.blockers || [];
  const unresolvedBlockers = blockers.filter(blocker => !REVIEW_RESOLVABLE_BLOCKERS.has(blocker));
  const variants = draft.variants || [];
  const fieldsReady = Boolean(draft.title)
    && Number(draft.sale_price) > 0
    && variants.length > 0
    && Boolean(draft.shipping?.template_name);
  const imagesReady = reviewImages.every(image => image.relative_path);
  const priceDisplay = publishPackage?.price_display || {
    status: 'PENDING',
    sale_price: draft.sale_price ?? null,
    required_views: ['front', 'back'],
    rendered_views: [],
  };
  const finalImages = publishPackage?.final_images || {};
  const finalImageDetails = new Map();
  for (const [view, value] of Object.entries(finalImages)) {
    const absolute = resolveProjectPath(value);
    if (!(await exists(absolute))) continue;
    const relative = cleanRelative(absolute);
    finalImageDetails.set(view, {
      final_relative_path: relative,
      final_url: mediaUrl(relative),
    });
  }
  const pricePreviewDetails = new Map();
  for (const view of ['front', 'back']) {
    const preview = pricePreviewManifest.views?.[view];
    const reviewImage = reviewImages.find(image => image.view === view);
    if (!preview
      || preview.source !== reviewImage?.relative_path
      || Number(preview.sale_price) !== Number(draft.sale_price)) continue;
    const absolute = resolveProjectPath(preview.output);
    if (!(await exists(absolute))) continue;
    const relative = cleanRelative(absolute);
    pricePreviewDetails.set(view, {
      price_preview_relative_path: relative,
      price_preview_url: mediaUrl(relative),
    });
  }
  const images = reviewImages.map(image => ({
    ...image,
    ...(finalImageDetails.get(image.view) || {}),
    ...(pricePreviewDetails.get(image.view) || {}),
    display_url: signal?.decision === 'APPROVED' && finalImageDetails.has(image.view)
      ? finalImageDetails.get(image.view).final_url
      : pricePreviewDetails.get(image.view)?.price_preview_url || image.url,
  }));
  const revision = crypto.createHash('sha256').update(JSON.stringify({
    draft,
    image_versions: reviewImages.map(image => [image.relative_path, image.mtime_ms]),
  })).digest('hex').slice(0, 16);
  const destinationStates = Object.entries(destinations).map(([id, destination]) => ({
    id,
    ...destination,
    state: signal?.destination === id
      ? signal.queue_state
      : id === 'szwego'
        ? publishPackage?.status || draft.status || 'DRAFT_REVIEW'
        : 'PLANNED',
  }));
  const originalImages = (manifest.images || []).map((image, index) => ({
    index: index + 1,
    relative_path: image.path,
    url: mediaUrl(image.path),
  }));
  return {
    sku,
    revision,
    brand: facts.brand || null,
    category: draft.category || facts.category || '未分类',
    title: draft.title || sku,
    short_name: draft.short_name || sku,
    description: draft.description || '',
    status: draft.status || 'INCOMPLETE',
    blockers,
    unresolved_blockers: unresolvedBlockers,
    can_approve: fieldsReady && imagesReady && unresolvedBlockers.length === 0,
    facts_ready: fieldsReady,
    images_ready: imagesReady,
    cost_price: draft.cost_price ?? null,
    sale_price: draft.sale_price ?? null,
    price_display: priceDisplay,
    price_image_ready: priceDisplay.status === 'READY'
      && ['front', 'back'].every(view => priceDisplay.rendered_views?.includes(view))
      && Number(priceDisplay.sale_price) === Number(draft.sale_price),
    price_preview_ready: ['front', 'back'].every(view => pricePreviewDetails.has(view)),
    colors: draft.colors || [],
    sizes: draft.sizes || [],
    tags: draft.tags || [],
    variants,
    inventory_total: variants.reduce((total, variant) => total + Number(variant.inventory || 0), 0),
    shipping: draft.shipping || null,
    images,
    original_images: originalImages,
    destinations: destinationStates,
    latest_signal: signal,
    thumbnail: xhsCover?.url || images.find(image => image.view === 'front')?.display_url || originalImages[0]?.url || null,
    xhs_cover: xhsCover,
  };
}

async function listProducts() {
  const destinationsConfig = await readJson('config/destinations.json');
  const itemsRoot = resolveProjectPath('work/items');
  const entries = await fs.readdir(itemsRoot, { withFileTypes: true });
  const skus = entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).map(entry => entry.name).sort();
  const products = await Promise.all(skus.map(sku => loadProduct(sku, destinationsConfig.destinations)));
  return { products, destinations: destinationsConfig.destinations };
}

async function readBody(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 64 * 1024) throw new Error('REQUEST_TOO_LARGE');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

async function writeAtomic(target, value) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  await fs.rename(temporary, target);
}

function categoryEnglish(category) {
  return String(category || '').includes('女') ? 'Women' : 'Men';
}

async function materializePublishPackage(product) {
  if (!(Number(product.sale_price) > 0) || !(Number(product.cost_price) > 0)) {
    throw new Error('PRICE_NOT_CONFIRMED');
  }
  const missing = product.images.filter(image => !image.relative_path).map(image => image.view);
  if (missing.length) throw new Error(`FINAL_IMAGE_SOURCE_MISSING:${missing.join(',')}`);

  const itemRoot = resolveProjectPath(path.join('work/items', product.sku));
  const approvedReviewPath = path.join(itemRoot, 'approved-review.json');
  const finalizeSummaryPath = path.join(itemRoot, 'finalize-summary.json');
  const publishPackagePath = path.join(itemRoot, 'publish-package.json');
  const approvals = product.images.map(image => {
    const rackView = image.view === 'front' || image.view === 'back';
    return {
      sku: product.sku,
      view: image.view,
      mode: rackView ? 'rack' : 'tryon',
      status: rackView ? 'APPROVED_FOR_PRICE' : 'APPROVED_FOR_PUBLISH',
      input: image.relative_path,
      output: rackView
        ? `outputs/${product.sku}-${image.view}-sale.jpg`
        : `outputs/${product.sku}-${image.view}.jpg`,
      finalization: rackView ? 'price_badge' : 'publish_copy',
      cost: product.cost_price,
      category: product.category || '服装',
      category_en: categoryEnglish(product.category),
      notes: '由最终人工确认信号批准；货架正反面必须写入真实销售价后才能入队。',
    };
  });
  await writeAtomic(approvedReviewPath, {
    version: 1,
    sku: product.sku,
    revision: product.revision,
    created_at: new Date().toISOString(),
    instructions: '最终确认快照；正反货架图写价，三张试穿图原样复制。',
    approvals,
  });

  const python = await resolvePythonRuntime();
  const workflow = resolveProjectPath('src/product_image_workflow.py');
  await execFileAsync(python, [
    workflow,
    'finalize-batch',
    '--review', approvedReviewPath,
    '--pricing', resolveProjectPath('config/pricing.json'),
    '--project-root', projectRoot,
    '--report', finalizeSummaryPath,
  ], { cwd: projectRoot, maxBuffer: 4 * 1024 * 1024 });
  const summary = await safeJson(finalizeSummaryPath, {});
  const finalizedViews = new Set(
    (summary.results || []).filter(item => item.finalized === true).map(item => item.view),
  );
  if (!REQUIRED_VIEWS.every(view => finalizedViews.has(view))) {
    const held = (summary.results || []).filter(item => !item.finalized);
    throw new Error(`FINALIZATION_FAILED:${JSON.stringify(held)}`);
  }

  await execFileAsync(python, [
    workflow,
    'prepare-publish',
    '--draft', path.join(itemRoot, 'publish-draft.json'),
    '--finalize-summary', finalizeSummaryPath,
    '--manifest', path.join(itemRoot, 'manifest.json'),
    '--output', publishPackagePath,
    '--project-root', projectRoot,
  ], { cwd: projectRoot, maxBuffer: 4 * 1024 * 1024 });
  const publishPackage = await safeJson(publishPackagePath, {});
  const priceReady = publishPackage.price_display?.status === 'READY'
    && ['front', 'back'].every(view => publishPackage.price_display?.rendered_views?.includes(view))
    && Number(publishPackage.price_display?.sale_price) === Number(product.sale_price);
  if (publishPackage.status !== 'READY_TO_PUBLISH' || !priceReady) {
    throw new Error(`PRICE_READY_PACKAGE_REQUIRED:${JSON.stringify(publishPackage.blockers || [])}`);
  }
  return {
    publishPackagePath: cleanRelative(publishPackagePath),
    publishPackage,
  };
}

async function approveProduct(sku, body) {
  const data = await listProducts();
  const product = data.products.find(item => item.sku === sku);
  if (!product) return { status: 404, body: { error: 'PRODUCT_NOT_FOUND' } };
  const destination = data.destinations[body.destination];
  if (!destination) return { status: 400, body: { error: 'DESTINATION_NOT_FOUND' } };
  if (!destination.accepts_approval) return { status: 409, body: { error: 'DESTINATION_NOT_READY' } };
  if (body.revision !== product.revision) return { status: 409, body: { error: 'STALE_REVIEW_REVISION', current_revision: product.revision } };
  if (!product.can_approve) return { status: 409, body: { error: 'PRODUCT_NOT_REVIEWABLE', blockers: product.unresolved_blockers } };
  if (body.confirmed !== true) return { status: 400, body: { error: 'EXPLICIT_CONFIRMATION_REQUIRED' } };
  const queueState = destination.connector_status === 'active'
    ? 'QUEUED_FOR_DISPATCH'
    : 'APPROVED_WAITING_FOR_CONNECTOR';
  const eventId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${sku}-${crypto.randomBytes(3).toString('hex')}`;
  const signal = {
    version: 1,
    event_id: eventId,
    created_at: new Date().toISOString(),
    sku,
    revision: product.revision,
    destination: body.destination,
    decision: 'APPROVED',
    confirmed: true,
    note: String(body.note || '').slice(0, 500),
    resolved_review_blockers: product.blockers.filter(blocker => REVIEW_RESOLVABLE_BLOCKERS.has(blocker)),
    queue_state: queueState,
    connector_status: destination.connector_status,
  };
  if (body.validate_only === true) {
    return {
      status: 200,
      body: {
        ok: true,
        validate_only: true,
        would_write: signal,
        would_finalize_price_views: ['front', 'back'],
        sale_price: product.sale_price,
      },
    };
  }
  let materialized;
  try {
    materialized = await materializePublishPackage(product);
  } catch (error) {
    return {
      status: 409,
      body: {
        error: 'PRICE_FINALIZATION_REQUIRED',
        detail: error?.message || String(error),
      },
    };
  }
  signal.sale_price = product.sale_price;
  signal.price_display_status = materialized.publishPackage.price_display.status;
  signal.price_rendered_views = materialized.publishPackage.price_display.rendered_views;
  signal.publish_package = materialized.publishPackagePath;
  await writeAtomic(resolveProjectPath(path.join('work/approval-signals', `${eventId}.json`)), signal);
  await writeAtomic(resolveProjectPath(path.join('work/publish-queue', `${eventId}.json`)), {
    ...signal,
    state: queueState,
    attempts: [],
    external_publish_id: null,
    final_images: materialized.publishPackage.final_images,
  });
  return { status: 201, body: { ok: true, signal } };
}

async function serveStatic(response, relativePath) {
  const target = resolveProjectPath(path.join('dashboard', relativePath));
  const dashboardRoot = resolveProjectPath('dashboard');
  if (!(target === dashboardRoot || target.startsWith(`${dashboardRoot}${path.sep}`)) || !(await exists(target))) {
    response.writeHead(404);
    response.end('Not found');
    return;
  }
  response.writeHead(200, {
    'content-type': MIME[path.extname(target)] || 'application/octet-stream',
    'cache-control': 'no-store',
  });
  response.end(await fs.readFile(target));
}

async function serveMedia(response, value) {
  const target = resolveProjectPath(value || '');
  const allowed = MEDIA_ROOTS.some(root => target === root || target.startsWith(`${root}${path.sep}`));
  if (!allowed || !(await exists(target))) {
    response.writeHead(404);
    response.end('Media not found');
    return;
  }
  response.writeHead(200, {
    'content-type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
    'cache-control': 'private, max-age=60',
  });
  response.end(await fs.readFile(target));
}

const args = parseArgs(process.argv.slice(2));
const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    if (request.method === 'GET' && url.pathname === '/health') {
      return json(response, 200, { ok: true, service: 'yupoo-review-dashboard' });
    }
    if (request.method === 'GET' && url.pathname === '/api/products') {
      const data = await listProducts();
      return json(response, 200, data);
    }
    if (request.method === 'GET' && url.pathname.startsWith('/api/products/')) {
      const sku = decodeURIComponent(url.pathname.split('/').pop());
      const data = await listProducts();
      const product = data.products.find(item => item.sku === sku);
      return product ? json(response, 200, product) : json(response, 404, { error: 'PRODUCT_NOT_FOUND' });
    }
    if (request.method === 'POST' && url.pathname.endsWith('/approve') && url.pathname.startsWith('/api/products/')) {
      const sku = decodeURIComponent(url.pathname.split('/').slice(-2)[0]);
      const result = await approveProduct(sku, await readBody(request));
      return json(response, result.status, result.body);
    }
    if (request.method === 'GET' && url.pathname === '/media') return serveMedia(response, url.searchParams.get('path'));
    if (request.method === 'GET' && url.pathname === '/') return serveStatic(response, 'index.html');
    if (request.method === 'GET' && url.pathname.startsWith('/assets/')) return serveStatic(response, url.pathname.replace('/assets/', ''));
    response.writeHead(404);
    response.end('Not found');
  } catch (error) {
    json(response, 500, { error: error?.message || String(error) });
  }
});

server.listen(args.port, args.host, () => {
  console.log(`Review dashboard listening at http://${args.host}:${args.port}/`);
  void refreshPricePreviews(args);
  const interval = setInterval(() => void refreshPricePreviews(args), 5 * 60 * 1000);
  interval.unref();
});
