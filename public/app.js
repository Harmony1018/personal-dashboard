const state = {
  metrics: [],
  entries: [],
  tasks: [],
  dashboard: null,
  days: 7,
  domain: 'all',
  taskStatus: 'all',
  route: 'today',
  reports: []
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const domainNames = { business: '经营', health: '健康', planning: '计划' };
const routeNames = { today: '今天', data: '数据记录', plans: '计划', insights: '洞察', settings: '设置' };

function localDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function getToken() {
  return localStorage.getItem('personal-dashboard-token') || '';
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !headers['content-type']) headers['content-type'] = 'application/json';
  if (getToken()) headers.authorization = `Bearer ${getToken()}`;
  const response = await fetch(path, { ...options, headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `请求失败 (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

function showToast(message, isError = false) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.toggle('is-error', isError);
  toast.classList.add('is-visible');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('is-visible'), 2600);
}

function setBusy(button, busy, label) {
  if (!button) return;
  if (busy) {
    button.dataset.originalText = button.textContent;
    button.textContent = label || '处理中…';
    button.disabled = true;
  } else {
    button.textContent = button.dataset.originalText || button.textContent;
    button.disabled = false;
  }
}

function setRoute(route) {
  state.route = route;
  $$('.page').forEach((page) => page.classList.toggle('is-active', page.dataset.page === route));
  $$('[data-route]').forEach((button) => button.classList.toggle('is-active', button.dataset.route === route));
  $('#pageTitle').textContent = routeNames[route] || '个人面板';
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (route === 'insights') loadReports();
}

function formatMetricValue(metricKey, value, fallback = '—') {
  if (value == null || Number.isNaN(Number(value))) return fallback;
  const metric = state.metrics.find((item) => item.metricKey === metricKey);
  const number = Number(value);
  const formatted = number.toLocaleString('zh-CN', {
    minimumFractionDigits: metric?.precision || 0,
    maximumFractionDigits: metric?.precision ?? 2
  });
  if (metric?.unit === '¥') return `¥${formatted}`;
  return `${formatted}${metric?.unit ? ` ${metric.unit}` : ''}`;
}

function relativeDate(dateString) {
  if (!dateString) return '未设置日期';
  const today = new Date(`${localDate()}T12:00:00`);
  const target = new Date(`${dateString}T12:00:00`);
  const days = Math.round((target - today) / 86400000);
  if (days === 0) return '今天';
  if (days === 1) return '明天';
  if (days === -1) return '昨天';
  if (days > 1) return `${days} 天后`;
  return `逾期 ${Math.abs(days)} 天`;
}

async function loadData() {
  try {
    const data = await api(`/api/bootstrap?days=${state.days}&to=${localDate()}`);
    state.metrics = data.metrics;
    state.entries = data.entries;
    state.tasks = data.tasks;
    state.dashboard = data.dashboard;
    renderAll();
  } catch (error) {
    if (error.status === 401) {
      setRoute('settings');
      showToast('请输入云服务器访问令牌', true);
    } else {
      showToast(error.message, true);
    }
  }
}

function renderAll() {
  renderMetricOptions();
  renderOverview();
  renderInsights();
  renderQuickMetrics();
  renderTrend();
  renderMetricsDirectory();
  renderRecords();
  renderTasks();
}

function renderMetricOptions() {
  const groups = ['business', 'health', 'planning'];
  const options = groups.map((domain) => {
    const inner = state.metrics
      .filter((metric) => metric.domain === domain)
      .map((metric) => `<option value="${metric.metricKey}">${escapeHtml(metric.name)}</option>`)
      .join('');
    return `<optgroup label="${domainNames[domain]}">${inner}</optgroup>`;
  }).join('');

  const recordSelect = $('#recordMetric');
  const currentRecord = recordSelect.value;
  recordSelect.innerHTML = options;
  if (state.metrics.some((metric) => metric.metricKey === currentRecord)) recordSelect.value = currentRecord;

  const trendSelect = $('#trendMetric');
  const currentTrend = trendSelect.value || 'business.revenue';
  const trendKeys = ['business.revenue', 'business.orders', 'business.ad_spend', 'health.sleep', 'health.exercise', 'planning.focus'];
  trendSelect.innerHTML = state.metrics
    .filter((metric) => trendKeys.includes(metric.metricKey))
    .map((metric) => `<option value="${metric.metricKey}">${domainNames[metric.domain]} · ${escapeHtml(metric.name)}</option>`)
    .join('');
  trendSelect.value = state.metrics.some((metric) => metric.metricKey === currentTrend) ? currentTrend : 'business.revenue';
  updateRecordUnit();
}

function renderOverview() {
  const overview = state.dashboard?.overview;
  if (!overview) return;
  const openTasks = overview.tasks.total - overview.tasks.done;
  const change = overview.revenueChange;
  const stats = [
    {
      label: `${state.days} 天销售额`,
      value: formatMetricValue('business.revenue', overview.revenue),
      context: change == null ? '等待上一周期数据' : `较上期 ${change >= 0 ? '+' : ''}${change.toFixed(1)}%`,
      tone: change == null ? '' : change >= 0 ? 'positive' : 'warning'
    },
    {
      label: `${state.days} 天订单`,
      value: formatMetricValue('business.orders', overview.orders),
      context: overview.orders ? `广告支出 ${formatMetricValue('business.ad_spend', overview.adSpend)}` : '尚未记录订单',
      tone: ''
    },
    {
      label: '平均睡眠',
      value: overview.sleepAverage == null ? '—' : `${overview.sleepAverage.toFixed(1)} 小时`,
      context: overview.sleepAverage == null ? '尚未记录睡眠' : overview.sleepAverage >= 7 ? '达到基础恢复目标' : '低于 7 小时',
      tone: overview.sleepAverage == null ? '' : overview.sleepAverage >= 7 ? 'positive' : 'warning'
    },
    {
      label: '待完成计划',
      value: `${openTasks} 项`,
      context: overview.tasks.total ? `已完成 ${overview.tasks.done} / ${overview.tasks.total}` : '从一个具体计划开始',
      tone: openTasks === 0 && overview.tasks.total ? 'positive' : ''
    }
  ];
  $('#overviewStats').innerHTML = stats.map((stat) => `
    <div class="stat">
      <div class="stat-label">${stat.label}</div>
      <div class="stat-value">${stat.value}</div>
      <div class="stat-context ${stat.tone}">${stat.context}</div>
    </div>
  `).join('');
}

function renderInsights() {
  const insights = state.dashboard?.insights || [];
  $('#todayInsights').innerHTML = insights.map((item) => `
    <article class="insight-item" data-tone="${item.tone}">
      <strong>${escapeHtml(item.title)}</strong>
      <p>${escapeHtml(item.text)}</p>
    </article>
  `).join('');
}

function renderQuickMetrics() {
  const keys = ['business.revenue', 'business.orders', 'health.sleep', 'health.exercise', 'planning.focus'];
  const symbols = ['¥', '#', '眠', '动', '时'];
  $('#quickMetrics').innerHTML = keys.map((key, index) => {
    const metric = state.metrics.find((item) => item.metricKey === key);
    if (!metric) return '';
    return `
      <button class="quick-item" type="button" data-quick-metric="${key}">
        <span class="quick-icon">${symbols[index]}</span>
        <span class="quick-label"><strong>${escapeHtml(metric.name)}</strong><span>记录${escapeHtml(metric.unit || '数值')}</span></span>
      </button>
    `;
  }).join('');
}

function renderTrend() {
  const container = $('#trendChart');
  const metricKey = $('#trendMetric').value || 'business.revenue';
  const metric = state.metrics.find((item) => item.metricKey === metricKey);
  const values = (state.dashboard?.series || []).map((item) => ({ day: item.day, value: Number(item[metricKey] || 0) }));
  if (!values.some((item) => item.value !== 0)) {
    container.innerHTML = '<div class="chart-empty">记录数据后，这里会显示连续趋势。</div>';
    return;
  }

  const width = Math.max(container.clientWidth - 28, 300);
  const height = 216;
  const pad = { top: 25, right: 20, bottom: 35, left: 54 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const max = Math.max(...values.map((item) => item.value), 1);
  const x = (index) => pad.left + (values.length === 1 ? innerW / 2 : (index / (values.length - 1)) * innerW);
  const y = (value) => pad.top + innerH - (value / max) * innerH;
  const points = values.map((item, index) => `${x(index)},${y(item.value)}`).join(' ');
  const area = `${pad.left},${pad.top + innerH} ${points} ${pad.left + innerW},${pad.top + innerH}`;
  const grid = [0, .5, 1].map((fraction) => {
    const gy = pad.top + innerH * fraction;
    const label = max * (1 - fraction);
    return `<line class="chart-grid" x1="${pad.left}" y1="${gy}" x2="${pad.left + innerW}" y2="${gy}"/><text class="chart-axis-label" x="${pad.left - 8}" y="${gy + 4}" text-anchor="end">${compactNumber(label)}</text>`;
  }).join('');
  const labelEvery = values.length > 14 ? 5 : values.length > 8 ? 2 : 1;
  const labels = values.map((item, index) => {
    if (index % labelEvery !== 0 && index !== values.length - 1) return '';
    return `<text class="chart-axis-label" x="${x(index)}" y="${height - 8}" text-anchor="middle">${item.day.slice(5)}</text>`;
  }).join('');
  const pointsMarkup = values.map((item, index) => {
    const label = item.value ? `<text class="chart-value" x="${x(index)}" y="${Math.max(y(item.value) - 9, 12)}" text-anchor="middle">${index === values.length - 1 ? compactNumber(item.value) : ''}</text>` : '';
    return `<circle class="chart-point" cx="${x(index)}" cy="${y(item.value)}" r="3.5"><title>${item.day} · ${metric?.name || ''} ${item.value}</title></circle>${label}`;
  }).join('');
  container.setAttribute('aria-label', `${metric?.name || '指标'}最近 ${state.days} 天趋势`);
  container.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-hidden="true">
      ${grid}
      <polygon class="chart-area-fill" points="${area}"/>
      <polyline class="chart-line" points="${points}"/>
      ${pointsMarkup}${labels}
    </svg>
  `;
}

function compactNumber(value) {
  if (value >= 10000) return `${(value / 10000).toFixed(1)}万`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return Number(value.toFixed(value < 10 ? 1 : 0)).toString();
}

function renderMetricsDirectory() {
  const domains = ['business', 'health', 'planning'];
  $('#metricDirectory').innerHTML = domains.map((domain) => `
    <section class="metric-group">
      <h3>${domainNames[domain]}</h3>
      ${state.metrics.filter((metric) => metric.domain === domain).map((metric) => `
        <div class="metric-line"><span>${escapeHtml(metric.name)}</span><span>${metric.goal == null ? escapeHtml(metric.unit) : `目标 ${metric.goal} ${escapeHtml(metric.unit)}`}</span></div>
      `).join('')}
    </section>
  `).join('');
}

function renderRecords() {
  const entries = state.entries.filter((entry) => state.domain === 'all' || entry.domain === state.domain);
  $('#recordCount').textContent = `${entries.length} 条`;
  $('#recordsEmpty').hidden = entries.length !== 0;
  $('#recordsTable').innerHTML = entries.map((entry) => `
    <tr>
      <td>${entry.recordedOn}</td>
      <td>${escapeHtml(entry.name)}</td>
      <td><span class="tag">${domainNames[entry.domain]}</span></td>
      <td class="number">${formatMetricValue(entry.metricKey, entry.value)}</td>
      <td class="source-label">${entry.source === 'csv' ? 'CSV' : '手动'}</td>
      <td>${escapeHtml(entry.note || '—')}</td>
      <td><button class="row-delete" type="button" data-delete-entry="${entry.id}" aria-label="删除记录">×</button></td>
    </tr>
  `).join('');
}

function taskMarkup(task) {
  const priorityLabel = task.priority === 'high' ? '重要' : task.priority === 'low' ? '稍后' : domainNames[task.domain];
  return `
    <div class="task-row ${task.status === 'done' ? 'is-done' : ''}">
      <input class="task-check" type="checkbox" data-task-toggle="${task.id}" ${task.status === 'done' ? 'checked' : ''} aria-label="切换任务完成状态">
      <div class="task-title"><strong>${escapeHtml(task.title)}</strong><span>${escapeHtml(relativeDate(task.dueOn))}${task.dueOn ? ` · ${task.dueOn}` : ''}</span></div>
      <span class="tag ${task.priority}">${priorityLabel}</span>
      <button class="row-delete" type="button" data-delete-task="${task.id}" aria-label="删除任务">×</button>
    </div>
  `;
}

function renderTasks() {
  const openTasks = state.tasks.filter((task) => task.status === 'open');
  $('#todayTasks').innerHTML = openTasks.length
    ? openTasks.slice(0, 5).map(taskMarkup).join('')
    : '<div class="empty-state">没有待完成事项。给今天留一点空间也很好。</div>';

  const filtered = state.tasks.filter((task) => state.taskStatus === 'all' || task.status === state.taskStatus);
  $('#allTasks').innerHTML = filtered.length
    ? filtered.map(taskMarkup).join('')
    : '<div class="empty-state">当前筛选下没有计划。</div>';
  $('#taskSummary').textContent = `${openTasks.length} 个待完成 · ${state.tasks.length - openTasks.length} 个已完成`;
}

function openRecord(metricKey) {
  const dialog = $('#recordDialog');
  $('#recordForm').reset();
  $('[name="recordedOn"]', $('#recordForm')).value = localDate();
  if (metricKey) $('#recordMetric').value = metricKey;
  updateRecordUnit();
  dialog.showModal();
  setTimeout(() => $('[name="value"]', $('#recordForm')).focus(), 0);
}

function updateRecordUnit() {
  const metric = state.metrics.find((item) => item.metricKey === $('#recordMetric').value);
  $('#recordUnit').textContent = metric?.unit || '';
  $('[name="value"]', $('#recordForm')).step = metric?.precision ? String(1 / (10 ** metric.precision)) : '1';
}

async function submitRecord(event) {
  event.preventDefault();
  if (event.submitter?.value === 'cancel') return $('#recordDialog').close();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form));
  try {
    setBusy(event.submitter, true, '保存中…');
    await api('/api/entries', { method: 'POST', body: JSON.stringify(data) });
    $('#recordDialog').close();
    showToast('数据已记录');
    await loadData();
  } catch (error) {
    showToast(error.message, true);
  } finally {
    setBusy(event.submitter, false);
  }
}

