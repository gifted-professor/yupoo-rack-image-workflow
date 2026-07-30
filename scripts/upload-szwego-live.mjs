#!/usr/bin/env node
import { resolveProjectPath } from './workflow-lib.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';

const { readJson, writeJson } = await import('./workflow-lib.mjs');

function parseUploadArgs(argv) {
  const args = { dryRun: false };
  const processed = argv.slice(2);
  for (let i = 0; i < processed.length; i++) {
    const v = processed[i];
    if (v === '--dry-run') args.dryRun = true;
    else if (v === '--batch' && processed[i + 1]) {
      args.batch = processed[i + 1];
      i++;
    } else if (v === '--report' && processed[i + 1]) {
      args.report = processed[i + 1];
      i++;
    } else {
      throw new Error(`Unknown argument: ${v}`);
    }
  }
  return args;
}

const argv = parseUploadArgs(process.argv);

if (!argv.batch || argv.dryRun) {
  console.error('Live mode: set --batch <file.json> 且不加 --dry-run');
  process.exit(1);
}

const batchPath = argv.batch;
const batch = await readJson(resolveProjectPath(batchPath));
if (batch.target !== 'szwego') throw new Error('Batch target 必须为 szwego');

// ── Login ──────────────────────────────────────────────────
let sessionToken = null;
let sessionCookie = null;

async function login() {
  const url = 'https://www.szwego.com/api/login';
  const body = JSON.stringify({
    username: process.env.SZWE_GO_USERNAME || '',
    password: process.env.SZWE_GO_PASSWORD || '',
  });
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  if (!resp.ok) {
    throw new Error(`Login failed: HTTP ${resp.status}`);
  }
  const data = await resp.json();
  sessionToken = data.token || null;
  sessionCookie = data.sid || null;
  console.log('✅ 登录成功');
}

// ── Single SKU ─────────────────────────────────────────────
async function processOne(queueFilePath) {
  const item = await readJson(queueFilePath);
  const sku = item.sku;
  const publishPkgPath = item.publish_package
    || resolveProjectPath(`work/items/${sku}/publish-package.json`);
  const publishPackage = await readJson(publishPkgPath);

  const form = new FormData();

  form.append('title', publishPackage.title);
  form.append('short_name', publishPackage.short_name);
  form.append('description', publishPackage.description);
  form.append('category', publishPackage.category);
  form.append('tags', JSON.stringify(publishPackage.tags));
  form.append('colors', JSON.stringify(publishPackage.colors));
  form.append('sizes', JSON.stringify(publishPackage.sizes));
  form.append('inventory', JSON.stringify(publishPackage.inventory_total));
  form.append('sale_price', publishPackage.sale_price);
  form.append('cost_price', publishPackage.cost_price);

  if (Array.isArray(publishPackage.variants)) {
    publishPackage.variants.forEach(v => {
      form.append('variants', JSON.stringify({
        color: v.color,
        size: v.size,
        inventory: v.inventory,
      }));
    });
  }

  const images = publishPackage.final_images || {};
  const views = ['front', 'back', 'tryon_main', 'tryon_detail', 'tryon_back'];
  for (const view of views) {
    const imgPath = images[view];
    if (imgPath) {
      const buf = await fs.readFile(imgPath);
      const blob = new Blob([buf], { type: 'image/jpeg' });
      form.append('files[]', blob, path.basename(imgPath));
    }
  }

  const headers = {
    'X-Request-Type': 'human-confirm',
  };
  if (sessionCookie) headers.Cookie = `sid=${sessionCookie}`;
  if (sessionToken) headers['X-Auth-Token'] = sessionToken;

  const uploadUrl = 'https://www.szwego.com/api/v1/products/create';
  try {
    const resp = await fetch(uploadUrl, {
      method: 'POST',
      headers,
      body: form,
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
    }
    const data = await resp.json();

    const updated = {
      ...item,
      status: 'PUBLISHED',
      upload_time: new Date().toISOString(),
      attempts: (item.attempts || []).concat({
        success: true,
        ts: new Date().toISOString(),
      }),
      external_publish_id: data.publish_id || null,
    };
    await writeJson(resolveProjectPath(queueFilePath), updated);
    console.log(`✅ ${sku} 上传成功 → PUBLISHED`);
    return true;
  } catch (e) {
    console.error(`❌ ${sku} 上传失败: ${e.message}`);
    return false;
  }
}

// ── Main ────────────────────────────────────────────────────
await login();

const queueDir = resolveProjectPath('work/publish-queue');
const files = await fs.readdir(queueDir);
const jsonFiles = files.filter(f => f.endsWith('.json'));

const results = [];
for (const file of jsonFiles) {
  const full = resolveProjectPath(path.join(queueDir, file));
  const ok = await processOne(full);
  results.push({ file, success: ok });
}

const overall = {
  version: 1,
  mode: 'live-upload',
  total: results.length,
  succeeded: results.filter(r => r.success).length,
  failed: results.filter(r => !r.success).length,
  results,
};

if (argv.report) {
  const rp = path.resolve(path.dirname(batchPath), argv.report);
  await writeJson(rp, overall);
}
console.log(JSON.stringify(overall, null, 2));

process.exit(results.every(r => r.success) ? 0 : 1);
