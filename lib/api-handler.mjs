import { buildDashboard, isoDate } from './common.mjs';

const jsonHeaders = { 'content-type': 'application/json; charset=utf-8' };
const allowedImageTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif']);
const maxImageBytes = 10 * 1024 * 1024;

function sendJson(status, payload) {
  return new Response(JSON.stringify(payload), { status, headers: jsonHeaders });
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

async function readJson(request) {
  const declaredLength = Number(request.headers.get('content-length') || 0);
  if (declaredLength > 2_000_000) throw httpError(413, '请求内容过大');
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > 2_000_000) throw httpError(413, '请求内容过大');
  if (!body) return {};
  try { return JSON.parse(body); }
  catch { throw httpError(400, 'JSON 格式无效'); }
}

async function readBinary(request, limit) {
  const declaredLength = Number(request.headers.get('content-length') || 0);
  if (declaredLength > limit) throw httpError(413, '图片不能超过 10 MB');
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.byteLength) throw httpError(400, '图片内容为空');
  if (bytes.byteLength > limit) throw httpError(413, '图片不能超过 10 MB');
  return bytes;
}

function validateImageSignature(bytes, mimeType) {
  const prefix = bytes.subarray(0, 12);
  const hex = [...prefix].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  const ascii = String.fromCharCode(...prefix);
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

function imageMetadata(url, request) {
  const encodedHeaderName = request.headers.get('x-file-name');
  let headerName = '';
  if (encodedHeaderName) {
    try { headerName = decodeURIComponent(encodedHeaderName); }
    catch { headerName = encodedHeaderName; }
  }
  const suppliedName = url.searchParams.get('filename') || headerName || 'image';
  const originalName = suppliedName.replaceAll('\\', '/').split('/').pop().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 180);
  if (!originalName) throw httpError(400, '图片文件名无效');
  const mimeType = String(request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
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

export function createApiHandler({ store, imageStore = null, backendName, dashboardToken = '' }) {
  function requireImageStore() {
    if (!imageStore) throw httpError(503, '图片存储尚未配置，请设置 Supabase 环境变量');
    return imageStore;
  }

  return async function handleApi(request) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/api/health') {
        return sendJson(200, {
          ok: true,
          time: new Date().toISOString(),
          dataBackend: backendName,
          imageStorage: imageStore ? 'supabase' : 'disabled'
        });
      }
      if (dashboardToken && request.headers.get('authorization') !== `Bearer ${dashboardToken}`) {
        return sendJson(401, { error: '访问令牌无效' });
      }

      if (request.method === 'GET' && url.pathname === '/api/bootstrap') {
        const days = Math.min(Math.max(Number(url.searchParams.get('days')) || 7, 7), 90);
        const to = url.searchParams.get('to') || isoDate();
        const [metrics, entries, tasks, dashboard] = await Promise.all([
          store.metrics(), store.latestEntries(), store.taskList(), buildDashboard(store, days, to)
        ]);
        return sendJson(200, {
          metrics, entries, tasks, dashboard,
          authEnabled: Boolean(dashboardToken),
          dataBackend: backendName,
          imageStorageEnabled: Boolean(imageStore)
        });
      }

      if (request.method === 'POST' && url.pathname === '/api/entries') {
        return sendJson(201, { id: await store.createEntry(await readJson(request)) });
      }
      if (request.method === 'PATCH' && /^\/api\/entries\/\d+$/.test(url.pathname)) {
        const body = await readJson(request);
        const patch = {};
        for (const field of ['metricKey', 'value', 'recordedOn', 'note']) {
          if (body[field] !== undefined) patch[field] = body[field];
        }
        if (!Object.keys(patch).length) throw httpError(400, '没有需要更新的字段');
        const updated = await store.updateEntry(url.pathname.split('/').pop(), patch);
        return sendJson(updated ? 200 : 404, updated ? { entry: updated } : { error: '记录不存在' });
      }
      if (request.method === 'DELETE' && /^\/api\/entries\/\d+$/.test(url.pathname)) {
        const deleted = await store.deleteEntry(url.pathname.split('/').pop());
        return sendJson(deleted ? 200 : 404, { deleted });
      }
      if (request.method === 'POST' && url.pathname === '/api/import') {
        const body = await readJson(request);
        if (!Array.isArray(body.rows)) throw httpError(400, '导入内容无效');
        const result = await store.createEntries(body.rows.slice(0, 5000), 'csv', true);
        return sendJson(200, { count: result.count, errors: result.errors });
      }
      if (request.method === 'POST' && url.pathname === '/api/automation/entries') {
        const body = await readJson(request);
        const items = Array.isArray(body.entries) ? body.entries : [body];
        if (!items.length || items.length > 1000) throw httpError(400, '自动采集每次需提交 1 至 1000 条记录');
        const result = await store.createEntries(items, String(body.source || 'automation').slice(0, 60), false);
        return sendJson(201, { imported: result.count, ids: result.ids });
      }
      if (request.method === 'POST' && url.pathname === '/api/tasks') {
        return sendJson(201, { id: await store.createTask(await readJson(request)) });
      }
      if (request.method === 'PATCH' && /^\/api\/tasks\/\d+$/.test(url.pathname)) {
        const body = await readJson(request);
        const patch = {};
        for (const field of ['title', 'domain', 'priority', 'dueOn', 'status']) {
          if (body[field] !== undefined) patch[field] = body[field];
        }
        if (!Object.keys(patch).length) throw httpError(400, '没有需要更新的字段');
        const updated = await store.updateTask(url.pathname.split('/').pop(), patch);
        return sendJson(updated ? 200 : 404, updated ? { task: updated } : { error: '任务不存在' });
      }
      if (request.method === 'DELETE' && /^\/api\/tasks\/\d+$/.test(url.pathname)) {
        const deleted = await store.deleteTask(url.pathname.split('/').pop());
        return sendJson(deleted ? 200 : 404, { deleted });
      }
      if (request.method === 'POST' && url.pathname === '/api/reports') {
        const body = await readJson(request);
        const days = body.period === 'month' ? 30 : 7;
        const period = days === 30 ? 'month' : 'week';
        const dashboard = await buildDashboard(store, days, body.to || isoDate());
        const summary = dashboard.insights.map((item) => item.text).join(' ');
        const title = `${dashboard.range.to} ${days === 30 ? '月度' : '周度'}回顾`;
        const id = await store.createReport(period, title, summary, dashboard);
        return sendJson(201, { id, title, summary, dashboard });
      }
      if (request.method === 'GET' && url.pathname === '/api/reports') {
        return sendJson(200, await store.reportList());
      }
      if (request.method === 'GET' && url.pathname === '/api/export') {
        return sendJson(200, { exportedAt: new Date().toISOString(), ...(await store.exportAll()) });
      }
      if (request.method === 'POST' && url.pathname === '/api/images') {
        const storage = requireImageStore();
        const metadata = imageMetadata(url, request);
        const bytes = await readBinary(request, maxImageBytes);
        if (!validateImageSignature(bytes, metadata.mimeType)) throw httpError(415, '图片内容与声明的格式不匹配');
        return sendJson(201, await storage.uploadImage({ bytes, ...metadata }));
      }
      if (request.method === 'GET' && url.pathname === '/api/images') {
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200);
        return sendJson(200, await requireImageStore().imageList(limit));
      }
      const imageUrlMatch = url.pathname.match(/^\/api\/images\/([0-9a-f-]+)\/url$/i);
      if (request.method === 'GET' && imageUrlMatch) {
        const expiresIn = Math.min(Math.max(Number(url.searchParams.get('expiresIn')) || 900, 60), 3600);
        const result = await requireImageStore().signedImageUrl(imageUrlMatch[1], expiresIn);
        return sendJson(result ? 200 : 404, result || { error: '图片不存在' });
      }
      const imageMatch = url.pathname.match(/^\/api\/images\/([0-9a-f-]+)$/i);
      if (request.method === 'DELETE' && imageMatch) {
        const deleted = await requireImageStore().deleteImage(imageMatch[1]);
        return sendJson(deleted ? 200 : 404, { deleted });
      }
      return sendJson(404, { error: '接口不存在' });
    } catch (error) {
      console.error(error);
      return sendJson(error.statusCode || 400, { error: error.message || '请求处理失败' });
    }
  };
}

