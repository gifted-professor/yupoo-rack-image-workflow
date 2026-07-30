#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  classificationPrompt,
  extractJsonObject,
  normalizeVisionClassification,
} from './classification-lib.mjs';
import { loadLocalEnv, runPool, projectRoot, resolveProjectPath } from './workflow-lib.mjs';

function parseArgs(argv) {
  const args = {
    snapshot: 'runs/full-20260722/discovery.json',
    catalog: 'config/sku-catalog.json',
    report: 'runs/full-20260722/classification-report.json',
    concurrency: 2,
    limit: Infinity,
    sku: null,
    force: false,
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--snapshot') args.snapshot = argv[++index];
    else if (value === '--catalog') args.catalog = argv[++index];
    else if (value === '--report') args.report = argv[++index];
    else if (value === '--concurrency') args.concurrency = Number(argv[++index]);
    else if (value === '--limit') args.limit = Number(argv[++index]);
    else if (value === '--sku') args.sku = argv[++index];
    else if (value === '--force') args.force = true;
    else if (value === '--dry-run') args.dryRun = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  return args;
}

async function loadEnvFile(file) {
  const raw = await fs.readFile(file, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
    if (!(key in process.env)) process.env[key] = value;
  }
}

async function writeAtomic(target, value) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  await fs.rename(temporary, target);
}

function extractText(payload) {
  if (typeof payload?.choices?.[0]?.message?.content === 'string') return payload.choices[0].message.content;
  if (typeof payload?.output_text === 'string') return payload.output_text;
  const values = [];
  const walk = item => {
    if (!item) return;
    if (Array.isArray(item)) return item.forEach(walk);
    if (typeof item !== 'object') return;
    if ((item.type === 'output_text' || item.type === 'text') && typeof item.text === 'string') values.push(item.text);
    if (item.output) walk(item.output);
    if (item.content) walk(item.content);
  };
  walk(payload?.output);
  return values.join('\n');
}

async function callVision({ dataUrl, prompt }) {
  const baseUrl = (process.env.AI_PROXY_BASE_URL || 'http://127.0.0.1:8317').replace(/\/$/, '');
  const apiKey = process.env.AI_PROXY_API_KEY;
  if (!apiKey) throw new Error('AI_PROXY_API_KEY is unavailable');
  const models = [
    process.env.AI_VISION_MODEL || 'grok-4.3',
    ...(process.env.AI_VISION_FALLBACK_MODELS || '').split(',').map(value => value.trim()),
  ].filter(Boolean);
  let lastError;
  for (const model of [...new Set(models)]) {
    try {
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          temperature: 0,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          }],
        }),
        signal: AbortSignal.timeout(180_000),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(`${model}: HTTP ${response.status} ${String(payload?.error?.message || '').slice(0, 180)}`);
      const text = extractText(payload);
      if (!text) throw new Error(`${model}: empty vision response`);
      return { model, text, parsed: extractJsonObject(text) };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('vision classification failed');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const snapshot = JSON.parse(await fs.readFile(resolveProjectPath(args.snapshot), 'utf8'));
  const catalog = JSON.parse(await fs.readFile(resolveProjectPath(args.catalog), 'utf8'));
  const stateBySku = new Map((catalog.items || []).map(item => [item.sku, item.state]));
  const jobs = [];
  for (const product of snapshot.products || []) {
    if (!product.included || !product.sku) continue;
    if (args.sku && product.sku !== args.sku) continue;
    const output = resolveProjectPath(`config/${product.sku}.classification.json`);
    const existing = await fs.access(output).then(() => true).catch(() => false);
    if (!args.force && existing) continue;
    if (!args.force && stateBySku.get(product.sku) !== 'CONFIG_REQUIRED') continue;
    jobs.push({ sku: product.sku, title: product.title, output });
  }
  const selected = jobs.slice(0, Number.isFinite(args.limit) ? args.limit : jobs.length);
  if (args.dryRun) {
    console.log(JSON.stringify({ ok: true, mode: 'dry-run', selected: selected.length, skus: selected.map(item => item.sku) }, null, 2));
    return;
  }

  await loadLocalEnv();
  if (process.env.VISION_ENV_FILE) {
    await loadEnvFile(resolveProjectPath(process.env.VISION_ENV_FILE));
  }
  const startedAt = new Date().toISOString();
  const results = await runPool(selected, args.concurrency, async job => {
    const itemRoot = resolveProjectPath(`work/items/${job.sku}`);
    const manifest = JSON.parse(await fs.readFile(path.join(itemRoot, 'manifest.json'), 'utf8'));
    const contactSheet = path.join(itemRoot, 'contact-sheet.jpg');
    const bytes = await fs.readFile(contactSheet);
    const sourceSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    const dataUrl = `data:image/jpeg;base64,${bytes.toString('base64')}`;
    const response = await callVision({
      dataUrl,
      prompt: classificationPrompt({ sku: job.sku, title: manifest.title || job.title, imageCount: manifest.images.length }),
    });
    const normalized = normalizeVisionClassification({
      sku: job.sku,
      title: manifest.title || job.title,
      imageCount: manifest.images.length,
      parsed: response.parsed,
    });
    await writeAtomic(job.output, normalized.classification);
    const auditPath = path.join(itemRoot, 'classification-audit.json');
    await writeAtomic(auditPath, {
      version: 1,
      sku: job.sku,
      created_at: new Date().toISOString(),
      source: { contact_sheet: path.relative(projectRoot, contactSheet), sha256: sourceSha256, image_count: manifest.images.length },
      model: response.model,
      evidence: normalized.evidence,
      parsed_response: response.parsed,
      classification_path: path.relative(projectRoot, job.output),
    });
    return { ok: true, sku: job.sku, model: response.model, confidence: normalized.evidence.confidence, output: path.relative(projectRoot, job.output) };
  });
  const report = {
    version: 1,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    requested: selected.length,
    succeeded: results.filter(item => item.ok).length,
    failed: results.filter(item => !item.ok).length,
    results,
  };
  await writeAtomic(resolveProjectPath(args.report), report);
  console.log(JSON.stringify(report, null, 2));
  if (report.failed) process.exitCode = 1;
}

main().catch(error => {
  console.error(`错误: ${error.message}`);
  process.exit(1);
});
