import test from 'node:test';
import assert from 'node:assert/strict';
import { createSupabaseEdgeHandler } from '../lib/supabase-edge-handler.mjs';

function response(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function buildHandler() {
  const fetchImpl = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    if (pathname === '/rest/v1/metrics' && options.method === 'POST') return response(null, 201);
    throw new Error(`Unexpected Supabase request: ${url}`);
  };
  const handler = createSupabaseEdgeHandler({
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'server-secret',
    DASHBOARD_TOKEN: 'dashboard-secret',
    ALLOWED_ORIGINS: 'https://app.example.com'
  });
  return { handler, restore: () => { globalThis.fetch = fetchImpl; } };
}

test('Edge Function rewrites its hosted path and keeps health public', async (context) => {
  const { handler, restore } = buildHandler();
  context.after(restore);
  const result = await handler(new Request(
    'https://project.supabase.co/functions/v1/personal-dashboard/api/health'
  ));
  assert.equal(result.status, 200);
  assert.equal((await result.json()).dataBackend, 'supabase');

  const gatewayResult = await handler(new Request(
    'https://project.supabase.co/personal-dashboard/api/health'
  ));
  assert.equal(gatewayResult.status, 200);
});

test('Edge Function handles allowed CORS preflight and rejects unknown origins', async (context) => {
  const { handler, restore } = buildHandler();
  context.after(restore);
  const preflight = await handler(new Request(
    'https://project.supabase.co/functions/v1/personal-dashboard/api/bootstrap',
    { method: 'OPTIONS', headers: { origin: 'https://app.example.com' } }
  ));
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://app.example.com');

  const rejected = await handler(new Request(
    'https://project.supabase.co/functions/v1/personal-dashboard/api/bootstrap',
    { headers: { origin: 'https://other.example.com' } }
  ));
  assert.equal(rejected.status, 403);
});
