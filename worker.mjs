import { createApiHandler } from './lib/api-handler.mjs';
import { SupabaseStore } from './lib/supabase-store.mjs';

let apiPromise;

async function createWorkerApi(env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !env.DASHBOARD_TOKEN) {
    throw new Error('缺少 SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY 或 DASHBOARD_TOKEN');
  }
  const store = new SupabaseStore({
    url: env.SUPABASE_URL,
    serviceKey: env.SUPABASE_SERVICE_ROLE_KEY,
    bucket: env.SUPABASE_STORAGE_BUCKET || 'personal-images'
  });
  await store.init();
  return createApiHandler({
    store,
    imageStore: store,
    backendName: 'supabase',
    dashboardToken: env.DASHBOARD_TOKEN
  });
}

export default {
  async fetch(request, env) {
    try {
      if (new URL(request.url).pathname.startsWith('/api/')) {
        if (!apiPromise) {
          // 失败时必须把缓存清掉：rejected promise 是 truthy，`||=` 会一直复用它，
          // 一次瞬时故障就变成该 isolate 上所有请求永久返回 500，直到实例被回收。
          apiPromise = createWorkerApi(env).catch((error) => {
            apiPromise = undefined;
            throw error;
          });
        }
        return await (await apiPromise)(request);
      }
      return env.ASSETS.fetch(request);
    } catch (error) {
      console.error(error);
      return Response.json({ error: error.message || '服务初始化失败' }, { status: 500 });
    }
  }
};

