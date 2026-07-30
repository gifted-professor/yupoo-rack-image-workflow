import assert from 'node:assert/strict';
import test from 'node:test';

import {
  brandTags,
  buildTags,
  isOuterwear,
  hashIndex as xhsHashIndex,
} from '../scripts/build-xhs-copy.mjs';
import {
  TEMPLATES,
  hashIndex as xianyuHashIndex,
  sizeRange,
} from '../scripts/build-xianyu-copy.mjs';
import { mapBrand, mapCategory } from '../scripts/push-catalog-status.mjs';
import { feishuPatchForState, FEISHU_STATUS_OPTIONS as OPT } from '../scripts/feishu-status.mjs';

test('mapBrand maps to the four Feishu brand options', () => {
  assert.equal(mapBrand('nike'), 'Nike');
  assert.equal(mapBrand('Nike'), 'Nike');
  assert.equal(mapBrand('adidas'), 'Adidas');
  assert.equal(mapBrand('ck'), 'CK');
  assert.equal(mapBrand('calvinklein'), 'CK');
  assert.equal(mapBrand('jordan'), '其他'); // jordan is not a Feishu brand option
  assert.equal(mapBrand(''), '其他');
  assert.equal(mapBrand(undefined), '其他');
});

test('mapCategory maps to the five Feishu category options (上衣/裤子/鞋子/帽子/背心)', () => {
  assert.equal(mapCategory('运动短裤'), '裤子');
  // 外套/夹克 are not their own Feishu option — they fall through to 上衣.
  assert.equal(mapCategory('梭织外套'), '上衣');
  assert.equal(mapCategory('羽绒夹克'), '上衣');
  assert.equal(mapCategory('短袖T恤'), '上衣');
  assert.equal(mapCategory('棒球帽'), '帽子');
  assert.equal(mapCategory('运动背心'), '背心');
  assert.equal(mapCategory('速干鞋'), '鞋子');
  assert.equal(mapCategory(''), '上衣'); // default to 上衣 for unknown tops
});

test('brandTags returns the pool tags per brand family', () => {
  assert.deepEqual(brandTags('nike'), ['耐克', 'nike']);
  assert.deepEqual(brandTags('JORDAN'), ['耐克', 'nike']); // jordan belongs to nike family
  assert.deepEqual(brandTags('adidas'), ['adidas', '三叶草']);
  assert.deepEqual(brandTags('ck'), ['CK']);
  assert.deepEqual(brandTags('others'), ['奥莱代购']);
  assert.deepEqual(brandTags(undefined), ['奥莱代购']);
});

test('isOuterwear detects jacket/coat categories', () => {
  assert.equal(isOuterwear('梭织外套'), true);
  assert.equal(isOuterwear('立领夹克'), true);
  assert.equal(isOuterwear('短袖T恤'), false);
  assert.equal(isOuterwear('运动短裤'), false);
  assert.equal(isOuterwear(undefined), false);
});

test('buildTags picks ~3 tags by brand+category, always with 奥莱', () => {
  // nike non-outerwear: 耐克, nike, 奥莱
  assert.deepEqual(buildTags('nike', '短袖T恤'), ['耐克', 'nike', '奥莱']);
  // nike outerwear: 耐克, 外套, 奥莱 (drops the 2nd brand tag for 外套)
  assert.deepEqual(buildTags('nike', '梭织外套'), ['耐克', '外套', '奥莱']);
  // adidas non-outerwear: adidas, 三叶草, 奥莱
  assert.deepEqual(buildTags('adidas', '短袖T恤'), ['adidas', '三叶草', '奥莱']);
  // adidas outerwear: adidas, 外套, 奥莱
  assert.deepEqual(buildTags('adidas', '夹克'), ['adidas', '外套', '奥莱']);
  // single-brand family: brand + category + 奥莱
  assert.deepEqual(buildTags('ck', '短袖T恤'), ['CK', '穿搭', '奥莱']);
  assert.deepEqual(buildTags('unknown', '梭织外套'), ['奥莱代购', '外套', '奥莱']);
  // deduped: 奥莱代购 + 奥莱 both kept (different strings)
  assert.deepEqual(buildTags(undefined, '短袖T恤'), ['奥莱代购', '穿搭', '奥莱']);
});

