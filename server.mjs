import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDashboard, isoDate } from './lib/common.mjs';
import { SqliteStore } from './lib/sqlite-store.mjs';
import { SupabaseStore } from './lib/supabase-store.mjs';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(rootDir, 'public');
const dataDir = path.resolve(rootDir, process.env.DATA_DIR || 'data');
const supabaseConfigured = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
const backendName = (process.env.DATA_BACKEND || (supabaseConfigured ? 'supabase' : 'sqlite')).toLowerCase();

if (!['sqlite', 'supabase'].includes(backendName)) throw new Error('DATA_BACKEND 只能是 sqlite 或 supabase');
if (backendName === 'supabase' && !supabaseConfigured) {
  throw new Error('使用 Supabase 数据后端时必须设置 SUPABASE_URL 和 SUPABASE_SERVICE_ROLE_KEY');
}

const supabaseOptions = {
  url: process.env.SUPABASE_URL,
  serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  bucket: process.env.SUPABASE_STORAGE_BUCKET || 'personal-images'
};
const store = backendName === 'supabase' ? new SupabaseStore(supabaseOptions) : new SqliteStore(dataDir);
const imageStore = supabaseConfigured
  ? (backendName === 'supabase' ? store : new SupabaseStore(supabaseOptions))
  : null;
await store.init();

const jsonHeaders = { 'content-type': 'application/json; charset=utf-8' };
const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};
const allowedImageTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif']);
const maxImageBytes = 10 * 1024 * 1024;

function sendJson(res, status, payload) {
  res.writeHead(status, jsonHeaders);
  res.end(JSON.stringify(payload));
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > 2_000_000) throw httpError(413, '请求内容过大');
  }
  if (!body) return {};
  try { return JSON.parse(body); }
  catch { throw httpError(400, 'JSON 格式无效'); }
}

async function readBinary(req, limit) {
  const declaredLength = Number(req.headers['content-length'] || 0);
  if (declaredLength > limit) throw httpError(413, '图片不能超过 10 MB');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw httpError(413, '图片不能超过 10 MB');
    chunks.push(chunk);
  }
  if (!size) throw httpError(400, '图片内容为空');
  return Buffer.concat(chunks);
}

function isAuthorized(req) {
  const token = process.env.DASHBOARD_TOKEN;
  if (!token) return true;
  return req.headers.authorization === `Bearer ${token}`;
}

function validateImageSignature(bytes, mimeType) {
  const hex = bytes.subarray(0, 12).toString('hex');
  const ascii = bytes.subarray(0, 12).toString('ascii');
  if (mimeType === 'image/jpeg') return hex.startsWith('ffd8ff');
  if (mimeType === 'image/png') return hex.startsWith('89504e470d0a1a0a');
  if (mimeType === 'image/gif') return ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a');
  if (mimeType === 'image/webp') return ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP';
  if (mimeType === 'image/heic' || mimeType === 'image/heif') {
    const brand = ascii.slice(4, 12);
    return brand.startsWith('ftyp') && /heic|heix|hevc|hevx|mif1|msf1/.test(brand);
  }
  return false;
}

function imageMetadata(url, req) {
  const encodedHeaderName = req.headers['x-file-name'];
  let headerName = '';
  if (encodedHeaderName) {
    try { headerName = decodeURIComponent(String(encodedHeaderName)); }
    catch { headerName = String(encodedHeaderName); }
  }
  const suppliedName = url.searchParams.get('filename') || headerName || 'image';
  const originalName = suppliedName.replaceAll('\\', '/').split('/').pop().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 180);
  if (!originalName) throw httpError(400, '图片文件名无效');
  const mimeType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!allowedImageTypes.has(mimeType)) throw httpError(415, '仅支持 JPEG、PNG、WebP、GIF、HEIC 和 HEIF 图片');
  const capturedAt = url.searchParams.get('capturedAt') || null;
  if (capturedAt && Number.isNaN(Date.parse(capturedAt))) throw httpError(400, 'capturedAt 必须是有效日期时间');
  return {
    originalName,
    mimeType,
    category: String(url.searchParams.get('category') || 'general').slice(0, 60),
    relatedType: String(url.searchParams.get('relatedType') || '').slice(0, 60) || null,
    relatedId: String(url.searchParams.get('relatedId') || '').slice(0, 120) || null,
    capturedAt,
    note: String(url.searchParams.get('note') || '').slice(0, 500)
  };
}

function requireImageStore() {
  if (!imageStore) throw httpError(503, '图片存储尚未配置，请设置 Supabase 环境变量');
  return imageStore;
}

