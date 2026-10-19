// Public settings for the browser. The anon key is safe to expose: row level security protects the data.
export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ url: process.env.SUPABASE_URL || null, anonKey: process.env.SUPABASE_ANON_KEY || null });
}
