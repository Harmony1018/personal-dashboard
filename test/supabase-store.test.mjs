import test from 'node:test';
import assert from 'node:assert/strict';
import { SupabaseStore } from '../lib/supabase-store.mjs';

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

test('Supabase store keeps the service key server-side and uses private signed image URLs', async () => {
  const calls = [];
  const imageId = '11111111-1111-4111-8111-111111111111';
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    const pathname = new URL(url).pathname;
    if (pathname === '/rest/v1/metrics') return jsonResponse([]);
    if (pathname.startsWith('/storage/v1/object/personal-images/') && options.method === 'POST') {
      return jsonResponse({ Key: pathname });
    }
    if (pathname === '/rest/v1/images' && options.method === 'POST') {
      const body = JSON.parse(options.body);
      return jsonResponse([{ id: imageId, ...body, created_at: '2026-09-18T00:00:00Z' }], 201);
    }
    if (pathname === '/rest/v1/images' && (!options.method || options.method === 'GET')) {
      return jsonResponse([{
        id: imageId,
        object_path: '2026/09/example.jpg',
        original_name: 'example.jpg',
        mime_type: 'image/jpeg',
        byte_size: 4,
        category: 'general',
        related_type: null,
        related_id: null,
        captured_at: null,
        note: '',
        metadata: {},
        created_at: '2026-09-18T00:00:00Z'
      }]);
    }
    if (pathname.startsWith('/storage/v1/object/sign/personal-images/')) {
      return jsonResponse({ signedURL: '/object/sign/personal-images/2026/09/example.jpg?token=temporary' });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const store = new SupabaseStore({
    url: 'https://example.supabase.co',
    serviceKey: 'server-secret',
    fetchImpl
  });
  await store.init();
  const image = await store.uploadImage({
    bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    originalName: 'unsafe.html',
    mimeType: 'image/jpeg',
    category: 'general',
    relatedType: null,
    relatedId: null,
    capturedAt: null,
    note: ''
  });
  assert.equal(image.id, imageId);
  const storageCall = calls.find((call) => call.url.includes('/storage/v1/object/personal-images/') && !call.url.includes('/sign/'));
  assert.match(storageCall.url, /\.jpg$/);
  assert.equal(storageCall.options.headers.apikey, 'server-secret');
  assert.equal(storageCall.options.headers.authorization, 'Bearer server-secret');

  const signed = await store.signedImageUrl(imageId, 300);
  assert.equal(signed.expiresIn, 300);
  assert.match(signed.signedUrl, /^https:\/\/example\.supabase\.co\/storage\/v1\/object\/sign\//);
  assert.doesNotMatch(JSON.stringify(signed), /server-secret/);
});
