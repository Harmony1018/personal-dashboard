import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function waitForServer(baseUrl) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Test server did not start');
}

async function request(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      authorization: 'Bearer test-token',
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });
  const payload = await response.json();
  assert.equal(response.ok, true, JSON.stringify(payload));
  return payload;
}

async function failingRequest(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      authorization: 'Bearer test-token',
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });
  return { status: response.status, payload: await response.json() };
}

test('record, import, task, report and export flow', async (context) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'personal-dashboard-'));
  const port = 43173;
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir,
      DATA_BACKEND: 'sqlite', DASHBOARD_TOKEN: 'test-token',
      SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: ''
    },
    stdio: 'ignore'
  });

  context.after(async () => {
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
    await rm(dataDir, { recursive: true, force: true });
  });

  await waitForServer(baseUrl);
  const unauthorized = await fetch(`${baseUrl}/api/bootstrap`);
  assert.equal(unauthorized.status, 401);
  const health = await fetch(`${baseUrl}/api/health`).then((response) => response.json());
  assert.equal(health.dataBackend, 'sqlite');
  assert.equal(health.imageStorage, 'disabled');

  const imageUnavailable = await fetch(`${baseUrl}/api/images`, {
    headers: { authorization: 'Bearer test-token' }
  });
  assert.equal(imageUnavailable.status, 503);

  const entry = await request(baseUrl, '/api/entries', {
    method: 'POST',
    body: JSON.stringify({ metricKey: 'business.revenue', value: 3200, recordedOn: '2026-09-18' })
  });
  assert.equal(entry.id, 1);

  const imported = await request(baseUrl, '/api/import', {
    method: 'POST',
    body: JSON.stringify({ rows: [
      { metricKey: 'health.sleep', value: 7.5, recordedOn: '2026-09-18' },
      { metricKey: 'planning.focus', value: 90, recordedOn: '2026-09-18' }
    ] })
  });
  assert.equal(imported.count, 2);

  const automated = await request(baseUrl, '/api/automation/entries', {
    method: 'POST',
    body: JSON.stringify({ source: 'test-rpa', entries: [
      { metricKey: 'business.orders', value: 12, recordedOn: '2026-09-18' }
    ] })
  });
  assert.equal(automated.imported, 1);

  const task = await request(baseUrl, '/api/tasks', {
    method: 'POST',
    body: JSON.stringify({ title: '完成第一批', priority: 'high', dueOn: '2026-09-18' })
  });
  await request(baseUrl, `/api/tasks/${task.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'done' }) });

  // 编辑记录：只改数值和日期，指标与备注保留原值。
  const editedEntry = await request(baseUrl, `/api/entries/${entry.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ value: 3500, note: '平台日报核对后' })
  });
  assert.equal(editedEntry.entry.value, 3500);
  assert.equal(editedEntry.entry.metricKey, 'business.revenue');
  assert.equal(editedEntry.entry.recordedOn, '2026-09-18');
  assert.equal(editedEntry.entry.note, '平台日报核对后');
  assert.equal(editedEntry.entry.source, 'manual');

  // 换指标也应该生效。
  const switchedMetric = await request(baseUrl, `/api/entries/${entry.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ metricKey: 'business.ad_spend', value: 88 })
  });
  assert.equal(switchedMetric.entry.metricKey, 'business.ad_spend');
  await request(baseUrl, `/api/entries/${entry.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ metricKey: 'business.revenue', value: 3500 })
  });

  const missingEntry = await failingRequest(baseUrl, '/api/entries/99999', {
    method: 'PATCH', body: JSON.stringify({ value: 1 })
  });
  assert.equal(missingEntry.status, 404);
  const emptyPatch = await failingRequest(baseUrl, `/api/entries/${entry.id}`, {
    method: 'PATCH', body: JSON.stringify({})
  });
  assert.equal(emptyPatch.status, 400);
  const badMetric = await failingRequest(baseUrl, `/api/entries/${entry.id}`, {
    method: 'PATCH', body: JSON.stringify({ metricKey: 'not.a.metric' })
  });
  assert.equal(badMetric.status, 400);

  // 编辑任务：改标题不能把已完成状态清掉。
  const editedTask = await request(baseUrl, `/api/tasks/${task.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ title: '完成第二批', priority: 'low', dueOn: '' })
  });
  assert.equal(editedTask.task.title, '完成第二批');
  assert.equal(editedTask.task.priority, 'low');
  assert.equal(editedTask.task.dueOn, null);
  assert.equal(editedTask.task.status, 'done');

  const blankTitle = await failingRequest(baseUrl, `/api/tasks/${task.id}`, {
    method: 'PATCH', body: JSON.stringify({ title: '   ' })
  });
  assert.equal(blankTitle.status, 400);
  const missingTask = await failingRequest(baseUrl, '/api/tasks/99999', {
    method: 'PATCH', body: JSON.stringify({ title: '不存在' })
  });
  assert.equal(missingTask.status, 404);

  const report = await request(baseUrl, '/api/reports', {
    method: 'POST',
    body: JSON.stringify({ period: 'week', to: '2026-09-18' })
  });
  assert.match(report.title, /周度回顾/);

  const bootstrap = await request(baseUrl, '/api/bootstrap?days=7&to=2026-09-18');
  assert.equal(bootstrap.metrics.length, 9);
  assert.equal(bootstrap.entries.length, 4);
  assert.equal(bootstrap.tasks[0].status, 'done');

  const exported = await request(baseUrl, '/api/export');
  assert.equal(exported.entries.length, 4);
  assert.equal(exported.reports.length, 1);
});

// 前端是一堆字符串拼出来的 DOM，没有构建期检查。这里保证 app.js 引用的每个 id
// 都能在 index.html 里找到，避免改 HTML 时漏掉某个 id 直到用户点上去才发现。
test('frontend script references only ids that exist in the page', async () => {
  const [script, html] = await Promise.all([
    readFile(path.join(root, 'public', 'app.js'), 'utf8'),
    readFile(path.join(root, 'public', 'index.html'), 'utf8')
  ]);
  const declaredIds = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]));
  const referenced = new Set(
    [...script.matchAll(/\$\('#([A-Za-z0-9_-]+)'/g)].map((match) => match[1])
  );
  const missing = [...referenced].filter((id) => !declaredIds.has(id));
  assert.deepEqual(missing, [], `app.js 引用了 index.html 中不存在的 id: ${missing.join(', ')}`);

  // 导航按钮指向的页面区块也要真的存在。
  const routes = [...html.matchAll(/data-route="([a-z]+)"/g)].map((match) => match[1]);
  const pages = new Set([...html.matchAll(/data-page="([a-z]+)"/g)].map((match) => match[1]));
  const orphanRoutes = [...new Set(routes)].filter((route) => !pages.has(route));
  assert.deepEqual(orphanRoutes, [], `导航指向了不存在的页面: ${orphanRoutes.join(', ')}`);
});
