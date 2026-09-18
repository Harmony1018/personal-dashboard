import test from 'node:test';
import assert from 'node:assert/strict';
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
