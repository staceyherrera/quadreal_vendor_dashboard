// Shared helpers for the API functions. Files starting with "_" are not exposed as routes.
import { createClient } from '@supabase/supabase-js';

export const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

// Returns the signed-in Supabase user for the request's bearer token, or null.
export async function getUser(req) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const { data, error } = await admin.auth.getUser(token);
  return error ? null : data.user;
}

export async function isStaff(userId) {
  const { data } = await admin.from('staff').select('user_id').eq('user_id', userId).maybeSingle();
  return !!data;
}

export async function hasVendor(userId, vendorCode) {
  const { data } = await admin.from('vendor_users').select('vendor_code')
    .eq('user_id', userId).eq('vendor_code', vendorCode).maybeSingle();
  return !!data;
}

export const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

// Reads every row of a query, 1,000 at a time (Supabase's per-request cap).
export async function fetchAll(build) {
  let out = [], from = 0;
  for (;;) {
    const { data, error } = await build().range(from, from + 999);
    if (error) throw error;
    out = out.concat(data);
    if (data.length < 1000) return out;
    from += 1000;
  }
}
