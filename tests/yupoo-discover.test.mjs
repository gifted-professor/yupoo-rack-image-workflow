import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { combineDiscoveryPages, parseDiscoveryArgs } from '../scripts/yupoo-discover.mjs';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

test('validates fixed inclusive discovery dates', () => {
  const args = parseDiscoveryArgs([
    '--album-url', 'https://x.yupoo.com/photos/adidas666888/collections/200106',
    '--from', '2026-03-01',
    '--to', '2026-07-22',
    '--dry-run',
  ]);
  assert.equal(args.fromDate, '2026-03-01');
  assert.equal(args.toDate, '2026-07-22');
  assert.throws(() => parseDiscoveryArgs(['--album-url', 'x', '--from', '2026-08-01', '--to', '2026-07-22']), /FROM_DATE_AFTER_TO_DATE/);
});

test('combines pages without duplicating album IDs', () => {
  const product = { sku: 'KT7794', album_id: '242408630', included: true, picture_dates: ['2026-06-17'] };
  const result = combineDiscoveryPages([
    { products: [product], warnings: [] },
    { products: [product, { sku: 'OLD100', album_id: '100', included: false, picture_dates: ['2026-02-28'] }], warnings: [] },
  ], { source: 'x', fromDate: '2026-03-01', toDate: '2026-07-22', capturedAt: '2026-07-22T00:00:00Z' });
  assert.equal(result.albums_scanned, 2);
  assert.equal(result.included_count, 1);
  assert.equal(result.excluded_count, 1);
});

test('fixture discovery uses visible Yupoo dates and does not write in dry-run', async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    'scripts/yupoo-discover.mjs',
    '--album-url', 'https://x.yupoo.com/photos/adidas666888/collections/200106',
    '--from', '2026-03-01',
    '--to', '2026-07-22',
    '--cached-html', 'tests/fixtures/yupoo/list-page-1.html',
    '--cached-product-dir', 'tests/fixtures/yupoo',
    '--dry-run',
  ], { cwd: root, maxBuffer: 4 * 1024 * 1024 });
  const result = JSON.parse(stdout);
  assert.equal(result.albums_scanned, 3);
  assert.equal(result.included_count, 1);
  assert.equal(result.products[0].sku, 'KT7794');
  assert.equal(result.products[0].in_range_picture_count, 6);
  assert.equal(result.products[0].pictures[0].filename, 'ScreenShot_2026-06-16_a.png');
  assert.equal(result.products[0].pictures[0].visible_date, '2026-06-17');
  assert.equal(result.excluded_count, 1);
  assert.equal(result.undated_count, 1);
});
