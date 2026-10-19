// Loads processed Yardi EDP exports (parsed in the browser) into Supabase. Staff only.
// Replaces open POs/contracts and job rows, adds Yardi invoice numbers, and matches portal requests.
import { admin, getUser, isStaff, chunk, fetchAll } from './_lib.js';

const isArr = (a, max) => Array.isArray(a) && a.length <= max;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST.' });
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: 'Your session expired. Sign in again.' });
  if (!(await isStaff(user.id))) return res.status(403).json({ error: 'Only QuadReal staff can load Yardi data.' });

  const b = req.body || {};
  if (!isArr(b.vendors, 20000) || !isArr(b.items, 50000) || !isArr(b.jobs, 100000) || !isArr(b.invoices, 200000) || !/^\d{4}-\d{2}-\d{2}$/.test(b.asOf || '')) {
    return res.status(400).json({ error: 'The import data is incomplete. Check the files again.' });
  }

  try {
    const now = new Date().toISOString();
    const items = b.items.map(i => ({
      id: String(i.id), kind: i.kind, code: String(i.code), vendor_code: String(i.vendor_code), property: i.property || null,
      description: i.description || null, category: i.category || null, asset_class: i.asset_class || null, issued_on: i.issued_on || null,
      amount: +i.amount || 0, invoiced: +i.invoiced || 0, remaining: +i.remaining || 0, updated_at: now
    }));
    const newIds = new Set(items.map(i => i.id));

    for (const c of chunk(b.vendors.map(v => ({ code: String(v.code), name: String(v.name || v.code) })), 1000)) {
      const { error } = await admin.from('vendors').upsert(c, { onConflict: 'code' }); if (error) throw error;
    }
    for (const c of chunk(items, 500)) {
      const { error } = await admin.from('items').upsert(c, { onConflict: 'id' }); if (error) throw error;
    }

    // POs/contracts no longer open: delete them, unless a portal request points at them (then zero the balance).
    const existing = await fetchAll(() => admin.from('items').select('id'));
    const stale = existing.map(x => x.id).filter(id => !newIds.has(id));
    const referenced = new Set();
    for (const c of chunk(stale, 200)) {
      const { data, error } = await admin.from('requests').select('item_id').in('item_id', c); if (error) throw error;
      data.forEach(x => referenced.add(x.item_id));
    }
    const del = stale.filter(id => !referenced.has(id)), zero = stale.filter(id => referenced.has(id));
    for (const c of chunk(del, 200)) { const { error } = await admin.from('items').delete().in('id', c); if (error) throw error; }
    for (const c of chunk(zero, 200)) {
      const { error } = await admin.from('items').update({ remaining: 0, updated_at: now }).in('id', c); if (error) throw error;
      const { error: e2 } = await admin.from('item_jobs').delete().in('item_id', c); if (e2) throw e2;
    }

    // Job rows: replace for every imported item.
    for (const c of chunk([...newIds], 200)) { const { error } = await admin.from('item_jobs').delete().in('item_id', c); if (error) throw error; }
    const jobs = b.jobs.filter(j => newIds.has(j.item_id)).map(j => ({
      item_id: j.item_id, job_code: String(j.job_code || ''), job_description: j.job_description || null, job_status: j.job_status || null,
      amount: +j.amount || 0, invoiced: +j.invoiced || 0, remaining: +j.remaining || 0
    }));
    for (const c of chunk(jobs, 1000)) { const { error } = await admin.from('item_jobs').insert(c); if (error) throw error; }

    // Yardi invoice numbers (kept from every import).
    const invoices = b.invoices.map(x => ({ vendor_code: String(x.vendor_code), invoice_no: String(x.invoice_no).trim().toUpperCase() })).filter(x => x.vendor_code && x.invoice_no);
    for (const c of chunk(invoices, 1000)) {
      const { error } = await admin.from('yardi_invoices').upsert(c, { onConflict: 'vendor_code,invoice_no', ignoreDuplicates: true }); if (error) throw error;
    }

    // Match portal requests that now appear in Yardi.
    const inYardi = new Set(invoices.map(x => x.vendor_code + '\u0001' + x.invoice_no));
    const open = await fetchAll(() => admin.from('requests').select('id,vendor_code,invoice_no,status').eq('reflected', false).neq('status', 'Rejected'));
    let matched = 0;
    for (const r of open) {
      if (!inYardi.has(r.vendor_code + '\u0001' + String(r.invoice_no).trim().toUpperCase())) continue;
      matched++;
      const upd = { reflected: true, updated_at: now };
      if (r.status === 'Approved') upd.status = 'Entered in Yardi';
      const { error } = await admin.from('requests').update(upd).eq('id', r.id); if (error) throw error;
      if (r.status === 'Approved') {
        await admin.from('request_events').insert({ request_id: r.id, status: 'Entered in Yardi', actor: 'Yardi import', note: 'Matched to Yardi invoice by vendor code and invoice number.' });
      }
    }

    const { error: logErr } = await admin.from('imports').insert({
      data_as_of: b.asOf, label: String(b.label || 'Yardi EDP exports').slice(0, 300),
      po_rows: b.poRows | 0, contract_rows: b.ctRows | 0, matched, imported_by: user.id
    });
    if (logErr) throw logErr;

    return res.status(200).json({ ok: true, items: items.length, vendors: new Set(items.map(i => i.vendor_code)).size, removed: del.length, closed: zero.length, matched });
  } catch (e) {
    console.error('Import failed', e);
    return res.status(500).json({ error: 'The import stopped partway: ' + (e.message || 'unknown error') + '. Run it again; it’s safe to repeat.' });
  }
}
