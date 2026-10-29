// Vanilla JS SPA — no build step, no framework. Every view fetches real
// data from the /api/* endpoints, which read the real Postgres database
// through the same repository modules the crawler/batch/scheduler use.

const content = document.getElementById('content');
const dbStatusEl = document.getElementById('dbStatus');

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function el(html) {
  const template = document.createElement('template');
  template.innerHTML = html.trim();
  return template.content.firstElementChild;
}

function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function statusPill(status) {
  const map = {
    succeeded: 'pass', completed: 'pass', approved: 'pass',
    pending: 'partial', processing: 'partial', retrying: 'partial', pending_review: 'partial',
    failed: 'blocked', dead_letter: 'blocked', rejected: 'blocked', ACCESS_DENIED: 'blocked', ROBOTS_DISALLOWED: 'blocked'
  };
  const cls = map[status] || 'na';
  return `<span class="pill ${cls}">${escapeHtml(status ?? '—')}</span>`;
}

function fmtDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString();
}

async function withErrorBoundary(renderFn) {
  content.innerHTML = '<div class="loading">Loading…</div>';
  try {
    await renderFn();
  } catch (error) {
    content.innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
  }
}

// ---------- Dashboard ----------
async function renderDashboard() {
  const data = await api('/api/dashboard');
  content.innerHTML = `
    <h1>Dashboard</h1>
    <div class="statgrid">
      <div class="stat"><div class="n">${data.totalProducts}</div><div class="l">Products</div></div>
      <div class="stat"><div class="n">${data.crawlQueue.pending}</div><div class="l">Queue pending</div></div>
      <div class="stat"><div class="n">${data.crawlQueue.processing}</div><div class="l">Queue processing</div></div>
      <div class="stat"><div class="n">${data.crawlQueue.dead_letter}</div><div class="l">Queue dead-letter</div></div>
      <div class="stat"><div class="n">${data.aiReview.pendingExceptions}</div><div class="l">AI exceptions pending</div></div>
      <div class="stat"><div class="n">${data.aiReview.pendingStaging}</div><div class="l">Staging pending</div></div>
      <div class="stat"><div class="n">${data.sources.blocked}/${data.sources.total}</div><div class="l">Sources blocked</div></div>
      <div class="stat"><div class="n">${data.imageQueue.succeeded}</div><div class="l">Images stored</div></div>
    </div>
    ${data.sources.blockedSources.length ? `<h2>Blocked sources</h2><p class="mono">${data.sources.blockedSources.map(escapeHtml).join(', ')}</p>` : ''}
  `;
}

