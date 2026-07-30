const state = {
  products: [],
  destinations: {},
  destination: 'all',
  status: 'all',
  query: '',
  activeProduct: null,
  activeDestination: 'szwego',
};

const labels = {
  front: '货架正面',
  back: '货架背面',
  tryon_main: '试穿主图',
  tryon_detail: '试穿近景',
  tryon_back: '试穿背面',
};

const elements = {
  grid: document.querySelector('#productGrid'),
  resultCount: document.querySelector('#resultCount'),
  summary: document.querySelector('#summaryNumbers'),
  destinationFilter: document.querySelector('#destinationFilter'),
  statusFilter: document.querySelector('#statusFilter'),
  search: document.querySelector('#searchInput'),
  dialog: document.querySelector('#reviewDialog'),
  dialogContent: document.querySelector('#dialogContent'),
  dialogClose: document.querySelector('#dialogClose'),
  toast: document.querySelector('#toast'),
};

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]);
}

function statusText(product) {
  if (product.latest_signal?.decision === 'APPROVED') return '已确认';
  if (product.can_approve) return '待你确认';
  return '资料受阻';
}

function statusClass(product) {
  if (product.latest_signal?.decision === 'APPROVED') return 'approved';
  return product.can_approve ? 'reviewable' : 'blocked';
}

function filteredProducts() {
  return state.products.filter(product => {
    const haystack = `${product.sku} ${product.title} ${product.category}`.toLowerCase();
    const queryMatches = !state.query || haystack.includes(state.query.toLowerCase());
    const destinationMatches = state.destination === 'all'
      || product.destinations.some(destination => destination.id === state.destination);
    const productStatus = statusClass(product);
    const statusMatches = state.status === 'all' || state.status === productStatus;
    return queryMatches && destinationMatches && statusMatches;
  });
}

function destinationChips(product) {
  return product.destinations.map(destination => `
    <span class="destination-chip destination-chip--${destination.id}" title="${escapeHtml(destination.state)}">
      ${escapeHtml(destination.short_label)}
      <i class="connector connector--${escapeHtml(destination.connector_status)}"></i>
    </span>
  `).join('');
}

function renderSummary() {
  const reviewable = state.products.filter(product => product.can_approve).length;
  const approved = state.products.filter(product => product.latest_signal?.decision === 'APPROVED').length;
  elements.summary.innerHTML = `
    <div><strong>${String(state.products.length).padStart(2, '0')}</strong><span>商品</span></div>
    <div><strong>${String(reviewable).padStart(2, '0')}</strong><span>可确认</span></div>
    <div><strong>${String(approved).padStart(2, '0')}</strong><span>已入队</span></div>
  `;
}

function renderFilters() {
  const destinationButtons = [
    ['all', '全部目的地'],
    ...Object.entries(state.destinations).map(([id, item]) => [id, item.label]),
  ];
  elements.destinationFilter.innerHTML = destinationButtons.map(([id, label]) => `
    <button class="filter-button ${state.destination === id ? 'is-active' : ''}" data-destination="${id}">
      ${escapeHtml(label)}
    </button>
  `).join('');
  elements.destinationFilter.querySelectorAll('[data-destination]').forEach(button => {
    button.addEventListener('click', () => {
      state.destination = button.dataset.destination;
      renderFilters();
      renderCards();
    });
  });
}

function renderCards() {
  const products = filteredProducts();
  elements.resultCount.textContent = String(products.length).padStart(2, '0');
  elements.grid.innerHTML = products.length ? products.map((product, index) => `
    <article class="product-card" data-sku="${escapeHtml(product.sku)}" style="--delay:${index * 34}ms" tabindex="0">
      <div class="card-media">
        ${product.thumbnail ? `<img src="${product.thumbnail}" alt="${escapeHtml(product.sku)} 正面商品图" loading="lazy">` : '<div class="media-empty">NO IMAGE</div>'}
        <div class="card-number">${String(index + 1).padStart(2, '0')}</div>
        <div class="card-status card-status--${statusClass(product)}">${statusText(product)}</div>
      </div>
      <div class="card-body">
        <div class="card-destinations">${destinationChips(product)}</div>
        <p class="card-sku">${escapeHtml(product.sku)}</p>
        <h3>${escapeHtml(product.short_name)}</h3>
        <div class="card-meta">
          <span>¥${Number(product.sale_price || 0).toFixed(0)}</span>
          <span>${product.images.filter(image => image.url).length}/5 图</span>
          <span>${product.blockers.length} 阻断</span>
        </div>
      </div>
      <div class="card-open">打开审核 <span>↗</span></div>
    </article>
  `).join('') : '<div class="empty-state"><strong>没有匹配商品</strong><span>换一个货号或筛选条件</span></div>';
  elements.grid.querySelectorAll('.product-card').forEach(card => {
    const open = () => openProduct(card.dataset.sku);
    card.addEventListener('click', open);
    card.addEventListener('keydown', event => { if (event.key === 'Enter') open(); });
  });
}

