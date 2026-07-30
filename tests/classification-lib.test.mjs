import assert from 'node:assert/strict';
import test from 'node:test';

import { extractJsonObject, normalizeVisionClassification, sizesFromTitle, titleFacts } from '../scripts/classification-lib.mjs';

test('extractJsonObject accepts fenced JSON', () => {
  assert.deepEqual(extractJsonObject('```json\n{"brand":"nike"}\n```'), { brand: 'nike' });
});

test('sizesFromTitle expands apparel size ranges', () => {
  assert.deepEqual(sizesFromTitle('女款短袖 XS-XL 60'), ['XS', 'S', 'M', 'L', 'XL']);
  assert.deepEqual(sizesFromTitle('男款长裤 S-XXL 80'), ['S', 'M', 'L', 'XL', 'XXL']);
});

test('titleFacts classifies common Chinese apparel titles', () => {
  assert.deepEqual(titleFacts('新款IF2051-010 男款速干短裤 S-XXL 80'), {
    gender: ['男子'], category: '速干短裤', product_type: 'shorts', sizes: ['S', 'M', 'L', 'XL', 'XXL'],
  });
});

test('normalizeVisionClassification requires evidenced front and back', () => {
  const value = normalizeVisionClassification({
    sku: 'AB1234-001', title: '女款短袖 XS-XL 60', imageCount: 4,
    parsed: {
      brand: 'nike', product_type: 'shirt', color_authority: 2, confidence: 0.92, color: '黑色',
      roles: { front_full: [2, 4], back_full: [3], logo_detail: [2] },
      facts: { colors: ['黑色'], features: ['圆领'] },
    },
  });
  assert.equal(value.classification.brand, 'nike');
  assert.deepEqual(value.classification.roles.back_structure_detail, [3]);
  assert.deepEqual(value.classification.facts.sizes, ['XS', 'S', 'M', 'L', 'XL']);
  assert.throws(() => normalizeVisionClassification({
    sku: 'AB1234-001', title: '女款短袖 XS-XL 60', imageCount: 4,
    parsed: { brand: 'nike', confidence: 0.9, roles: { front_full: [2], back_full: [] } },
  }), /no defensible back_full or rear-detail/);
});

test('normalizes a rear detail as partial back evidence without inventing a full view', () => {
  const value = normalizeVisionClassification({
    sku: 'JF5957-797', title: '女款短袖 S-XL 60', imageCount: 3,
    parsed: { brand: 'nike', product_type: 'shirt', color_authority: 3, confidence: 0.9,
      roles: { front_full: [3], back_full: [], back_structure_detail: [2] }, facts: { colors: ['黄色'] } },
  });
  assert.deepEqual(value.classification.roles.back_full, [2]);
  assert.match(value.evidence.warnings.join(' '), /BACK_VIEW_PARTIAL/);
});

test('preserves an unconfirmed brand without guessing a known label', () => {
  const value = normalizeVisionClassification({
    sku: 'KH2713', title: '女款外套 XS-XL 150', imageCount: 7,
    parsed: {
      brand: 'unknown', product_type: 'jacket', color_authority: 5, confidence: 0.66,
      roles: { front_full: [5, 6, 7], back_full: [4], tag_detail: [3] },
      facts: { colors: ['白色'], features: ['连帽', '拉链', '松紧袖口'] },
      warnings: ['label text is not readable'],
    },
  });
  assert.equal(value.classification.brand, 'unknown');
  assert.equal(value.classification.facts.brand_display, '未确认品牌');
  assert.match(value.evidence.warnings.join(' '), /BRAND_UNCONFIRMED/);
});
