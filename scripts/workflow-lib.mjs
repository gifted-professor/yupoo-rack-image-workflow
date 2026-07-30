import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function loadLocalEnv() {
  const envPath = path.join(projectRoot, '.env');
  let raw;
  try {
    raw = await fs.readFile(envPath, 'utf8');
  } catch {
    return;
  }
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

export function parseArgs(argv) {
  const args = { dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--dry-run') args.dryRun = true;
    else if (value === '--batch') args.batch = argv[++index];
    else if (value === '--run-id') args.runId = argv[++index];
    else throw new Error(`Unknown argument: ${value}`);
  }
  return args;
}

export function resolveProjectPath(value) {
  if (!value) throw new Error('Required path is empty');
  return path.isAbsolute(value) ? value : path.resolve(projectRoot, value);
}

async function pathExists(value) {
  try {
    await fs.access(value);
    return true;
  } catch {
    return false;
  }
}

export async function resolvePythonRuntime() {
  if (process.env.PYTHON) return process.env.PYTHON;
  const virtualEnvCandidates = process.platform === 'win32'
    ? ['.venv/Scripts/python.exe', '.venv/bin/python']
    : ['.venv/bin/python', '.venv/Scripts/python.exe'];
  for (const candidate of virtualEnvCandidates) {
    const absolute = resolveProjectPath(candidate);
    if (await pathExists(absolute)) return absolute;
  }
  return process.platform === 'win32' ? 'python' : 'python3';
}

export async function readJson(file) {
  return JSON.parse(await fs.readFile(resolveProjectPath(file), 'utf8'));
}

export async function writeJson(file, value) {
  const target = resolveProjectPath(file);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`);
}

export function makeRunId(prefix = 'run') {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `${prefix}-${stamp}`;
}

export async function assertReadable(file, label = 'file') {
  const target = resolveProjectPath(file);
  try {
    await fs.access(target);
  } catch {
    throw new Error(`${label} does not exist: ${target}`);
  }
  return target;
}

function mimeFor(file) {
  const extension = path.extname(file).toLowerCase();
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.webp') return 'image/webp';
  return 'image/png';
}

export async function asDataUrl(file) {
  const target = await assertReadable(file, 'reference image');
  return `data:${mimeFor(target)};base64,${(await fs.readFile(target)).toString('base64')}`;
}

export async function runPool(jobs, concurrency, worker) {
  const results = new Array(jobs.length);
  let cursor = 0;
  async function consume() {
    while (cursor < jobs.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = await worker(jobs[index], index);
      } catch (error) {
        results[index] = {
          ok: false,
          id: jobs[index].id,
          sku: jobs[index].sku,
          error: error?.message || String(error),
        };
      }
    }
  }
  const workerCount = Math.max(1, Math.min(Number(concurrency) || 1, jobs.length || 1));
  await Promise.all(Array.from({ length: workerCount }, consume));
  return results;
}

export async function callImageBridge({ bridgeUrl, prompt, type, references, sku, verifiedFacts }) {
  const images = await Promise.all(references.map(asDataUrl));
  const started = Date.now();
  const timeoutMs = Math.max(30_000, Number(process.env.IMAGE_BRIDGE_REQUEST_TIMEOUT_MS || 240_000));
  const response = await fetch(bridgeUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      prompt,
      type,
      images,
      productContext: {
        category: '服装',
        sku,
        verifiedFacts,
      },
    }),
  });
  const body = await response.json().catch(() => ({}));
  const elapsedMs = Date.now() - started;
  const dataUrl = body.imageDataUrl || body.imageDataUrls?.[0];
  if (!response.ok || body.fallback || !dataUrl) {
    throw new Error(body.warning || body.error || `Image bridge HTTP ${response.status}`);
  }
  const match = dataUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/s);
  if (!match) throw new Error('Image bridge returned an unsupported image payload');
  return { body, elapsedMs, mime: match[1], bytes: Buffer.from(match[2], 'base64') };
}

export async function checkImageBridge(bridgeUrl) {
  const url = new URL(bridgeUrl);
  url.pathname = '/api/config';
  url.search = '';
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`Image bridge preflight failed: HTTP ${response.status}`);
  const config = await response.json();
  if (config.imageModel !== 'gpt-image-2') {
    throw new Error(`Image bridge model mismatch: expected gpt-image-2, got ${config.imageModel || 'unknown'}`);
  }
  return {
    imageModel: config.imageModel,
    responsesModel: config.imageResponsesModel,
    responsesFallbackModels: config.imageResponsesFallbackModels,
    proxyBaseUrl: config.proxyBaseUrl,
  };
}

export async function saveGeneratedImage(file, result) {
  const target = resolveProjectPath(file);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, result.bytes);
  return target;
}

export function extensionFor(mime) {
  return mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1];
}