test('hashIndex is deterministic and stable across re-imports', () => {
  // Same SKU always maps to the same template; different SKUs spread across templates.
  assert.equal(xhsHashIndex('DX1488-100', 3), xhsHashIndex('DX1488-100', 3));
  assert.equal(xianyuHashIndex('DX1488-100', 4), xianyuHashIndex('DX1488-100', 4));
  const spread = new Set();
  for (const sku of ['BV2708-410', 'FN2999-251', 'FV8693-010', 'HM9699-006', 'HQ0651-006', 'IF0588-006']) {
    spread.add(xianyuHashIndex(sku, 4));
  }
  assert.ok(spread.size >= 2, 'hash should spread SKUs across templates');
});

test('xianyu templates are the four operator-supplied ones', () => {
  assert.equal(TEMPLATES.length, 4);
  assert.equal(TEMPLATES[0].key, '撤店清仓');
  assert.equal(TEMPLATES[1].key, '出全新');
  assert.equal(TEMPLATES[2].key, '出闲置');
  assert.equal(TEMPLATES[3].key, '奥莱折扣');
  // 撤店清仓 fills the size line; empty size line is dropped.
  assert.ok(TEMPLATES[0].build('尺码 S-XXL').includes('尺码 S-XXL'));
  assert.ok(!TEMPLATES[0].build('').includes('\n\n'));
  // 出全新 / 出闲置 carry no size line.
  assert.ok(TEMPLATES[1].build('尺码 S-XXL').includes('出全新'));
  assert.ok(TEMPLATES[2].build('尺码 S-XXL').includes('出闲置'));
  // 奥莱折扣 fills size line.
  assert.ok(TEMPLATES[3].build('尺码 S-XL').includes('部分 断码'));
});

test('sizeRange collapses to first-last', () => {
  assert.equal(sizeRange(['S', 'M', 'L', 'XL', 'XXL']), 'S-XXL');
  assert.equal(sizeRange(['S', 'M', 'L', 'XL']), 'S-XL');
  assert.equal(sizeRange(['M']), 'M');
  assert.equal(sizeRange([]), '');
  assert.equal(sizeRange(undefined), '');
});

test('feishuPatchForState derives columns from stage_evidence, not raw state', () => {
  // state is unreliable; the patch must come from stage_evidence.
  const generated = {
    sku: 'DX1488-100',
    state: 'READY_TO_GENERATE', // intentionally misleading; should be ignored
    stage_evidence: { completed_stages: ['ingest', 'config', 'generation', 'cover'], available_views: ['front', 'back'] },
    sources: [{ url: 'https://x.yupoo.com/a' }],
  };
  const patch = feishuPatchForState(generated);
  assert.equal(patch['图片生成'], OPT.图片生成.done);
  assert.equal(patch['四宫格'], OPT.四宫格.yes);
  assert.equal(patch['Yupoo链接'], 'https://x.yupoo.com/a');
  assert.ok(patch['备注'].includes('DX1488-100'));

  const partial = {
    sku: 'X',
    state: 'PUBLISHED', // misleading
    stage_evidence: { completed_stages: ['ingest'], available_views: [] },
  };
  const partialPatch = feishuPatchForState(partial);
  assert.equal(partialPatch['图片生成'], OPT.图片生成.none); // no generation stage, no views
  assert.equal(partialPatch['四宫格'], OPT.四宫格.no);
});

test('FEISHU_STATUS_OPTIONS uses the real Feishu option strings (not the stale old values)', () => {
  // Guard against the old feishuPatchForState bug that wrote '✅ 已生成' for 图片生成,
  // which is not a real option (real options are 已完成/进行中/未开始).
  assert.equal(OPT.图片生成.done, '✅ 已完成');
  assert.equal(OPT.图片生成.partial, '🔄 进行中');
  assert.equal(OPT.图片审核.passed, '✅ 已通过');
  assert.equal(OPT.价格写入.yes, '✅ 已写入');
  assert.equal(OPT.闲鱼文案.yes, '✅ 已生成');
  assert.equal(OPT.小红书文案.yes, '✅ 已生成');
});