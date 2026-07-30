import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

test('ingest runner dry-run selects only INGEST_REQUIRED products', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'yupoo-ingest-runner-'));
  try {
    const snapshotPath = path.join(temp, 'snapshot.json');
    const catalogPath = path.join(temp, 'catalog.json');
    await fs.writeFile(snapshotPath, JSON.stringify({ products: [
      { sku: 'NEW100', url: 'https://x.yupoo.com/albums/1' },
      { sku: 'NEW200', url: 'https://x.yupoo.com/albums/2' },
      { sku: 'DONE300', url: 'https://x.yupoo.com/albums/3' },
    ] }));
    await fs.writeFile(catalogPath, JSON.stringify({ items: [
      { sku: 'NEW100', state: 'INGEST_REQUIRED' },
      { sku: 'NEW200', state: 'INGEST_REQUIRED' },
      { sku: 'DONE300', state: 'REVIEW_PENDING' },
    ] }));
    const { stdout } = await execFileAsync(process.execPath, [
      'scripts/ingest-products.mjs',
      '--snapshot', snapshotPath,
      '--catalog', catalogPath,
      '--dry-run',
    ], { maxBuffer: 4 * 1024 * 1024 });
    const result = JSON.parse(stdout);
    assert.equal(result.mode, 'dry-run');
    assert.equal(result.selected, 2);
    assert.deepEqual(result.skus, ['NEW100', 'NEW200']);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});