async function submitTask(event) {
  event.preventDefault();
  const button = $('button[type="submit"]', event.currentTarget);
  try {
    setBusy(button, true, '添加中…');
    const data = Object.fromEntries(new FormData(event.currentTarget));
    await api('/api/tasks', { method: 'POST', body: JSON.stringify(data) });
    event.currentTarget.reset();
    showToast('计划已添加');
    await loadData();
  } catch (error) {
    showToast(error.message, true);
  } finally {
    setBusy(button, false);
  }
}

async function toggleTask(id, done) {
  try {
    await api(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify({ status: done ? 'done' : 'open' }) });
    await loadData();
  } catch (error) {
    showToast(error.message, true);
  }
}

async function deleteItem(type, id) {
  const label = type === 'tasks' ? '任务' : '数据记录';
  if (!window.confirm(`确定删除这条${label}吗？`)) return;
  try {
    await api(`/api/${type}/${id}`, { method: 'DELETE' });
    showToast(`${label}已删除`);
    await loadData();
  } catch (error) {
    showToast(error.message, true);
  }
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(field.trim()); field = ''; }
    else if (char === '\n') { row.push(field.trim()); rows.push(row); row = []; field = ''; }
    else if (char !== '\r') field += char;
  }
  if (field || row.length) { row.push(field.trim()); rows.push(row); }
  return rows.filter((item) => item.some(Boolean));
}

