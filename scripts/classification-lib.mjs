import path from 'node:path';

const SIZE_ORDER = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL', '4XL', '5XL'];

function unique(values) {
  return [...new Set((values || []).filter(value => value !== null && value !== undefined && String(value).trim() !== ''))];
}

export function extractJsonObject(text) {
  const cleaned = String(text || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('vision response did not contain a JSON object');
    return JSON.parse(cleaned.slice(start, end + 1));
  }
}

export function sizesFromTitle(title) {
  const normalized = String(title || '').toUpperCase().replace(/[–—]/g, '-').replace(/2XL/g, 'XXL').replace(/XXXL/g, '3XL');
  const range = normalized.match(/(?:^|[^A-Z0-9])(XXS|XS|S|M|L|XL|XXL|3XL|4XL|5XL)\s*-\s*(XXS|XS|S|M|L|XL|XXL|3XL|4XL|5XL)(?![A-Z0-9])/);
  if (range) {
    const left = SIZE_ORDER.indexOf(range[1]);
    const right = SIZE_ORDER.indexOf(range[2]);
    if (left >= 0 && right >= left) return SIZE_ORDER.slice(left, right + 1);
  }
  return unique([...normalized.matchAll(/(?:^|[^A-Z0-9])(XXS|XS|S|M|L|XL|XXL|3XL|4XL|5XL)(?![A-Z0-9])/g)].map(match => match[1]));
}

export function titleFacts(title) {
  const value = String(title || '');
  const gender = value.includes('女') ? ['女子'] : value.includes('男') ? ['男子'] : [];
  const categoryRules = [
    [/防晒衣/, ['防晒外套', 'jacket']],
    [/梭织外套|夹克|外套/, ['梭织外套', 'jacket']],
    [/加绒长裤/, ['加绒长裤', 'pants']],
    [/针织长裤/, ['针织长裤', 'pants']],
    [/速干长裤/, ['速干长裤', 'pants']],
    [/梭织长裤|长裤/, ['长裤', 'pants']],
    [/速干短裤/, ['速干短裤', 'shorts']],
    [/短裤/, ['短裤', 'shorts']],
    [/速干短袖/, ['速干短袖T恤', 'shirt']],
    [/短袖T恤|短袖|T恤/, ['短袖T恤', 'shirt']],
    [/卫衣/, ['卫衣', 'jacket']],
    [/背心/, ['背心', 'shirt']],
  ];
  const match = categoryRules.find(([pattern]) => pattern.test(value));
  return {
    gender,
    category: match?.[1]?.[0] || '服装',
    product_type: match?.[1]?.[1] || 'apparel',
    sizes: sizesFromTitle(value),
  };
}

function integerIndices(value, imageCount) {
  return unique((Array.isArray(value) ? value : [value])
    .map(item => Number(item))
    .filter(item => Number.isInteger(item) && item >= 1 && item <= imageCount));
}

function cleanStrings(value) {
  return unique((Array.isArray(value) ? value : value ? [value] : []).map(item => String(item).trim()));
}

