import { createSupabaseEdgeHandler } from '../../../lib/supabase-edge-handler.mjs';

const handler = createSupabaseEdgeHandler({
  SUPABASE_URL: Deno.env.get('SUPABASE_URL') || '',
  SUPABASE_SERVICE_ROLE_KEY: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '',
  SUPABASE_STORAGE_BUCKET: Deno.env.get('SUPABASE_STORAGE_BUCKET') || 'personal-images',
  DASHBOARD_TOKEN: Deno.env.get('DASHBOARD_TOKEN') || '',
  ALLOWED_ORIGINS: Deno.env.get('ALLOWED_ORIGINS') || ''
});

Deno.serve(handler);
