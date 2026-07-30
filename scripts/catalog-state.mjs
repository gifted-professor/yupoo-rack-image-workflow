const LOCKED_STATES = new Set(['APPROVED', 'QUEUED', 'PUBLISHED']);

export function normalizeSku(value) {
  return String(value || '').trim().toUpperCase().replace(/\s+/g, '');
}

function sourceKey(source) {
  return String(source?.album_id || source?.url || '').trim();
}

function normalizeSource(source) {
  const pictureDates = [...new Set((source?.picture_dates || []).filter(Boolean))].sort();
  return {
    ...source,
    album_id: source?.album_id ? String(source.album_id) : null,
    url: source?.url || null,
    picture_dates: pictureDates,
    picture_date_min: source?.picture_date_min || pictureDates[0] || null,
    picture_date_max: source?.picture_date_max || pictureDates.at(-1) || null,
    in_range_picture_count: Number(source?.in_range_picture_count || 0),
  };
}

function mergeSources(existing = [], incoming = []) {
  const sources = new Map();
  for (const raw of [...existing, ...incoming]) {
    const source = normalizeSource(raw);
    const key = sourceKey(source);
    if (!key) continue;
    const previous = sources.get(key);
    sources.set(key, previous ? normalizeSource({
      ...previous,
      ...source,
      picture_dates: [...(previous.picture_dates || []), ...(source.picture_dates || [])],
      in_range_picture_count: Math.max(
        Number(previous.in_range_picture_count || 0),
        Number(source.in_range_picture_count || 0),
      ),
    }) : source);
  }
  return [...sources.values()].sort((left, right) => sourceKey(left).localeCompare(sourceKey(right)));
}

function legacySources(item) {
  if (!item?.yupoo_url) return [];
  const match = String(item.yupoo_url).match(/\/albums\/(\d+)/);
  return [{ album_id: match?.[1] || null, url: item.yupoo_url }];
}

export function mergeCatalog(existing = { version: 2, items: [] }, discovered = [], options = {}) {
  const now = options.now || new Date().toISOString();
  const bySku = new Map();
  for (const raw of existing.items || []) {
    const sku = normalizeSku(raw.sku);
    if (!sku) continue;
    bySku.set(sku, {
      ...raw,
      sku,
      state: raw.state || 'NEEDS_RECONCILIATION',
      sources: mergeSources(raw.sources || legacySources(raw), []),
    });
  }
  for (const raw of discovered || []) {
    const sku = normalizeSku(raw.sku);
    if (!sku) continue;
    const previous = bySku.get(sku);
    const incomingSources = raw.sources || (raw.url || raw.album_id ? [raw] : []);
    bySku.set(sku, {
      ...(previous || {}),
      ...raw,
      sku,
      state: previous?.state || raw.state || 'DISCOVERED',
      sources: mergeSources(previous?.sources || [], incomingSources),
      added_at: previous?.added_at || raw.added_at || now.slice(0, 10),
      updated_at: now,
    });
  }
  return {
    ...existing,
    version: 2,
    last_updated: now,
    items: [...bySku.values()].sort((left, right) => left.sku.localeCompare(right.sku)),
  };
}

export function isLockedState(state) {
  return LOCKED_STATES.has(String(state || '').toUpperCase());
}

export function assertForceScope({ force = false, skus = [] } = {}) {
  if (force && skus.length !== 1) {
    throw new Error('FORCE_REQUIRES_EXACTLY_ONE_SKU');
  }
}

export function assertTransition(previous, next, options = {}) {
  const from = String(previous || '').toUpperCase();
  const to = String(next || '').toUpperCase();
  if (!from || !to) throw new Error('STATE_REQUIRED');
  if (isLockedState(from) && from !== to && !(options.force === true && options.sku)) {
    throw new Error(`LOCKED_STATE_TRANSITION:${from}->${to}`);
  }
  if (options.force === true && !options.sku) throw new Error('FORCE_REQUIRES_SKU');
  return true;
}
