import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { classifyItemArtifacts, inspectSkuArtifacts, REQUIRED_VIEWS } from '../scripts/artifact-state.mjs';
import {
  assertForceScope,
  assertTransition,
  isLockedState,
  mergeCatalog,
  normalizeSku,
} from '../scripts/catalog-state.mjs';

test('an existing item directory is not completion evidence', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yupoo-state-'));
  try {
    await fs.writeFile(path.join(root, 'manifest.json'), '{}\n');
    const result = await classifyItemArtifacts({ itemRoot: root });
    assert.equal(result.state, 'CONFIG_REQUIRED');
    assert.notEqual(result.state, 'SKIPPED_COMPLETE');
    assert.deepEqual(result.missing_views, REQUIRED_VIEWS);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a configured item with no generated views is ready to generate', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yupoo-state-'));
  try {
    await fs.writeFile(path.join(root, 'manifest.json'), '{}\n');
    await fs.writeFile(path.join(root, 'classification.json'), '{}\n');
    const result = await classifyItemArtifacts({ itemRoot: root });
    assert.equal(result.state, 'READY_TO_GENERATE');
    assert.deepEqual(result.missing_views, REQUIRED_VIEWS);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('normalizes SKU and merges duplicate discovery sources', () => {
  assert.equal(normalizeSku(' kt 7794 '), 'KT7794');
  const merged = mergeCatalog({ version: 2, items: [] }, [
    { sku: 'kt7794', album_id: '242408630', url: 'https://x.yupoo.com/a', picture_dates: ['2026-06-17'], in_range_picture_count: 6 },
    { sku: ' KT7794 ', album_id: '242408630', url: 'https://x.yupoo.com/a', picture_dates: ['2026-06-17'], in_range_picture_count: 6 },
    { sku: 'KT7794', album_id: 'other', url: 'https://x.yupoo.com/b', picture_dates: ['2026-06-18'], in_range_picture_count: 1 },
  ], { now: '2026-07-22T01:00:00.000Z' });
  assert.equal(merged.items.length, 1);
  assert.equal(merged.items[0].sources.length, 2);
  assert.equal(merged.items[0].state, 'DISCOVERED');
});

test('locked states cannot regress without SKU-scoped force', () => {
  assert.equal(isLockedState('PUBLISHED'), true);
  assert.throws(() => assertTransition('PUBLISHED', 'READY_TO_GENERATE'), /LOCKED_STATE_TRANSITION/);
  assert.equal(assertTransition('PUBLISHED', 'READY_TO_GENERATE', { force: true, sku: 'KT7794' }), true);
  assert.throws(() => assertForceScope({ force: true, skus: [] }), /FORCE_REQUIRES_EXACTLY_ONE_SKU/);
  assert.throws(() => assertForceScope({ force: true, skus: ['A', 'B'] }), /FORCE_REQUIRES_EXACTLY_ONE_SKU/);
});

test('retryable failures may return to the missing stage', () => {
  assert.equal(assertTransition('FAILED_RETRYABLE', 'INGEST_REQUIRED'), true);
});

test('reconciliation resumes a partial SKU instead of skipping its directory', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yupoo-reconcile-'));
  try {
    const itemRoot = path.join(root, 'work/items/KT3055');
    await fs.mkdir(path.join(itemRoot, 'originals'), { recursive: true });
    await fs.mkdir(path.join(root, 'config'), { recursive: true });
    await fs.mkdir(path.join(root, 'runs/one/review'), { recursive: true });
    await fs.writeFile(path.join(itemRoot, 'originals/01.png'), 'image');
    await fs.writeFile(path.join(itemRoot, 'manifest.json'), JSON.stringify({ images: [{ path: 'work/items/KT3055/originals/01.png' }] }));
    await fs.writeFile(path.join(root, 'config/KT3055.classification.json'), '{}');
    await fs.writeFile(path.join(root, 'runs/one/review/KT3055-front.png'), 'front');
    const result = await inspectSkuArtifacts({ projectRoot: root, sku: 'KT3055' });
    assert.equal(result.state, 'PARTIAL_RESUME');
    assert.deepEqual(result.available_views, ['front']);
    assert.deepEqual(result.missing_views, ['back', 'tryon_main', 'tryon_detail', 'tryon_back']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