// ---------- Products ----------
async function renderProducts(search = '') {
  const data = await api(`/api/products?search=${encodeURIComponent(search)}&limit=50`);
  const rows = data.products.map((p) => `
    <tr>
      <td class="mono">${escapeHtml(p.item_number)}</td>
      <td>${escapeHtml(p.product_name)}</td>
      <td>${escapeHtml(p.varietal)}</td>
      <td>${escapeHtml(p.region)}</td>
      <td>${escapeHtml(p.price)} ${escapeHtml(p.currency)}</td>
      <td>${escapeHtml(p.source_site)}</td>
      <td class="mono">${fmtDate(p.updated_at)}</td>
      <td><a href="#" data-open-product="${escapeHtml(p.item_number)}">view</a></td>
    </tr>`).join('') || '<tr><td colspan="8" class="empty">No products found.</td></tr>';

  content.innerHTML = `
    <h1>Products (${data.total})</h1>
    <input type="search" id="productSearch" placeholder="search item number / name / producer / varietal" value="${escapeHtml(search)}" style="width:340px;margin-bottom:1rem;">
    <div class="tablewrap"><table><thead><tr><th>Item #</th><th>Name</th><th>Varietal</th><th>Region</th><th>Price</th><th>Source</th><th>Updated</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
    <div id="productDetail"></div>
  `;
  document.getElementById('productSearch').addEventListener('input', (e) => {
    clearTimeout(window.__searchDebounce);
    window.__searchDebounce = setTimeout(() => renderProducts(e.target.value), 300);
  });
  content.querySelectorAll('[data-open-product]').forEach((a) => a.addEventListener('click', async (e) => {
    e.preventDefault();
    const itemNumber = a.getAttribute('data-open-product');
    const detail = await api(`/api/products/${encodeURIComponent(itemNumber)}`);
    document.getElementById('productDetail').innerHTML = `
      <div class="card">
        <h2 style="margin-top:0">${escapeHtml(detail.product.product_name)} <span class="mono">(${escapeHtml(itemNumber)})</span></h2>
        <p class="mono">${escapeHtml(JSON.stringify(detail.product, null, 2))}</p>
        <h2>Images (${detail.images.length})</h2>
        ${detail.images.map((img) => `<p class="mono">${escapeHtml(img.role)} ${img.isPrimary ? '(primary)' : ''} — ${escapeHtml(img.image.storagePath)} ${img.image.width}x${img.image.height}</p>`).join('') || '<p class="empty">none</p>'}
        <h2>AI exceptions (${detail.aiExceptions.length})</h2>
        ${detail.aiExceptions.map((ex) => `<p>${escapeHtml(ex.fieldName)}: "${escapeHtml(ex.currentValue)}" → "${escapeHtml(ex.suggestedValue)}" (${ex.confidence}%) ${statusPill(ex.status)}</p>`).join('') || '<p class="empty">none</p>'}
      </div>`;
  }));
}

// ---------- Crawls ----------
async function renderCrawls() {
  const data = await api('/api/crawls/recent?limit=25');
  const rows = data.jobs.map((j) => `
    <tr><td class="mono">${escapeHtml(j.itemNumber)}</td><td>${escapeHtml(j.sourceName)}</td><td>${statusPill(j.status)}</td>
      <td>${escapeHtml(j.lastErrorType)}</td><td>${j.attempts}/${j.maxAttempts}</td><td class="mono">${fmtDate(j.updatedAt)}</td></tr>`).join('')
    || '<tr><td colspan="6" class="empty">No crawl jobs yet.</td></tr>';

  content.innerHTML = `
    <h1>Crawls</h1>
    <div class="card">
      <h2 style="margin-top:0">Start a single-product crawl (real fixture source)</h2>
      <form id="singleCrawlForm">
        <input name="item_number" placeholder="item_number" required>
        <input name="item_name" placeholder="item_name" required>
        <input name="size" placeholder="size (e.g. 750ml)" required>
        <input name="url" placeholder="source URL" required style="width:320px">
        <button class="btn primary" type="submit">Run crawl</button>
      </form>
      <div id="crawlResult"></div>
    </div>
    <h2>Recent jobs</h2>
    <div class="tablewrap"><table><thead><tr><th>Item #</th><th>Source</th><th>Status</th><th>Last error</th><th>Attempts</th><th>Updated</th></tr></thead><tbody>${rows}</tbody></table></div>
  `;
  document.getElementById('singleCrawlForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    const resultEl = document.getElementById('crawlResult');
    resultEl.innerHTML = '<p class="loading">Running…</p>';
    try {
      const result = await api('/api/crawls/single', {
        method: 'POST',
        body: JSON.stringify({
          item_number: form.get('item_number'), item_name: form.get('item_name'), size: form.get('size'),
          source: { name: 'example-source', url: form.get('url') }
        })
      });
      resultEl.innerHTML = `<p class="mono">${escapeHtml(JSON.stringify(result, null, 2))}</p>`;
      renderCrawls();
    } catch (error) {
      resultEl.innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
    }
  });
}