function galleryMarkup(product) {
  return product.images.map(image => {
    const imageUrl = image.display_url || image.url;
    const finalVisible = product.latest_signal?.decision === 'APPROVED' && image.final_url;
    const imageState = finalVisible
      ? (image.view === 'front' || image.view === 'back' ? '发布成品 · 已写价' : '发布成品')
      : (image.price_preview_url ? '价格预览 · 待确认' : (image.view === 'front' || image.view === 'back' ? '价格预览生成中' : image.approval_status));
    return `
    <figure class="review-image ${imageUrl ? '' : 'review-image--missing'}">
      ${imageUrl ? `<img src="${imageUrl}" alt="${escapeHtml(labels[image.view])}">` : '<div>缺少图片</div>'}
      <figcaption>
        <span>${escapeHtml(labels[image.view])}</span>
        <i>${escapeHtml(imageState)}</i>
      </figcaption>
    </figure>
  `;
  }).join('');
}

function destinationPanel(product) {
  const destination = product.destinations.find(item => item.id === state.activeDestination);
  if (!destination) return '';
  if (destination.id === 'xiaohongshu') return `
    <div class="destination-note destination-note--planned">
      <span>连接器状态</span><strong>待接入</strong>
      <p>这里将复用同一商品事实与图片，但小红书标题、正文、话题和图片排序会拥有独立预览。</p>
    </div>
  `;
  const unresolved = product.unresolved_blockers;
  const approvalState = product.latest_signal?.destination === destination.id
    ? product.latest_signal.queue_state
    : null;
  return `
    <div class="publish-preview">
      <div class="preview-price"><span>销售价</span><strong>¥${Number(product.sale_price || 0).toFixed(0)}</strong><small>拿货 ¥${Number(product.cost_price || 0).toFixed(0)}</small></div>
      <dl>
        <div><dt>标签</dt><dd>${product.tags.map(tag => `<span>${escapeHtml(tag)}</span>`).join('') || '—'}</dd></div>
        <div><dt>颜色</dt><dd>${product.colors.map(color => `<span>${escapeHtml(color)}</span>`).join('') || '—'}</dd></div>
        <div><dt>尺码</dt><dd>${product.sizes.map(size => `<span>${escapeHtml(size)}</span>`).join('') || '—'}</dd></div>
        <div><dt>库存</dt><dd>${product.variants.length ? `${product.inventory_total} 件` : '待确认'}</dd></div>
        <div><dt>运费</dt><dd>${escapeHtml(product.shipping?.template_name || '未设置')}</dd></div>
      </dl>
    </div>
    <div class="approval-box">
      <span class="approval-kicker">FINAL HUMAN GATE</span>
      <h4>${approvalState ? '确认信号已收到' : product.can_approve ? '资料完整，可以确认' : '还有问题需要处理'}</h4>
      ${approvalState ? `<p>队列状态：${escapeHtml(approvalState)}</p>` : ''}
      ${unresolved.length ? `<ul>${unresolved.map(blocker => `<li>${escapeHtml(blocker)}</li>`).join('')}</ul>` : `<p>本次确认会先把 ¥${Number(product.sale_price || 0).toFixed(0)} 写入正面、背面货架图的实体价格牌；两张都验证成功后，五张成品才会加入微购发送队列。</p>`}
      <p>页面价格预览：${product.price_preview_ready ? '正反面均已显示真实售价' : '正在生成'}；发布价格图：${product.price_image_ready ? '已定稿' : '待最终确认'}。空白价格牌禁止入队。</p>
      <label class="approval-note">备注（可选）<textarea id="approvalNote" maxlength="500" placeholder="例如：标题保留，价格确认"></textarea></label>
      <button class="approve-button" id="approveButton" ${product.can_approve && !approvalState ? '' : 'disabled'}>
        ${approvalState ? '已经确认' : '确认、写价并加入发送队列'}
      </button>
      <small>当前微购连接器为 dry-run；写价或成品校验失败时不会入队，也不会伪装成已发布。</small>
    </div>
  `;
}