async function submitImport(event) {
  event.preventDefault();
  if (event.submitter?.value === 'cancel') return $('#importDialog').close();
  const file = $('[name="file"]', event.currentTarget).files[0];
  if (!file) return;
  try {
    setBusy(event.submitter, true, '导入中…');
    const matrix = parseCsv(await file.text());
    const headers = matrix.shift()?.map((item) => item.toLowerCase()) || [];
    const required = ['recorded_on', 'metric_key', 'value'];
    if (!required.every((name) => headers.includes(name))) throw new Error('CSV 缺少必要列');
    const rows = matrix.map((cells) => ({
      recordedOn: cells[headers.indexOf('recorded_on')],
      metricKey: cells[headers.indexOf('metric_key')],
      value: cells[headers.indexOf('value')],
      note: headers.includes('note') ? cells[headers.indexOf('note')] : ''
    }));
    const result = await api('/api/import', { method: 'POST', body: JSON.stringify({ rows }) });
    $('#importStatus').textContent = `成功导入 ${result.count} 条${result.errors.length ? `，${result.errors.length} 条失败` : ''}`;
    showToast(`已导入 ${result.count} 条数据`);
    await loadData();
    if (!result.errors.length) setTimeout(() => $('#importDialog').close(), 500);
  } catch (error) {
    $('#importStatus').textContent = error.message;
    showToast(error.message, true);
  } finally {
    setBusy(event.submitter, false);
  }
}

