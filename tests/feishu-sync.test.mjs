import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

import {
  dedupeFeishuRecords,
  feishuState,
  parseFeishuRows,
  planCatalogChanges,
} from '../scripts/feishu-status.mjs';

test('deduplicates repeated Feishu rows while preserving record IDs', async () => {
  const payload = JSON.parse(await fs.readFile('tests/fixtures/feishu/record-list.json', 'utf8'));
  const parsed = parseFeishuRows(payload);
  const unique = dedupeFeishuRecords(parsed);
  assert.equal(parsed.length, 4);
  assert.equal(unique.length, 2);
  assert.deepEqual(unique[0].record_ids, ['rec_a1', 'rec_a2']);
  assert.equal(unique[0].original_status, '✅ 已完成');
  assert.equal(feishuState(unique[0]), 'INGESTED');
});

test('plans source updates without mutating the catalog', () => {
  const catalog = { version: 2, items: [{ sku: 'DX1488-100', sources: [] }] };
  const records = [{ sku: 'DX1488-100', yupoo_url: 'https://x.yupoo.com/a' }];
  const before = JSON.stringify(catalog);
  const changes = planCatalogChanges(catalog, records);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].type, 'update_source');
  assert.equal(JSON.stringify(catalog), before);
});