function renderDialog(product) {
  const xhsCover = product.xhs_cover;
  elements.dialogContent.innerHTML = `
    <div class="dialog-header">
      <div><span class="eyebrow">SKU / ${escapeHtml(product.sku)}</span><h2>${escapeHtml(product.title)}</h2></div>
      <div class="dialog-price">¥${Number(product.sale_price || 0).toFixed(0)}</div>
    </div>
    <div class="dialog-layout">
      <section class="visual-review">
        <div class="section-label"><span>01</span><h3>生成图审核</h3><i>${product.images.filter(image => image.url).length}/5</i></div>
        <div class="review-gallery">${galleryMarkup(product)}</div>
        ${xhsCover ? `
        <div class="xhs-cover-section">
          <div class="section-label"><span>02</span><h3>小红书四宫格</h3><i>${xhsCover.status}</i></div>
          <figure class="review-image xhs-cover-preview">
            <img src="${xhsCover.url}" alt="小红书四宫格封面">
            <figcaption>
              <span>四宫格封面</span>
              <i>${xhsCover.status === 'REVIEW_PENDING' ? '待审核' : xhsCover.status}</i>
            </figcaption>
          </figure>
        </div>
        ` : ''}
        <div class="copy-sheet">
          <div class="section-label"><span>${xhsCover ? '03' : '02'}</span><h3>发布文案</h3></div>
          <h4>${escapeHtml(product.title)}</h4>
          <p>${escapeHtml(product.description || '暂无描述')}</p>
        </div>
        <div class="variant-sheet">
          <div class="section-label"><span>03</span><h3>规格与库存</h3></div>
          <div class="variant-grid">
            ${product.variants.length
              ? product.variants.map(variant => `<div><strong>${escapeHtml(variant.color)} / ${escapeHtml(variant.size)}</strong><span>${variant.inventory} 件</span></div>`).join('')
              : '<p class="variant-empty">颜色或尺码尚未确认，暂不生成规格与库存。</p>'}
          </div>
        </div>
      </section>
      <aside class="dispatch-review">
        <div class="destination-tabs">
          ${product.destinations.map(destination => `<button data-dialog-destination="${destination.id}" class="${state.activeDestination === destination.id ? 'is-active' : ''}">${escapeHtml(destination.label)}</button>`).join('')}
        </div>
        <div id="destinationPanel">${destinationPanel(product)}</div>
      </aside>
    </div>
  `;
  elements.dialogContent.querySelectorAll('[data-dialog-destination]').forEach(button => {
    button.addEventListener('click', () => {
      state.activeDestination = button.dataset.dialogDestination;
      renderDialog(product);
    });
  });
  const approveButton = elements.dialogContent.querySelector('#approveButton');
  if (approveButton && !approveButton.disabled) approveButton.addEventListener('click', approveActiveProduct);
}

async function openProduct(sku) {
  const response = await fetch(`/api/products/${encodeURIComponent(sku)}`);
  if (!response.ok) throw new Error(`商品加载失败：${response.status}`);
  state.activeProduct = await response.json();
  state.activeDestination = 'szwego';
  renderDialog(state.activeProduct);
  if (!elements.dialog.open) elements.dialog.showModal();
  document.body.classList.add('dialog-open');
}

async function approveActiveProduct() {
  const product = state.activeProduct;
  const destination = state.activeDestination;
  if (!window.confirm(`确认 ${product.sku} 的商品事实与五张图片？系统会先把 ¥${Number(product.sale_price || 0).toFixed(0)} 写入正反面实体价格牌，验证成功后再加入${state.destinations[destination].label}发送队列。`)) return;
  const note = document.querySelector('#approvalNote')?.value || '';
  const response = await fetch(`/api/products/${encodeURIComponent(product.sku)}/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ destination, revision: product.revision, confirmed: true, note }),
  });
  const result = await response.json();
  if (!response.ok) return showToast(`确认失败：${result.detail || result.error || '未知错误'}`);
  showToast('正反面价格已写入并验证，商品已加入发送队列');
  await loadProducts();
  await openProduct(product.sku);
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add('is-visible');
  window.setTimeout(() => elements.toast.classList.remove('is-visible'), 3200);
}

async function loadProducts() {
  const response = await fetch('/api/products');
  if (!response.ok) throw new Error(`商品列表加载失败：${response.status}`);
  const data = await response.json();
  state.products = data.products;
  state.destinations = data.destinations;
  renderSummary();
  renderFilters();
  renderCards();
}

async function refreshVisibleProducts() {
  await loadProducts();
  if (!elements.dialog.open || !state.activeProduct?.sku) return;
  const response = await fetch(`/api/products/${encodeURIComponent(state.activeProduct.sku)}`);
  if (!response.ok) return;
  state.activeProduct = await response.json();
  renderDialog(state.activeProduct);
}

elements.search.addEventListener('input', event => { state.query = event.target.value.trim(); renderCards(); });
elements.statusFilter.addEventListener('change', event => { state.status = event.target.value; renderCards(); });
elements.dialogClose.addEventListener('click', () => elements.dialog.close());
elements.dialog.addEventListener('close', () => document.body.classList.remove('dialog-open'));
elements.dialog.addEventListener('click', event => { if (event.target === elements.dialog) elements.dialog.close(); });

loadProducts().catch(error => {
  elements.grid.innerHTML = `<div class="empty-state"><strong>加载失败</strong><span>${escapeHtml(error.message)}</span></div>`;
});

window.setInterval(() => {
  refreshVisibleProducts().catch(() => {});
}, 30 * 1000);