// ---------- Queue ----------
async function renderQueue() {
  const data = await api('/api/queue');
  function counts(c) {
    return `<div class="statgrid">${Object.entries(c).map(([k, v]) => `<div class="stat"><div class="n">${v}</div><div class="l">${escapeHtml(k)}</div></div>`).join('')}</div>`;
  }
  const deadRows = data.recentDeadLetter.map((d) => `<tr><td class="mono">${escapeHtml(d.item_number)}</td><td>${escapeHtml(d.source_name)}</td><td>${escapeHtml(d.reason)}</td><td class="mono">${fmtDate(d.failed_at)}</td></tr>`).join('')
    || '<tr><td colspan="4" class="empty">No dead-lettered jobs.</td></tr>';

  content.innerHTML = `
    <h1>Queue</h1>
    <h2>Crawl queue</h2>${counts(data.crawlQueue)}
    <h2>Image queue</h2>${counts(data.imageQueue)}
    <h2>Recent dead-letter</h2>
    <div class="tablewrap"><table><thead><tr><th>Item #</th><th>Source</th><th>Reason</th><th>Failed at</th></tr></thead><tbody>${deadRows}</tbody></table></div>
  `;
}

// ---------- AI Review ----------
async function renderAi() {
  const [exceptions, staging] = await Promise.all([api('/api/ai/exceptions'), api('/api/ai/staging')]);
  const excRows = exceptions.exceptions.map((ex) => `
    <tr><td class="mono">${escapeHtml(ex.itemNumber)}</td><td>${escapeHtml(ex.fieldName)}</td><td>${escapeHtml(ex.currentValue)}</td>
      <td>${escapeHtml(ex.suggestedValue)}</td><td>${ex.confidence}%</td><td>${escapeHtml(ex.reason)}</td>
      <td class="row-actions"><button class="btn primary" data-approve-exc="${ex.id}">Approve</button><button class="btn danger" data-reject-exc="${ex.id}">Reject</button></td></tr>`).join('')
    || '<tr><td colspan="7" class="empty">No pending AI exceptions.</td></tr>';

  const stagingRows = staging.staging.map((s) => `
    <tr><td class="mono">${escapeHtml(s.itemNumber)}</td><td>${escapeHtml(s.sourceSite)}</td><td>${escapeHtml(s.aiMetadata?.provider)}</td>
      <td class="row-actions"><button class="btn primary" data-approve-staging="${s.id}">Approve</button><button class="btn danger" data-reject-staging="${s.id}">Reject</button></td></tr>`).join('')
    || '<tr><td colspan="4" class="empty">No pending staging records.</td></tr>';

  content.innerHTML = `
    <h1>AI Review</h1>
    <h2>Validation exceptions (existing products)</h2>
    <div class="tablewrap"><table><thead><tr><th>Item #</th><th>Field</th><th>Current</th><th>Suggested</th><th>Confidence</th><th>Reason</th><th></th></tr></thead><tbody>${excRows}</tbody></table></div>
    <h2>Staged records (new crawls awaiting approval)</h2>
    <div class="tablewrap"><table><thead><tr><th>Item #</th><th>Source</th><th>AI provider</th><th></th></tr></thead><tbody>${stagingRows}</tbody></table></div>
  `;

  const reviewer = () => prompt('Reviewer name/email:') || null;
  content.querySelectorAll('[data-approve-exc]').forEach((b) => b.addEventListener('click', async () => {
    const r = reviewer(); if (!r) return;
    await api(`/api/ai/exceptions/${b.dataset.approveExc}/approve`, { method: 'POST', body: JSON.stringify({ reviewer: r }) });
    renderAi();
  }));
  content.querySelectorAll('[data-reject-exc]').forEach((b) => b.addEventListener('click', async () => {
    const r = reviewer(); if (!r) return;
    await api(`/api/ai/exceptions/${b.dataset.rejectExc}/reject`, { method: 'POST', body: JSON.stringify({ reviewer: r }) });
    renderAi();
  }));
  content.querySelectorAll('[data-approve-staging]').forEach((b) => b.addEventListener('click', async () => {
    const r = reviewer(); if (!r) return;
    await api(`/api/ai/staging/${b.dataset.approveStaging}/approve`, { method: 'POST', body: JSON.stringify({ reviewer: r }) });
    renderAi();
  }));
  content.querySelectorAll('[data-reject-staging]').forEach((b) => b.addEventListener('click', async () => {
    const r = reviewer(); if (!r) return;
    const reason = prompt('Rejection reason:'); if (!reason) return;
    await api(`/api/ai/staging/${b.dataset.rejectStaging}/reject`, { method: 'POST', body: JSON.stringify({ reviewer: r, reason }) });
    renderAi();
  }));
}