export function normalizeVisionClassification({ sku, title, imageCount, parsed }) {
  const titleDerived = titleFacts(title);
  const brandInput = String(parsed.brand || '').toLowerCase().trim();
  const brand = brandInput.includes('jordan') ? 'jordan'
    : brandInput.includes('nike') || brandInput.includes('耐克') ? 'nike'
      : brandInput.includes('adidas') || brandInput.includes('阿迪') ? 'adidas'
        : brandInput === 'unknown' || brandInput === '未确认' || brandInput === '未知' ? 'unknown'
        : '';
  if (!brand) throw new Error(`${sku}: unsupported or uncertain brand: ${parsed.brand || '(empty)'}`);

  const rolesInput = parsed.roles && typeof parsed.roles === 'object' ? parsed.roles : parsed;
  const frontFull = integerIndices(rolesInput.front_full, imageCount);
  const rawBackFull = integerIndices(rolesInput.back_full, imageCount);
  const backDetail = integerIndices(rolesInput.back_structure_detail, imageCount);
  // Some Yupoo albums only contain a rear upper-body/product detail rather
  // than a full rear shot. Preserve that evidence explicitly and allow the
  // downstream prompt to hide the unobserved lower section; never invent a
  // missing back panel.
  const backFull = rawBackFull.length ? rawBackFull : backDetail.slice(0, 1);
  if (!frontFull.length) throw new Error(`${sku}: no defensible front_full image`);
  if (!backFull.length) throw new Error(`${sku}: no defensible back_full or rear-detail image`);
  const colorAuthorityCandidates = integerIndices(parsed.color_authority, imageCount);
  const colorAuthority = colorAuthorityCandidates[0] || frontFull[0];

  const confidence = Number(parsed.confidence);
  if (!Number.isFinite(confidence) || confidence < 0.55) {
    throw new Error(`${sku}: visual classification confidence below 0.55`);
  }
  const productType = ['shirt', 'jacket', 'pants', 'shorts', 'skirt', 'dress'].includes(parsed.product_type)
    ? parsed.product_type
    : titleDerived.product_type;
  const brandDisplay = brand === 'adidas' ? 'adidas阿迪达斯'
    : brand === 'jordan' ? 'Jordan乔丹'
      : brand === 'nike' ? 'NIKE耐克'
        : '未确认品牌';
  const featureFacts = parsed.facts && typeof parsed.facts === 'object' ? parsed.facts : {};

  return {
    classification: {
      sku,
      brand,
      product_type: productType,
      review_state: 'draft',
      reference_image_status: 'usable_model_worn',
      color_authority: colorAuthority,
      facts: {
        brand_display: brandDisplay,
        official_url: null,
        official_title: null,
        season: [],
        gender: titleDerived.gender,
        product_line: cleanStrings(featureFacts.product_line),
        category: titleDerived.category,
        materials: cleanStrings(featureFacts.materials),
        features: cleanStrings(featureFacts.features),
        use_cases: cleanStrings(featureFacts.use_cases),
        styles: cleanStrings(featureFacts.styles),
        sizes: titleDerived.sizes,
        colors: cleanStrings(featureFacts.colors || parsed.colors || parsed.color),
        tags: [],
      },
      roles: {
        front_full: frontFull,
        back_full: backFull,
        logo_detail: integerIndices(rolesInput.logo_detail, imageCount),
        front_structure_detail: integerIndices(rolesInput.front_structure_detail, imageCount),
        back_structure_detail: backDetail.length
          ? backDetail
          : backFull.slice(0, 1),
        shared_structure_detail: integerIndices(rolesInput.shared_structure_detail, imageCount),
        collar_detail: integerIndices(rolesInput.collar_detail, imageCount),
        hem_pocket_detail: integerIndices(rolesInput.hem_pocket_detail, imageCount),
        sleeve_detail: integerIndices(rolesInput.sleeve_detail, imageCount),
        fabric_detail: integerIndices(rolesInput.fabric_detail, imageCount),
        tag_detail: integerIndices(rolesInput.tag_detail, imageCount),
        invalid_or_uncertain: integerIndices(rolesInput.invalid_or_uncertain, imageCount),
      },
    },
    evidence: {
      confidence,
      rationale: cleanStrings(parsed.rationale),
      observed_details: cleanStrings(parsed.observed_details),
      warnings: cleanStrings([
        ...cleanStrings(parsed.warnings),
        brand === 'unknown' ? 'BRAND_UNCONFIRMED: no readable brand evidence; use neutral scenes and require manual confirmation before publishing' : '',
        confidence < 0.7 ? 'LOW_CONFIDENCE: visual classification requires manual confirmation in 8910' : '',
        rawBackFull.length ? '' : 'BACK_VIEW_PARTIAL: only a rear detail was available; do not invent unseen lower-back structure',
      ]),
    },
  };
}

export function classificationPrompt({ sku, title, imageCount }) {
  return `You are classifying a Yupoo apparel contact sheet for grounded image generation. Inspect every numbered tile (#01..#${String(imageCount).padStart(2, '0')}). Return one strict JSON object and no prose.

SKU: ${sku}
Album title: ${title}

Required schema:
{
  "brand": "nike|adidas|jordan|unknown",
  "product_type": "shirt|jacket|pants|shorts|skirt|dress",
  "color_authority": 1,
  "color": "short Chinese color description",
  "confidence": 0.0,
  "rationale": ["which numbered tiles prove front, back, color, and brand"],
  "observed_details": ["only visible garment details that image generation must preserve"],
  "warnings": [],
  "facts": {
    "colors": [], "materials": [], "features": [], "use_cases": [], "styles": [], "product_line": []
  },
  "roles": {
    "front_full": [], "back_full": [], "logo_detail": [],
    "front_structure_detail": [], "back_structure_detail": [], "shared_structure_detail": [],
    "collar_detail": [], "hem_pocket_detail": [], "sleeve_detail": [],
    "fabric_detail": [], "tag_detail": [], "invalid_or_uncertain": []
  }
}

Rules:
- Tile numbers are 1-based and must be between 1 and ${imageCount}.
- front_full means the garment front is clearly visible; back_full means the actual rear panel is clearly visible.
- Never call a crop/detail a full view when a more complete tile exists.
- color_authority must be the single clearest, neutrally lit full-garment tile.
- Do not infer hidden graphics or structure. Put unclear tiles in invalid_or_uncertain.
- Brand must be proven by visible logo/design, not by the account name.
- confidence below 0.70 is required whenever either front/back/brand is uncertain.`;
}

export function projectRelative(projectRoot, absolute) {
  return path.relative(projectRoot, absolute);
}
