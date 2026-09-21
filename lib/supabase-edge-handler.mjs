import { createApiHandler } from './api-handler.mjs';
import { SupabaseStore } from './supabase-store.mjs';

const functionPrefix = '/functions/v1/personal-dashboard';
const localOriginPattern = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}

function allowedOrigin(request, configuredOrigins) {
  const origin = request.headers.get('origin');
  if (!origin) return null;
  const configured = new Set(String(configuredOrigins || '').split(',').map((item) => item.trim()).filter(Boolean));
  return configured.has(origin) || localOriginPattern.test(origin) ? origin : false;
}

function withCors(response, origin) {
  if (!origin) return response;
  const headers = new Headers(response.headers);
  headers.set('access-control-allow-origin', origin);
  // PUT 和 PATCH 等价（鸿蒙 App 发不出 PATCH），预检必须放行，否则 App 的编辑请求会被浏览器规则挡掉。
  headers.set('access-control-allow-methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
  headers.set('access-control-allow-headers', 'Authorization, Content-Type, X-File-Name');
  headers.set('access-control-max-age', '86400');
  headers.set('vary', 'Origin');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function apiRequest(request) {
  const url = new URL(request.url);
  const apiIndex = url.pathname.indexOf('/api/');
  if (apiIndex >= 0) {
    url.pathname = url.pathname.slice(apiIndex);
  } else if (url.pathname.startsWith(functionPrefix)) {
    url.pathname = url.pathname.slice(functionPrefix.length) || '/';
  }
  return new Request(url, request);
}

export function createSupabaseEdgeHandler(env) {
  const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'DASHBOARD_TOKEN'];
  const missing = required.filter((name) => !env[name]);
  if (missing.length) throw new Error(`缺少环境变量：${missing.join('、')}`);

  const store = new SupabaseStore({
    url: env.SUPABASE_URL,
    serviceKey: env.SUPABASE_SERVICE_ROLE_KEY,
    bucket: env.SUPABASE_STORAGE_BUCKET || 'personal-images'
  });
  const handleApi = createApiHandler({
    store,
    imageStore: store,
    backendName: 'supabase',
    dashboardToken: env.DASHBOARD_TOKEN
  });
  const ready = store.init();

  return async function handleEdgeRequest(request) {
    const origin = allowedOrigin(request, env.ALLOWED_ORIGINS);
    // 来源不匹配时也要带上 CORS 头。不带的话浏览器只会报一句笼统的
    // 「blocked by CORS policy」，真正的原因（ALLOWED_ORIGINS 没配或写错）
    // 永远显示不出来 —— 更坑的是 curl 不带 Origin 能通，只有浏览器是死的。
    // 响应体里没有任何数据，回显来源不构成放行。
    if (origin === false) {
      return withCors(jsonResponse(403, { error: '不允许的请求来源' }), request.headers.get('origin'));
    }
    if (request.method === 'OPTIONS') return withCors(new Response(null, { status: 204 }), origin);

    try {
      await ready;
      return withCors(await handleApi(apiRequest(request)), origin);
    } catch (error) {
      console.error(error);
      return withCors(jsonResponse(500, { error: '服务初始化失败' }), origin);
    }
  };
}
