// Reads an uploaded invoice PDF with Claude and returns the key fields as JSON.
// The PDF is fetched from Supabase storage server-side, so the Anthropic key never reaches the browser.
import { admin, getUser, isStaff, hasVendor } from './_lib.js';

const PROMPT = `You are reading a supplier invoice billed to QuadReal Property Group. Reply with only a JSON object with exactly these keys:
"invoice_number": the invoice number as printed (string), or null
"invoice_date": the invoice date as YYYY-MM-DD, or null
"total": the total amount due including all taxes, as a plain number with no currency symbol or commas, or null
"currency": the three-letter currency code, or null
"vendor_name": the name of the company that issued the invoice, or null
"reference": any purchase order (PO) or contract number printed on the invoice, or null
Use null rather than guessing.`;

function parseJson(text) {
  const t = String(text || '').trim();
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1);
  try { return JSON.parse(body); } catch { return null; }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST.' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'invoice reading isn’t configured.' });

  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: 'your session expired; sign in again.' });

  const path = req.body && req.body.path;
  if (typeof path !== 'string' || !/^[^/]+\/[0-9a-f-]{36}\.pdf$/i.test(path)) return res.status(400).json({ error: 'invalid file.' });
  const vendor = path.split('/')[0];
  if (!(await hasVendor(user.id, vendor)) && !(await isStaff(user.id))) return res.status(403).json({ error: 'you can’t read this file.' });

  const { data: blob, error } = await admin.storage.from('invoices').download(path);
  if (error || !blob) return res.status(404).json({ error: 'the uploaded file wasn’t found.' });
  const pdf = Buffer.from(await blob.arrayBuffer());
  if (pdf.length > 10 * 1024 * 1024) return res.status(413).json({ error: 'the file is over 10 MB.' });

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
      max_tokens: 600,
      messages: [{ role: 'user', content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf.toString('base64') } },
        { type: 'text', text: PROMPT }
      ] }]
    })
  });
  if (!r.ok) {
    console.error('Anthropic API error', r.status, (await r.text()).slice(0, 500));
    return res.status(502).json({ error: 'the reading service is unavailable right now.' });
  }
  const out = await r.json();
  const parsed = parseJson((out.content || []).filter(b => b.type === 'text').map(b => b.text).join(''));
  if (!parsed || typeof parsed !== 'object') return res.status(422).json({ error: 'the invoice details couldn’t be found.' });

  const total = parsed.total == null ? null : Number(String(parsed.total).replace(/[$,\s]/g, ''));
  return res.status(200).json({
    invoice_number: parsed.invoice_number ? String(parsed.invoice_number).trim().slice(0, 60) : null,
    invoice_date: /^\d{4}-\d{2}-\d{2}$/.test(parsed.invoice_date || '') ? parsed.invoice_date : null,
    total: Number.isFinite(total) ? Math.round(total * 100) / 100 : null,
    currency: parsed.currency ? String(parsed.currency).slice(0, 3).toUpperCase() : null,
    vendor_name: parsed.vendor_name ? String(parsed.vendor_name).slice(0, 200) : null,
    reference: parsed.reference ? String(parsed.reference).slice(0, 100) : null
  });
}
