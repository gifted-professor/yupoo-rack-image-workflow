import { normalizeSku } from './catalog-state.mjs';

function scalar(value) {
  if (Array.isArray(value)) return value.length === 1 ? value[0] : value;
  return value;
}

export function parseFeishuRows(payload, fieldMap = {}) {
  const data = payload?.data || {};
  const fields = data.fields || [];
  const rows = data.data || [];
  const recordIds = data.record_id_list || [];
  const name = key => fieldMap[key] || key;
  const index = key => fields.indexOf(name(key));
  return rows.map((row, rowIndex) => {
    const get = key => {
      const position = index(key);
      return position >= 0 ? scalar(row[position]) : undefined;
    };
    return {
      record_id: recordIds[rowIndex] || null,
      sku: normalizeSku(get('SKU')),
      yupoo_url: get('Yupoo链接') || '',
      original_status: get('原图抓取') || null,
      generation_status: get('图片生成') || null,
      cover_status: get('四宫格') || null,
      review_status: get('图片审核') || null,
      raw: Object.fromEntries(fields.map((field, fieldIndex) => [field, row[fieldIndex]])),
    };
  }).filter(record => record.sku);
}

export function dedupeFeishuRecords(records) {
  const bySku = new Map();
  for (const record of records) {
    const previous = bySku.get(record.sku);
    if (!previous) {
      bySku.set(record.sku, { ...record, record_ids: record.record_id ? [record.record_id] : [] });
      continue;
    }
    const comparable = ['yupoo_url', 'original_status', 'generation_status', 'cover_status', 'review_status'];
    const conflicts = comparable.filter(key => previous[key] && record[key] && previous[key] !== record[key]);
    bySku.set(record.sku, {
      ...previous,
      record_ids: [...new Set([...previous.record_ids, record.record_id].filter(Boolean))],
      duplicate_count: Number(previous.duplicate_count || 1) + 1,
      conflicts: [...new Set([...(previous.conflicts || []), ...conflicts])],
    });
  }
  return [...bySku.values()].sort((left, right) => left.sku.localeCompare(right.sku));
}

export function feishuState(record) {
  const completed = String(record.original_status || '').includes('已完成');
  return completed ? 'INGESTED' : 'DISCOVERED';
}

export function planCatalogChanges(catalog, records) {
  const bySku = new Map((catalog.items || []).map(item => [normalizeSku(item.sku), item]));
  const changes = [];
  for (const record of records) {
    const existing = bySku.get(record.sku);
    if (!existing) {
      changes.push({ type: 'add', sku: record.sku, record });
      continue;
    }
    const currentUrl = existing.sources?.find(source => source.url)?.url || existing.yupoo_url || '';
    if (record.yupoo_url && record.yupoo_url !== currentUrl) {
      changes.push({ type: 'update_source', sku: record.sku, from: currentUrl, to: record.yupoo_url, record });
    }
  }
  return changes;
}

// 飞书表 tblUcslarq5iLEPB 状态列的真实单选项（来自 +field-list）。不要照旧值写——
// 表内「图片生成」选项是 已完成/进行中/未开始，不是「已生成」；「图片审核」是 已通过/需修复/待审核。
// 真正的写入入口是 scripts/push-catalog-status.mjs（基于 work/items 实物证据）。
export const FEISHU_STATUS_OPTIONS = {
  图片生成: { done: '✅ 已完成', partial: '🔄 进行中', none: '❌ 未开始' },
  四宫格: { yes: '✅ 已生成', no: '❌ 未生成' },
  图片审核: { passed: '✅ 已通过', repair: '🔧 需修复', pending: '❌ 待审核' },
  价格写入: { yes: '✅ 已写入', no: '❌ 未写入' },
  微购文案: { yes: '✅ 已生成', no: '❌ 未生成' },
  闲鱼文案: { yes: '✅ 已生成', no: '❌ 未生成' },
  小红书文案: { yes: '✅ 已生成', no: '❌ 未生成' },
};

// 基于 catalog item 的 stage_evidence 推导飞书状态列。
// 注意：catalog.state 不可信（sku-catalog.json description 自己声明 state 仅是待对账状态），
// 所以这里优先用 stage_evidence；本函数仅用于离线预览，真正回写以 push-catalog-status.mjs 为准。
export function feishuPatchForState(item, reviewUrlBase = 'http://127.0.0.1:8910/') {
  const stages = new Set(item.stage_evidence?.completed_stages || []);
  const available = item.stage_evidence?.available_views || [];
  const opt = FEISHU_STATUS_OPTIONS;
  const 图片生成 = stages.has('generation')
    ? opt.图片生成.done
    : available.length > 0 ? opt.图片生成.partial : opt.图片生成.none;
  return {
    '图片生成': 图片生成,
    '四宫格': stages.has('cover') ? opt.四宫格.yes : opt.四宫格.no,
    '微购文案': stages.has('draft') ? opt.微购文案.yes : opt.微购文案.no,
    'Yupoo链接': item.sources?.find(source => source.url)?.url || undefined,
    '备注': `本地阶段：${[...stages].join('/') || '未开始'}；审核台：${reviewUrlBase}?sku=${encodeURIComponent(item.sku)}`,
  };
}