async function handleApi(req, res, url) {
  if (url.pathname === '/api/health') {
    return sendJson(res, 200, {
      ok: true,
      time: new Date().toISOString(),
      dataBackend: backendName,
      imageStorage: imageStore ? 'supabase' : 'disabled'
    });
  }
  if (!isAuthorized(req)) return sendJson(res, 401, { error: '访问令牌无效' });

  if (req.method === 'GET' && url.pathname === '/api/bootstrap') {
    const days = Math.min(Math.max(Number(url.searchParams.get('days')) || 7, 7), 90);
    const to = url.searchParams.get('to') || isoDate();
    const [metrics, entries, tasks, dashboard] = await Promise.all([
      store.metrics(), store.latestEntries(), store.taskList(), buildDashboard(store, days, to)
    ]);
    return sendJson(res, 200, {
      metrics, entries, tasks, dashboard,
      authEnabled: Boolean(process.env.DASHBOARD_TOKEN),
      dataBackend: backendName,
      imageStorageEnabled: Boolean(imageStore)
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/entries') {
    return sendJson(res, 201, { id: await store.createEntry(await readJson(req)) });
  }

  if (req.method === 'DELETE' && /^\/api\/entries\/\d+$/.test(url.pathname)) {
    const deleted = await store.deleteEntry(url.pathname.split('/').pop());
    return sendJson(res, deleted ? 200 : 404, { deleted });
  }

  if (req.method === 'POST' && url.pathname === '/api/import') {
    const body = await readJson(req);
    if (!Array.isArray(body.rows)) throw httpError(400, '导入内容无效');
    const result = await store.createEntries(body.rows.slice(0, 5000), 'csv', true);
    return sendJson(res, 200, { count: result.count, errors: result.errors });
  }

  if (req.method === 'POST' && url.pathname === '/api/automation/entries') {
    const body = await readJson(req);
    const items = Array.isArray(body.entries) ? body.entries : [body];
    if (!items.length || items.length > 1000) throw httpError(400, '自动采集每次需提交 1 至 1000 条记录');
    const result = await store.createEntries(items, String(body.source || 'automation').slice(0, 60), false);
    return sendJson(res, 201, { imported: result.count, ids: result.ids });
  }

  if (req.method === 'POST' && url.pathname === '/api/tasks') {
    return sendJson(res, 201, { id: await store.createTask(await readJson(req)) });
  }

  if (req.method === 'PATCH' && /^\/api\/tasks\/\d+$/.test(url.pathname)) {
    const body = await readJson(req);
    const updated = await store.updateTask(url.pathname.split('/').pop(), body.status === 'done' ? 'done' : 'open');
    return sendJson(res, updated ? 200 : 404, { updated });
  }

  if (req.method === 'DELETE' && /^\/api\/tasks\/\d+$/.test(url.pathname)) {
    const deleted = await store.deleteTask(url.pathname.split('/').pop());
    return sendJson(res, deleted ? 200 : 404, { deleted });
  }

  if (req.method === 'POST' && url.pathname === '/api/reports') {
    const body = await readJson(req);
    const days = body.period === 'month' ? 30 : 7;
    const period = days === 30 ? 'month' : 'week';
    const dashboard = await buildDashboard(store, days, body.to || isoDate());
    const summary = dashboard.insights.map((item) => item.text).join(' ');
    const title = `${dashboard.range.to} ${days === 30 ? '月度' : '周度'}回顾`;
    const id = await store.createReport(period, title, summary, dashboard);
    return sendJson(res, 201, { id, title, summary, dashboard });
  }

  if (req.method === 'GET' && url.pathname === '/api/reports') {
    return sendJson(res, 200, await store.reportList());
  }

  if (req.method === 'GET' && url.pathname === '/api/export') {
    return sendJson(res, 200, { exportedAt: new Date().toISOString(), ...(await store.exportAll()) });
  }

  if (req.method === 'POST' && url.pathname === '/api/images') {
    const storage = requireImageStore();
    const metadata = imageMetadata(url, req);
    const bytes = await readBinary(req, maxImageBytes);
    if (!validateImageSignature(bytes, metadata.mimeType)) throw httpError(415, '图片内容与声明的格式不匹配');
    return sendJson(res, 201, await storage.uploadImage({ bytes, ...metadata }));
  }

  if (req.method === 'GET' && url.pathname === '/api/images') {
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200);
    return sendJson(res, 200, await requireImageStore().imageList(limit));
  }

  const imageUrlMatch = url.pathname.match(/^\/api\/images\/([0-9a-f-]+)\/url$/i);
  if (req.method === 'GET' && imageUrlMatch) {
    const expiresIn = Math.min(Math.max(Number(url.searchParams.get('expiresIn')) || 900, 60), 3600);
    const result = await requireImageStore().signedImageUrl(imageUrlMatch[1], expiresIn);
    return sendJson(res, result ? 200 : 404, result || { error: '图片不存在' });
  }

  const imageMatch = url.pathname.match(/^\/api\/images\/([0-9a-f-]+)$/i);
  if (req.method === 'DELETE' && imageMatch) {
    const deleted = await requireImageStore().deleteImage(imageMatch[1]);
    return sendJson(res, deleted ? 200 : 404, { deleted });
  }

  return sendJson(res, 404, { error: '接口不存在' });
}

async function serveStatic(res, url) {
  const requestPath = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  const filePath = path.resolve(publicDir, `.${requestPath}`);
  if (!filePath.startsWith(publicDir) || !existsSync(filePath)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('Not found');
  }
  const content = await readFile(filePath);
  res.writeHead(200, {
    'content-type': mimeTypes[path.extname(filePath)] || 'application/octet-stream',
    'cache-control': path.extname(filePath) === '.html' ? 'no-cache' : 'public, max-age=3600'
  });
  res.end(content);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else await serveStatic(res, url);
  } catch (error) {
    console.error(error);
    sendJson(res, error.statusCode || 400, { error: error.message || '请求处理失败' });
  }
});

const port = Number(process.env.PORT) || 4173;
const host = process.env.HOST || '127.0.0.1';
server.listen(port, host, () => {
  console.log(`Personal dashboard: http://${host}:${port}`);
  console.log(`Data backend: ${backendName}; image storage: ${imageStore ? 'supabase' : 'disabled'}`);
  if (!process.env.DASHBOARD_TOKEN) console.log('DASHBOARD_TOKEN is not set; API authentication is disabled.');
});