function downloadBlob(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function generateReport() {
  const button = $('#generateReportButton');
  try {
    setBusy(button, true, '生成中…');
    const report = await api('/api/reports', {
      method: 'POST',
      body: JSON.stringify({ period: $('#reportPeriod').value, to: localDate() })
    });
    renderReportPreview(report);
    showToast('阶段回顾已生成');
    await loadReports();
  } catch (error) {
    showToast(error.message, true);
  } finally {
    setBusy(button, false);
  }
}

function renderReportPreview(report) {
  const overview = report.dashboard.overview;
  $('#reportPreview').innerHTML = `
    <article class="report-content">
      <h2>${escapeHtml(report.title)}</h2>
      <p>${report.dashboard.range.from} 至 ${report.dashboard.range.to}</p>
      <div class="report-kpis">
        <div class="report-kpi"><span>销售额</span><strong>${formatMetricValue('business.revenue', overview.revenue)}</strong></div>
        <div class="report-kpi"><span>订单</span><strong>${formatMetricValue('business.orders', overview.orders)}</strong></div>
        <div class="report-kpi"><span>平均睡眠</span><strong>${overview.sleepAverage == null ? '—' : `${overview.sleepAverage.toFixed(1)} h`}</strong></div>
        <div class="report-kpi"><span>专注时间</span><strong>${formatMetricValue('planning.focus', overview.focus)}</strong></div>
      </div>
      <ul class="report-notes">${report.dashboard.insights.map((item) => `<li>${escapeHtml(item.text)}</li>`).join('')}</ul>
    </article>
  `;
}

async function loadReports() {
  try {
    state.reports = await api('/api/reports');
    $('#reportHistory').innerHTML = state.reports.length ? state.reports.map((report) => `
      <article class="report-row"><strong>${escapeHtml(report.title)}</strong><p>${escapeHtml(report.summary)}</p></article>
    `).join('') : '<div class="empty-state">还没有历史报告。</div>';
  } catch (error) {
    if (error.status !== 401) showToast(error.message, true);
  }
}

async function exportData() {
  const button = $('#exportButton');
  try {
    setBusy(button, true, '导出中…');
    const headers = {};
    if (getToken()) headers.authorization = `Bearer ${getToken()}`;
    const response = await fetch('/api/export', { headers });
    if (!response.ok) throw new Error('导出失败');
    downloadBlob(`personal-dashboard-${localDate()}.json`, await response.text(), 'application/json');
    showToast('数据备份已下载');
  } catch (error) {
    showToast(error.message, true);
  } finally {
    setBusy(button, false);
  }
}

function bindEvents() {
  $$('[data-route]').forEach((button) => button.addEventListener('click', () => setRoute(button.dataset.route)));
  $$('[data-route-link]').forEach((button) => button.addEventListener('click', () => setRoute(button.dataset.routeLink)));
  $('#openRecordButton').addEventListener('click', () => openRecord());
  $('#mobileAddButton').addEventListener('click', () => openRecord());
  $$('[data-open-record]').forEach((button) => button.addEventListener('click', () => openRecord()));
  $('#refreshButton').addEventListener('click', loadData);
  $('#recordMetric').addEventListener('change', updateRecordUnit);
  $('#recordForm').addEventListener('submit', submitRecord);
  $('#taskForm').addEventListener('submit', submitTask);
  $('#trendMetric').addEventListener('change', renderTrend);
  $('#generateReportButton').addEventListener('click', generateReport);
  $('#exportButton').addEventListener('click', exportData);
  $('#openImportButton').addEventListener('click', () => {
    $('#importForm').reset();
    $('#importStatus').textContent = '';
    $('#importDialog').showModal();
  });
  $('#importForm').addEventListener('submit', submitImport);
  $('#downloadTemplateButton').addEventListener('click', () => {
    const template = 'recorded_on,metric_key,value,note\n2026-09-18,business.revenue,2680,日常销售\n2026-09-18,health.sleep,7.5,\n';
    downloadBlob('personal-dashboard-template.csv', `\uFEFF${template}`, 'text/csv;charset=utf-8');
  });
  $('#saveTokenButton').addEventListener('click', async () => {
    localStorage.setItem('personal-dashboard-token', $('#tokenInput').value.trim());
    showToast('访问令牌已保存');
    await loadData();
  });
  $('#clearTokenButton').addEventListener('click', () => {
    localStorage.removeItem('personal-dashboard-token');
    $('#tokenInput').value = '';
    showToast('本机令牌已清除');
  });

  $$('#page-today [data-days]').forEach((button) => button.addEventListener('click', async () => {
    state.days = Number(button.dataset.days);
    $$('#page-today [data-days]').forEach((item) => item.classList.toggle('is-selected', item === button));
    await loadData();
  }));

  $$('#domainFilter [data-domain]').forEach((button) => button.addEventListener('click', () => {
    state.domain = button.dataset.domain;
    $$('#domainFilter button').forEach((item) => item.classList.toggle('is-selected', item === button));
    renderRecords();
  }));

  $$('#taskFilter [data-status]').forEach((button) => button.addEventListener('click', () => {
    state.taskStatus = button.dataset.status;
    $$('#taskFilter button').forEach((item) => item.classList.toggle('is-selected', item === button));
    renderTasks();
  }));

  document.addEventListener('click', (event) => {
    const quick = event.target.closest('[data-quick-metric]');
    if (quick) openRecord(quick.dataset.quickMetric);
    const deleteEntry = event.target.closest('[data-delete-entry]');
    if (deleteEntry) deleteItem('entries', deleteEntry.dataset.deleteEntry);
    const deleteTask = event.target.closest('[data-delete-task]');
    if (deleteTask) deleteItem('tasks', deleteTask.dataset.deleteTask);
  });

  document.addEventListener('change', (event) => {
    if (event.target.matches('[data-task-toggle]')) toggleTask(event.target.dataset.taskToggle, event.target.checked);
  });
}

function init() {
  $('#todayDate').textContent = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'full' }).format(new Date());
  $('#tokenInput').value = getToken();
  bindEvents();
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(renderTrend, 100);
  });
  loadData();
}

init();