// ---------- Sources ----------
async function renderSources() {
  const data = await api('/api/sources');
  const rows = data.sources.map((s) => `
    <tr><td class="mono">${escapeHtml(s.sourceName)}</td>
      <td>${s.lastAttempted ? statusPill(s.lastAttempted.errorType || s.lastAttempted.status) : '<span class="pill na">never attempted</span>'}</td>
      <td>${escapeHtml(s.lastAttempted?.errorMessage) || '—'}</td>
      <td>${s.compliance ? statusPill(s.compliance.tosReviewStatus) : '—'}</td>
      <td>${s.compliance ? (s.compliance.enabledInProduction ? 'yes' : 'no') : '—'}</td>
      <td class="mono">${fmtDate(s.lastAttempted?.at)}</td></tr>`).join('');

  content.innerHTML = `
    <h1>Sources</h1>
    <div class="tablewrap"><table><thead><tr><th>Source</th><th>Status</th><th>Last error</th><th>ToS review</th><th>Enabled in prod</th><th>Last attempted</th></tr></thead><tbody>${rows}</tbody></table></div>
  `;
}

// ---------- Images ----------
async function renderImages() {
  const data = await api('/api/images?limit=50');
  const rows = data.images.map((img) => `
    <tr><td class="mono">${escapeHtml(img.contentHash?.slice(0, 16))}…</td><td>${escapeHtml(img.format)}</td><td>${img.width}x${img.height}</td>
      <td>${img.byteSize} bytes</td><td>${img.references.map((r) => `${escapeHtml(r.itemNumber)}${r.isPrimary ? ' ★' : ''}`).join(', ') || '—'}</td></tr>`).join('')
    || '<tr><td colspan="5" class="empty">No images stored yet.</td></tr>';

  content.innerHTML = `
    <h1>Images (${data.total})</h1>
    <div class="tablewrap"><table><thead><tr><th>Content hash</th><th>Format</th><th>Dimensions</th><th>Size</th><th>Referenced by</th></tr></thead><tbody>${rows}</tbody></table></div>
  `;
}

// ---------- Admin ----------
async function renderAdmin() {
  const data = await api('/api/admin/status');
  if (!data.database.configured) {
    content.innerHTML = '<h1>Database / Admin</h1><div class="error">DATABASE_URL is not configured.</div>';
    return;
  }
  const rows = Object.entries(data.database.tableCounts).map(([table, n]) => `<tr><td class="mono">${escapeHtml(table)}</td><td>${n}</td></tr>`).join('');
  content.innerHTML = `
    <h1>Database / Admin</h1>
    <p><span class="pill pass">connected</span></p>
    <div class="tablewrap"><table><thead><tr><th>Table</th><th>Rows</th></tr></thead><tbody>${rows}</tbody></table></div>
  `;
}

const VIEWS = {
  dashboard: renderDashboard, products: () => renderProducts(''), crawls: renderCrawls,
  queue: renderQueue, ai: renderAi, sources: renderSources, images: renderImages, admin: renderAdmin
};

document.querySelectorAll('.navitem').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.navitem').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    withErrorBoundary(VIEWS[btn.dataset.view]);
  });
});

async function checkDbStatus() {
  try {
    const status = await api('/api/admin/status');
    dbStatusEl.textContent = status.database.configured ? 'DB: connected' : 'DB: not configured';
  } catch (error) {
    dbStatusEl.textContent = 'DB: error';
  }
}

checkDbStatus();
withErrorBoundary(renderDashboard);
