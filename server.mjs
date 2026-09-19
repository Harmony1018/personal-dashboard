import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApiHandler } from './lib/api-handler.mjs';
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

const api = createApiHandler({
  store,
  imageStore,
  backendName,
  dashboardToken: process.env.DASHBOARD_TOKEN
});
const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

async function sendWebResponse(res, response) {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
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
    if (url.pathname.startsWith('/api/')) {
      const request = new Request(url, {
        method: req.method,
        headers: req.headers,
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : req,
        duplex: 'half'
      });
      await sendWebResponse(res, await api(request));
    } else {
      await serveStatic(res, url);
    }
  } catch (error) {
    console.error(error);
    await sendWebResponse(res, Response.json({ error: error.message || '请求处理失败' }, { status: 400 }));
  }
});

const port = Number(process.env.PORT) || 4173;
const host = process.env.HOST || '127.0.0.1';
server.listen(port, host, () => {
  console.log(`Personal dashboard: http://${host}:${port}`);
  console.log(`Data backend: ${backendName}; image storage: ${imageStore ? 'supabase' : 'disabled'}`);
  if (!process.env.DASHBOARD_TOKEN) console.log('DASHBOARD_TOKEN is not set; API authentication is disabled.');
});
