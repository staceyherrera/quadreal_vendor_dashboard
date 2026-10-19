
/* QuadReal Vendor Portal: browser app. Data comes from Supabase after sign-in; nothing sensitive is built into this file. */
const fmt = new Intl.NumberFormat('en-CA',{style:'currency',currency:'CAD'});
const money = n => fmt.format(n||0);
const r2 = n => Math.round((n+Number.EPSILON)*100)/100;
const esc = s => String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const dfmt = s => s ? new Date(String(s).slice(0,10)+'T12:00:00').toLocaleDateString('en-CA',{year:'numeric',month:'short',day:'numeric'}) : '';
const tfmt = d => d ? new Date(d).toLocaleString('en-CA',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}) : '';
const norm = s => String(s??'').trim().toUpperCase();
const kb = n => !n ? '' : n>1048576 ? (n/1048576).toFixed(1)+' MB' : Math.max(1,Math.round(n/1024))+' KB';
const PENDING = ['Submitted','In review','Needs info','Approved'];
const FLOW = ['Submitted','In review','Approved','Entered in Yardi','Paid'];
const sc = s => 's-'+s.replace(/ /g,'-');
const app = document.getElementById('app');

let sb = null;
const S = {
  user:null, staff:false, codes:[], vnames:{}, vendor:null, view:'vendor', vtab:'submit', btab:'queue', filter:'action', q:'', sel:null, selSig:'',
  items:[], byId:{}, reqs:[], jobs:{}, draft:null, itemQ:'', posQ:'', bigView:false, readToken:0, submitting:false,
  imports:[], dirty:false, started:false, imp:null, counts:null
};

/* ---------- small utilities ---------- */
function toast(msg){ const t=document.getElementById('toast'); t.textContent=msg; t.hidden=false; clearTimeout(toast._t); toast._t=setTimeout(()=>t.hidden=true,3600); }
function busyTyping(){ const a=document.activeElement; return !!(a && a.closest && a.closest('#body') && (a.tagName==='TEXTAREA' || (a.tagName==='INPUT' && !['radio','file','checkbox'].includes(a.type)))); }
function itemLabel(it){ return it ? `${it.t} ${it.code}` : 'PO or contract no longer open'; }
function vname(v){ return S.vnames[v] || v; }
function errText(e, fallback){ return (e && (e.message || e.error_description)) || fallback || 'Something went wrong. Try again.'; }
async function token(){ const { data } = await sb.auth.getSession(); return data.session ? data.session.access_token : null; }
async function api(path, body){
  const t = await token(); if(!t) throw new Error('Your session expired. Sign in again.');
  const res = await fetch(path, {method:'POST', headers:{'content-type':'application/json', authorization:'Bearer '+t}, body:JSON.stringify(body)});
  let data = {}; try{ data = await res.json(); }catch(_){}
  if(!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}
function loadScript(src){ return new Promise((ok,fail)=>{ const s=document.createElement('script'); s.src=src; s.onload=ok; s.onerror=()=>fail(new Error('Couldn’t load '+src)); document.head.appendChild(s); }); }

function toItem(x){ return {id:x.id, t:x.kind, code:x.code, v:x.vendor_code, prop:x.property||'', desc:x.description||'', cat:x.category||'', ac:x.asset_class||'',
  date:x.issued_on, amt:+x.amount, inv:+x.invoiced, rem:+x.remaining, pending:+x.pending, avail:+x.available}; }
function toReq(x){
  const ev = (x.request_events||[]).slice().sort((a,b)=>String(a.created_at).localeCompare(String(b.created_at)) || a.id-b.id);
  if(x.vendors && x.vendors.name) S.vnames[x.vendor_code] = x.vendors.name;
  return {id:x.id, v:x.vendor_code, item:x.item_id, invNo:x.invoice_no, invDate:x.invoice_date, extracted:x.extracted_amount==null?null:+x.extracted_amount,
    amount:+x.amount, filePath:x.file_path, file:x.file_name||'invoice.pdf', fileSize:x.file_size, source:x.source, nameOnInvoice:x.name_on_invoice||'',
    refOnInvoice:x.ref_on_invoice||'', status:x.status, reflected:x.reflected, submitted:x.submitted_at, history:ev.map(e=>({s:e.status, by:e.actor, note:e.note||'', at:e.created_at}))};
}
/* pending on an item, leaving out request r when r itself is still pending */
function pendExcl(it, r){ return r && PENDING.includes(r.status) && !r.reflected && r.item===it.id ? r2(it.pending - r.amount) : it.pending; }

/* ---------- boot and sign-in ---------- */
async function boot(){
  app.innerHTML = `<div class="empty"><span class="spin"></span>Loading…</div>`;
  let cfg = null; try{ cfg = await (await fetch('/api/config')).json(); }catch(_){}
  if(!cfg || !cfg.url || !cfg.anonKey){ app.innerHTML = `<section class="panel pad"><h2>The portal isn’t set up yet</h2><p class="muted" style="margin-top:8px">Add SUPABASE_URL and SUPABASE_ANON_KEY to the Vercel project’s environment variables, then redeploy.</p></section>`; return; }
  sb = window.supabase.createClient(cfg.url, cfg.anonKey);
  sb.auth.onAuthStateChange((event, session)=>{
    if(event==='SIGNED_IN' && session && !S.started) setTimeout(()=>startSession(session.user),0);
    if(event==='SIGNED_OUT') setTimeout(()=>location.reload(),0);
  });
  const { data } = await sb.auth.getSession();
  if(data.session) startSession(data.session.user); else showLogin();
}

function showLogin(sent, err){
  header(false);
  app.innerHTML = `<section class="login panel">
    <h2>Sign in to the vendor portal</h2>
    ${sent ? `<p style="margin-top:10px">Check your email. We sent a sign-in link to <b>${esc(sent)}</b>. Open it on this device.</p>
      <button class="btn" style="margin-top:16px" data-act="login-again">Use a different email</button>`
    : `<p class="muted" style="margin-top:8px">Enter the email address QuadReal has on file for you. We’ll email you a link to sign in.</p>
      <label class="f" for="email" style="margin-top:18px">Email</label>
      <input type="text" id="email" inputmode="email" autocomplete="email" placeholder="you@company.com">
      <p class="err" id="loginErr" style="margin-top:8px">${esc(err||'')}</p>
      <button class="btn primary" style="margin-top:10px;width:100%" data-act="login">Email me a sign-in link</button>`}
  </section>`;
  const e = document.getElementById('email'); if(e) e.focus();
}
async function sendLink(){
  const email = (document.getElementById('email').value||'').trim();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showLogin(null, 'Enter a valid email address.');
  const b = document.querySelector('[data-act=login]'); b.disabled = true; b.textContent = 'Sending…';
  const { error } = await sb.auth.signInWithOtp({ email, options:{ shouldCreateUser:false, emailRedirectTo: location.origin } });
  if(error) return showLogin(null, /signup|not allowed|not found/i.test(error.message) ? 'That email isn’t set up for the portal. Contact your QuadReal representative.' : error.message);
  showLogin(email);
}

async function startSession(user){
  if(S.started) return; S.started = true; S.user = user;
  app.innerHTML = `<div class="empty"><span class="spin"></span>Loading your account…</div>`;
  const [st, vu, imp] = await Promise.all([
    sb.from('staff').select('role').eq('user_id', user.id).maybeSingle(),
    sb.from('vendor_users').select('vendor_code, vendors(name)').eq('user_id', user.id),
    sb.from('imports').select('*').order('imported_at',{ascending:false}).limit(20)
  ]);
  S.staff = !!st.data;
  S.codes = (vu.data||[]).map(r=>r.vendor_code).sort();
  (vu.data||[]).forEach(r=>{ S.vnames[r.vendor_code] = (r.vendors && r.vendors.name) || r.vendor_code; });
  S.imports = imp.data || [];
  if(!S.staff && !S.codes.length){
    header(true);
    app.innerHTML = `<section class="login panel"><h2>Your account isn’t linked to a vendor yet</h2><p class="muted" style="margin-top:8px">You’re signed in as ${esc(user.email)}. Contact your QuadReal representative to connect your account to your vendor code.</p></section>`;
    return;
  }
  S.vendor = S.codes[0] || null;
  S.view = S.codes.length ? 'vendor' : 'bo';
  await reload(); render();
  setInterval(()=>{ if(document.visibilityState==='visible' && !busyTyping() && !S.submitting && !S.imp?.busy) reload().then(onData).catch(()=>{}); }, 30000);
}

/* ---------- data ---------- */
async function reload(){
  const imp = await sb.from('imports').select('*').order('imported_at',{ascending:false}).limit(20);
  if(!imp.error) S.imports = imp.data;
  if(S.view==='vendor') return loadVendor();
  return loadBo();
}
async function loadVendor(){
  const [it, rq] = await Promise.all([
    sb.from('item_availability').select('*').eq('vendor_code', S.vendor).order('available',{ascending:false}).limit(1000),
    sb.from('requests').select('*, request_events(*)').eq('vendor_code', S.vendor).order('submitted_at',{ascending:false}).limit(200)
  ]);
  if(it.error) throw it.error; if(rq.error) throw rq.error;
  S.items = it.data.map(toItem); S.byId = Object.fromEntries(S.items.map(i=>[i.id,i]));
  S.reqs = rq.data.map(toReq);
}
async function loadBo(){
  const rq = await sb.from('requests').select('*, request_events(*), vendors(name)').order('submitted_at',{ascending:false}).limit(500);
  if(rq.error) throw rq.error;
  S.reqs = rq.data.map(toReq);
  const ids = [...new Set(S.reqs.map(r=>r.item))], out = {};
  for(let i=0;i<ids.length;i+=150){
    const { data, error } = await sb.from('item_availability').select('*').in('id', ids.slice(i,i+150));
    if(error) throw error; data.forEach(x=>out[x.id]=toItem(x));
  }
  S.byId = out;
}
async function loadJobs(id){
  if(S.jobs[id]) return S.jobs[id];
  const { data, error } = await sb.from('item_jobs').select('*').eq('item_id', id).order('job_code');
  if(error) throw error; return (S.jobs[id] = data);
}

/* ---------- shell ---------- */
function header(signedIn){
  const nav = document.getElementById('nav');
  if(!signedIn){ nav.innerHTML = ''; return; }
  const both = S.staff && S.codes.length;
  nav.innerHTML = `${both?`<div class="seg" role="group" aria-label="Switch view"><button data-act="view" data-v="vendor" aria-pressed="${S.view==='vendor'}">Vendor portal</button><button data-act="view" data-v="bo" aria-pressed="${S.view==='bo'}">Back end</button></div>`:''}
    <span class="asof">${S.imports[0]?`Yardi data as of ${dfmt(S.imports[0].data_as_of)}`:'No Yardi data loaded yet'}</span>
    <span class="who small">${esc(S.user.email)}</span><button class="btn" data-act="signout" style="padding:6px 12px">Sign out</button>`;
}
function render(){
  header(true);
  app.innerHTML = (S.view==='vendor' ? vendorHero() : boHero()) + '<div id="body"></div>';
  renderBody();
}
function renderBody(){
  const b = document.getElementById('body'); if(!b) return;
  b.innerHTML = S.view==='vendor' ? vendorBody() : boBody();
  if(S.view==='vendor' && S.vtab==='submit'){ renderItemList(); renderChecks(); }
  if(S.view==='bo' && S.btab==='queue'){ renderQueue(); renderReview(); }
}
function onData(){
  header(true);
  const hero = document.getElementById('hero'); if(hero) hero.outerHTML = S.view==='vendor' ? vendorHero() : boHero();
  if(!document.getElementById('body')) return;
  if(S.view==='vendor'){
    const c = document.getElementById('reqCount'); if(c) c.textContent = S.reqs.length;
    if(S.vtab==='submit'){ renderItemList(); renderChecks(); } else if(busyTyping()) S.dirty = true; else renderBody();
  } else if(S.btab==='queue'){
    renderQueue();
    const r = S.reqs.find(x=>x.id===S.sel), note = document.getElementById('boNote');
    if((r?JSON.stringify(r):'')!==S.selSig && !(note && note.value.trim())) renderReview();
  } else if(!S.imp) renderBody();
}

function meterHTML(it, amount, pend){
  const base = Math.max(it.rem,0), a = Math.max(+amount||0,0), avl = r2(it.rem - pend), after = r2(avl - a), over = after < 0;
  const total = Math.max(base, pend + a, 1), w = x => (Math.max(x,0)/total*100).toFixed(2)+'%';
  return `<div class="meter">
    <div class="meter-bar" role="img" aria-label="Balance ${money(base)}, pending ${money(pend)}, this invoice ${money(a)}, ${over?'over by '+money(-after):'left after '+money(after)}">
      <span class="m-pend" style="width:${w(pend)}"></span><span class="${over?'m-over':'m-this'}" style="width:${w(a)}"></span><span class="m-left" style="width:${w(after)}"></span></div>
    <div class="meter-legend">
      <div><span class="sw" style="background:var(--ink)"></span>Balance in Yardi<b>${money(it.rem)}</b></div>
      <div><span class="sw m-pend"></span>Pending in portal<b>${money(pend)}</b></div>
      <div><span class="sw" style="background:${over?'var(--bad)':'var(--blue)'}"></span>This invoice<b>${money(a)}</b></div>
      <div><span class="sw" style="background:${over?'var(--bad)':'var(--fund)'}"></span>${over?'Over by':'Left after'}<b class="${over?'neg':''}">${money(Math.abs(after))}</b></div>
    </div></div>`;
}

/* ================= VENDOR ================= */
function vendorHero(){
  const inprog = S.reqs.filter(r=>!['Paid','Rejected'].includes(r.status)).length;
  const totAvail = S.items.reduce((s,i)=>s+Math.max(i.avail,0),0);
  return `<section class="hero" id="hero">
    ${S.codes.length>1?`<div class="row hero-top"><label class="small" for="vsel">Billing as</label><select id="vsel" class="inline">${S.codes.map(v=>`<option value="${v}" ${v===S.vendor?'selected':''}>${esc(vname(v))} (${v})</option>`).join('')}</select></div>`:''}
    <h2>Welcome, ${esc(vname(S.vendor))}</h2>
    <p class="hero-sub">Vendor ${esc(S.vendor)}. Submit invoices against your QuadReal POs and contracts, and follow each one through to payment.</p>
    <div class="hero-stats">
      <div><span>Open POs</span><b>${S.items.filter(i=>i.t==='PO'&&i.avail>0.005).length}</b></div>
      <div><span>Open contracts</span><b>${S.items.filter(i=>i.t==='Contract'&&i.avail>0.005).length}</b></div>
      <div><span>Available to bill</span><b>${money(totAvail)}</b></div>
      <div><span>Payments in progress</span><b>${inprog}</b></div>
    </div></section>`;
}
function vendorBody(){
  return `<div class="tabs" role="tablist">
    ${[['submit','Submit an invoice'],['pos','My POs and contracts'],['reqs','My payment requests']].map(([k,l])=>`<button role="tab" aria-selected="${S.vtab===k}" data-act="vtab" data-v="${k}">${l}${k==='reqs'?`<span class="count" id="reqCount">${S.reqs.length}</span>`:''}</button>`).join('')}
  </div>${S.vtab==='submit'?submitView():S.vtab==='pos'?posView():reqsView()}`;
}
function newDraft(){ return {stage:'empty', file:'', path:'', fileSize:0, invNo:'', invDate:'', extracted:null, amount:'', item:null, readNote:'', nameOnInvoice:'', refOnInvoice:'', autoPicked:false, hint:''}; }

function submitView(){
  const d = S.draft || (S.draft = newDraft());
  let up;
  if(d.stage==='empty') up = `
    <div class="drop" id="drop" tabindex="0" role="button" aria-label="Upload invoice PDF">
      <p><b>Drop your invoice PDF here</b> or click to choose a file</p>
      <p class="small muted" style="margin-top:4px">One invoice per request. PDF, up to 10 MB.</p>
    </div>
    <input type="file" id="file" accept="application/pdf,.pdf" hidden>
    ${d.readNote?`<div class="note b small">${esc(d.readNote)}</div>`:''}
    <p class="small muted" style="margin-top:10px">The invoice number, date, and total are read from your PDF. You check them before you submit.</p>`;
  else if(d.stage==='uploading' || d.stage==='reading') up = `<div class="file"><div class="file-ic">PDF</div><div><b>${esc(d.file)}</b><p class="small muted"><span class="spin"></span>${d.stage==='uploading'?'Uploading…':'Reading your invoice…'}</p></div></div>`;
  else up = `<div class="file"><div class="file-ic">PDF</div><div style="flex:1"><b>${esc(d.file)}</b><p class="small muted">${d.readNote?'Enter the details from your invoice.':'Details read from your invoice. Check each field.'}</p></div><button class="btn" data-act="clearfile">Replace</button></div>
    ${d.readNote?`<div class="note w small">${esc(d.readNote)}</div>`:''}`;
  const ready = d.stage==='ready';
  return `<div class="submit">
    <section class="panel pad">
      <div class="step"><span class="step-n">1</span><h3>Upload your invoice</h3></div>${up}
      <div style="margin-top:22px" class="step"><span class="step-n">2</span><h3>Check the invoice details</h3></div>
      <fieldset ${ready?'':'disabled'} style="border:0;padding:0;margin:0" class="stack">
        <div class="grid2">
          <div><label class="f" for="invNo">Invoice number</label><input type="text" id="invNo" data-in="invNo" value="${esc(d.invNo)}"></div>
          <div><label class="f" for="invDate">Invoice date</label><input type="date" id="invDate" data-in="invDate" value="${esc(d.invDate)}"></div>
        </div>
        <div><label class="f" for="amt">Invoice total (CAD, including tax)</label><input type="text" inputmode="decimal" id="amt" data-in="amount" value="${esc(d.amount)}"><p class="extracted" id="amtnote"></p></div>
      </fieldset>
    </section>
    <section class="panel pad">
      <div class="step"><span class="step-n">3</span><h3>Choose the PO or contract this invoice bills against</h3></div>
      <input type="search" id="itemQ" placeholder="Search by number, property, or description" value="${esc(S.itemQ)}" ${ready?'':'disabled'} aria-label="Search POs and contracts">
      <p class="small" id="autopick" style="margin-top:8px"></p>
      <div class="list" id="itemList" style="margin-top:8px"></div>
      <div id="meter" style="margin-top:16px"></div>
      <div style="margin-top:22px" class="step"><span class="step-n">4</span><h3>Submit for payment</h3></div>
      <ul class="checks" id="checks"></ul>
      <div class="row" style="margin-top:14px"><button class="btn primary" id="submitBtn" data-act="submit">${S.submitting?'Submitting…':'Submit invoice'}</button><span class="small" id="submitHint"></span></div>
    </section></div>`;
}
function renderItemList(){
  const el = document.getElementById('itemList'); if(!el) return;
  const d = S.draft, q = S.itemQ.trim().toLowerCase();
  let its = S.items; if(q) its = its.filter(i=>(i.code+' '+i.prop+' '+i.desc+' '+i.cat+' '+i.t).toLowerCase().includes(q));
  const shown = its.slice(0,60);
  el.innerHTML = shown.length ? shown.map(it=>{
    const off = it.avail<=0.005, on = d.item===it.id, dis = off || d.stage!=='ready';
    return `<div class="opt ${on?'sel':''} ${off?'off':''}" data-act="pick" data-id="${esc(it.id)}" role="radio" aria-checked="${on}" tabindex="${dis?-1:0}" aria-disabled="${off}">
      <input type="radio" name="item" ${on?'checked':''} ${dis?'disabled':''} tabindex="-1" aria-hidden="true">
      <div><span class="kind">${it.t}</span><span class="t">${esc(it.code)}</span><span class="sub small muted" style="display:block">${esc(it.prop)}, ${esc(it.desc)}</span></div>
      <div class="num"><b>${money(it.avail)}</b><span class="sub small muted" style="display:block">${off?'Fully used':'available'}</span></div></div>`;
  }).join('') + (its.length>60?`<div class="opt small muted" style="cursor:default">Showing 60 of ${its.length}. Search to narrow the list.</div>`:'')
  : `<div class="empty small">${q?'No POs or contracts match that search.':'You have no open POs or contracts. Contact your QuadReal project manager.'}</div>`;
  const ap = document.getElementById('autopick');
  if(ap) ap.innerHTML = d.autoPicked && d.item ? `<span style="color:var(--fund)">Matched ${esc(itemLabel(S.byId[d.item]))} from the reference on your invoice. Change it if that’s wrong.</span>`
    : (d.refOnInvoice && !d.item ? `<span class="muted">Your invoice references “${esc(d.refOnInvoice)}”. Pick the matching PO or contract.</span>` : '');
  const m = document.getElementById('meter');
  if(m) m.innerHTML = d.item && S.byId[d.item] ? `<p class="small"><b>${itemLabel(S.byId[d.item])}</b> balance</p>${meterHTML(S.byId[d.item], d.amount, S.byId[d.item].pending)}` : '';
}
function draftChecks(d){
  const amt = +d.amount, it = d.item && S.byId[d.item], res = [];
  res.push(d.stage==='ready' ? {ok:true,t:'Invoice PDF attached'} : {ok:null,t:'Attach your invoice PDF'});
  if(d.stage!=='ready') return res;
  res.push(d.invNo.trim() ? {ok:true,t:'Invoice number entered'} : {ok:false,t:'Enter the invoice number'});
  res.push(amt>0 && isFinite(amt) ? {ok:true,t:'Invoice total entered'} : {ok:false,t:'Enter the invoice total as a number'});
  res.push(it ? {ok:true,t:`Billing against ${itemLabel(it)}`} : {ok:false,t:'Choose a PO or contract. Invoices without one can’t be processed.'});
  if(it && amt>0) res.push(amt<=it.avail ? {ok:true,t:`Enough funds: ${money(it.avail)} available`} : {ok:false,t:`Not enough funds. ${itemLabel(it)} has ${money(it.avail)} available. Contact your project manager about a change order.`});
  if(d.invNo.trim()) res.push(S.reqs.some(r=>r.status!=='Rejected' && norm(r.invNo)===norm(d.invNo)) ? {ok:false,t:`Invoice ${d.invNo} was already submitted in the portal.`} : {ok:true,t:'No duplicate found in your requests'});
  return res;
}
function renderChecks(){
  const el = document.getElementById('checks'); if(!el) return;
  const d = S.draft, c = draftChecks(d), ok = d.stage==='ready' && c.every(x=>x.ok===true);
  el.innerHTML = c.map(x=>`<li><span class="ck ${x.ok===true?'ok':x.ok===false?'no':'wait'}" aria-hidden="true">${x.ok===true?'✓':x.ok===false?'!':'·'}</span><span>${esc(x.t)}</span></li>`).join('');
  const b = document.getElementById('submitBtn'); b.disabled = !ok || S.submitting;
  const h = document.getElementById('submitHint'); h.className = 'small'+(d.hint?' err':' muted');
  h.textContent = d.hint || (ok ? 'Goes to QuadReal accounts payable for review. Yardi is checked for duplicates when you submit.' : '');
  const n = document.getElementById('amtnote');
  if(n){ if(d.stage!=='ready') n.innerHTML='';
    else if(d.extracted==null) n.innerHTML='Enter the total due, including tax.';
    else { const edited = d.amount!=='' && r2(+d.amount)!==d.extracted;
      n.innerHTML = edited ? `<span class="flag">You changed this from ${money(d.extracted)} read from the invoice. Reviewers will see both amounts.</span>` : `Read from the invoice: ${money(d.extracted)}`; } }
  const m = document.getElementById('meter');
  if(m && d.item && S.byId[d.item]) m.innerHTML = `<p class="small"><b>${itemLabel(S.byId[d.item])}</b> balance</p>${meterHTML(S.byId[d.item], d.amount, S.byId[d.item].pending)}`;
}

async function takeFile(f){
  const d = S.draft;
  if(!(f.type==='application/pdf' || /\.pdf$/i.test(f.name))){ d.readNote = 'Upload the invoice as a PDF file.'; return renderBody(); }
  if(f.size > 10*1024*1024){ d.readNote = 'That file is over 10 MB. Upload a smaller PDF.'; return renderBody(); }
  const token_ = ++S.readToken;
  Object.assign(d, newDraft(), {stage:'uploading', file:f.name, fileSize:f.size});
  renderBody();
  const path = `${S.vendor}/${crypto.randomUUID()}.pdf`;
  const up = await sb.storage.from('invoices').upload(path, f, {contentType:'application/pdf', upsert:false});
  if(token_!==S.readToken || S.draft!==d) return;
  if(up.error){ Object.assign(d, newDraft(), {readNote:'The PDF couldn’t be uploaded. Check your connection and try again.'}); return renderBody(); }
  d.path = path; d.stage = 'reading'; renderBody();
  let r = null, err = '';
  try{ r = await api('/api/extract', {path}); }catch(e){ err = errText(e); }
  if(token_!==S.readToken || S.draft!==d) return;
  const tot = r && r.total!=null && isFinite(+r.total) ? r2(+r.total) : null;
  Object.assign(d, {stage:'ready', invNo: r && r.invoice_number ? String(r.invoice_number) : '', invDate: r && /^\d{4}-\d{2}-\d{2}$/.test(r.invoice_date||'') ? r.invoice_date : '',
    extracted: tot, amount: tot!=null ? tot.toFixed(2) : '', nameOnInvoice: (r && r.vendor_name) || '', refOnInvoice: (r && r.reference) || '',
    readNote: err ? `The invoice couldn’t be read automatically (${err}) Enter the details yourself.` : (tot==null ? 'The total couldn’t be found on this invoice. Enter it below.' : '')});
  if(d.refOnInvoice){
    const refs = norm(d.refOnInvoice).split(/[\s,;\/]+/).map(x=>x.replace(/^(PO|CONTRACT|NO\.?|#)[#:\-]*/,'')).filter(Boolean);
    const hit = S.items.find(i=>i.avail>0.005 && refs.includes(norm(i.code)));
    if(hit){ d.item = hit.id; d.autoPicked = true; }
  }
  renderBody();
}
async function submitDraft(){
  const d = S.draft; if(S.submitting || !draftChecks(d).every(x=>x.ok===true)) return;
  S.submitting = true; d.hint = ''; renderChecks(); document.getElementById('submitBtn').textContent = 'Submitting…';
  const { data, error } = await sb.rpc('submit_request', {
    p_vendor_code:S.vendor, p_item_id:d.item, p_invoice_no:d.invNo.trim(), p_invoice_date:d.invDate||null, p_amount:r2(+d.amount), p_extracted:d.extracted,
    p_file_path:d.path, p_file_name:d.file, p_file_size:d.fileSize, p_source: d.extracted!=null ? 'claude' : 'manual',
    p_name_on_invoice:d.nameOnInvoice||null, p_ref_on_invoice:d.refOnInvoice||null });
  S.submitting = false;
  if(error){ d.hint = errText(error,'Couldn’t submit. Try again.'); const b=document.getElementById('submitBtn'); if(b) b.textContent='Submit invoice'; await loadVendor().catch(()=>{}); renderItemList(); return renderChecks(); }
  S.draft = newDraft(); S.itemQ = ''; S.vtab = 'reqs';
  await loadVendor().catch(()=>{}); render(); toast(`Invoice submitted as ${data}`);
}

function posView(){
  const q = S.posQ.trim().toLowerCase();
  const its = S.items.filter(i=>!q || (i.code+' '+i.prop+' '+i.desc+' '+i.cat).toLowerCase().includes(q));
  const tbl = t => { const a = its.filter(i=>i.t===t); if(!a.length) return `<p class="muted pad">No open ${t==='PO'?'POs':'contracts'}${q?' match that search':''}.</p>`;
    return `<div class="tw"><table><thead><tr><th>${t} number</th><th>Property and work</th><th>Category</th><th>${t==='PO'?'Ordered':'Requested'}</th><th class="num">${t==='PO'?'PO amount':'Commitment'}</th><th class="num">Invoiced</th><th class="num">Pending in portal</th><th class="num">Available</th></tr></thead><tbody>
    ${a.map(i=>`<tr><td><b>${esc(i.code)}</b></td><td>${esc(i.prop)}<span class="sub">${esc(i.desc)}</span></td><td>${esc(i.cat)}</td><td>${dfmt(i.date)}</td><td class="num">${money(i.amt)}</td><td class="num">${money(i.inv)}</td><td class="num">${money(i.pending)}</td><td class="num"><b>${money(i.avail)}</b></td></tr>`).join('')}
    <tr><td colspan="7" class="muted">${a.length} ${t==='PO'?'POs':'contracts'}</td><td class="num"><b>${money(a.reduce((s,i)=>s+Math.max(i.avail,0),0))}</b></td></tr></tbody></table></div>`; };
  return `<div class="row" style="margin-bottom:14px"><input type="search" id="posQ" placeholder="Search your POs and contracts" value="${esc(S.posQ)}" style="max-width:380px" aria-label="Search POs and contracts"><span class="small muted">${S.imports[0]?`Balances as of ${dfmt(S.imports[0].data_as_of)}, less invoices submitted here that aren’t in Yardi yet.`:''}</span></div>
    <section class="panel" style="margin-bottom:18px"><div class="pad" style="padding-bottom:6px"><h3>Purchase orders</h3></div>${tbl('PO')}</section>
    <section class="panel"><div class="pad" style="padding-bottom:6px"><h3>Contracts</h3></div>${tbl('Contract')}</section>`;
}
function trackHTML(r){
  if(r.status==='Rejected') return '';
  const cur = r.status==='Needs info' ? 1 : FLOW.indexOf(r.status);
  return `<div class="track">${FLOW.map((s,i)=>`<div class="${i<cur||(i===cur&&s==='Paid')?'done':i===cur?'now':''}">${s==='In review'&&r.status==='Needs info'?'Needs your reply':s}</div>`).join('')}</div>`;
}
function reqsView(){
  if(!S.reqs.length) return `<section class="panel"><div class="empty"><p><b>No payment requests yet</b></p><p class="small" style="margin-top:6px">Submit an invoice to start a payment request.</p><button class="btn primary" style="margin-top:12px" data-act="vtab" data-v="submit">Submit an invoice</button></div></section>`;
  return `<section class="panel">${S.reqs.map(r=>{ const it = S.byId[r.item], last = r.history[r.history.length-1] || {note:'',at:r.submitted};
    return `<article class="req">
      <div class="row" style="justify-content:space-between"><div><b>Invoice ${esc(r.invNo)}</b> <span class="muted small">${esc(r.id)}</span><p class="small muted">${it?`${itemLabel(it)}, ${esc(it.prop)}`:esc(r.item)}. Submitted ${tfmt(r.submitted)}</p></div>
      <div class="row"><b>${money(r.amount)}</b><span class="pill ${sc(r.status)}">${r.status==='Needs info'?'Needs your reply':r.status}</span></div></div>
      ${trackHTML(r)}
      ${r.status==='Needs info'?`<div class="note w"><b>Accounts payable asked:</b> ${esc(last.note)}<div style="margin-top:8px"><label class="f" for="reply-${esc(r.id)}">Your reply</label><textarea id="reply-${esc(r.id)}" placeholder="Answer the question"></textarea><div class="row" style="margin-top:8px"><button class="btn primary" data-act="reply" data-id="${esc(r.id)}">Send reply</button><span class="err" id="rerr-${esc(r.id)}"></span></div></div></div>`:''}
      ${r.status==='Rejected'?`<div class="note b"><b>Not processed:</b> ${esc(last.note)} You can submit a corrected invoice.</div>`:''}
      ${r.status==='Paid'?`<p class="small muted" style="margin-top:8px">Paid ${tfmt(last.at)}.${last.note?' '+esc(last.note):''}</p>`:''}
    </article>`;}).join('')}</section>`;
}

/* ================= BACK END ================= */
const FILTERS = [['action','Needs action',r=>['Submitted','In review'].includes(r.status)],['Needs info','Waiting on vendor',r=>r.status==='Needs info'],['Approved','Approved',r=>r.status==='Approved'],['Entered in Yardi','In Yardi',r=>r.status==='Entered in Yardi'],['Paid','Paid',r=>r.status==='Paid'],['Rejected','Rejected',r=>r.status==='Rejected'],['all','All',()=>true]];
function boHero(){
  const cnt = fn => S.reqs.filter(fn).length;
  const waitAmt = S.reqs.filter(r=>['Submitted','In review'].includes(r.status)).reduce((s,r)=>s+r.amount,0);
  return `<section class="hero" id="hero"><h2>Accounts payable review</h2>
    <p class="hero-sub">Invoices submitted by vendors through the portal. Review the attachment and funds, then approve, ask a question, or reject.</p>
    <div class="hero-stats">
      <div><span>Needs action</span><b>${cnt(r=>['Submitted','In review'].includes(r.status))}</b></div>
      <div><span>Value awaiting review</span><b>${money(waitAmt)}</b></div>
      <div><span>Waiting on vendor</span><b>${cnt(r=>r.status==='Needs info')}</b></div>
      <div><span>Approved, not yet in Yardi</span><b>${cnt(r=>r.status==='Approved')}</b></div>
    </div></section>`;
}
function boBody(){
  return `<div class="tabs" role="tablist">${[['queue','Review queue'],['import','Import data']].map(([k,l])=>`<button role="tab" aria-selected="${S.btab===k}" data-act="btab" data-v="${k}">${l}</button>`).join('')}</div>
  ${S.btab==='queue'?`<div class="bo"><section><div class="row" style="margin-bottom:12px;justify-content:space-between"><div class="chips" id="chips"></div><input type="search" id="boQ" placeholder="Search vendor, invoice, PO" value="${esc(S.q)}" style="max-width:240px" aria-label="Search requests"></div><div class="panel" id="queue"></div></section><aside class="review" id="review"></aside></div>`:importView()}`;
}
function flags(r){ const it = S.byId[r.item], f = [];
  if(r.extracted!=null && r.amount!==r.extracted) f.push(['w','Amount edited']);
  if(r.source==='manual') f.push(['w','Entered by hand']);
  if(r.history.some(h=>h.s==='Needs info') && r.status==='In review') f.push(['','Vendor replied']);
  if(!it) f.push(['w','No longer open']);
  return f; }
function renderQueue(){
  const chips = document.getElementById('chips'); if(!chips) return;
  chips.innerHTML = FILTERS.map(([k,l,fn])=>`<button class="chip" aria-pressed="${S.filter===k}" data-act="filter" data-v="${k}">${l} <span class="muted">${S.reqs.filter(fn).length}</span></button>`).join('');
  const fn = FILTERS.find(f=>f[0]===S.filter)[2], q = S.q.trim().toLowerCase();
  const list = S.reqs.filter(fn).filter(r=>!q || (vname(r.v)+' '+r.v+' '+r.invNo+' '+r.item+' '+r.id).toLowerCase().includes(q));
  document.getElementById('queue').innerHTML = list.length ? `<div class="tw"><table><thead><tr><th>Request</th><th>Vendor</th><th>Billed to</th><th class="num">Amount</th><th>Status</th></tr></thead><tbody>
    ${list.map(r=>{ const it = S.byId[r.item]; return `<tr class="click ${S.sel===r.id?'on':''}" data-act="sel" data-id="${esc(r.id)}" tabindex="0"><td><b>${esc(r.id)}</b><span class="sub">Inv ${esc(r.invNo)}, ${tfmt(r.submitted)}</span></td><td>${esc(vname(r.v))}<span class="sub">${esc(r.v)}</span></td><td>${it?itemLabel(it):esc(r.item)}<span class="sub">${it?esc(it.prop):''}</span></td><td class="num"><b>${money(r.amount)}</b><span class="sub">${flags(r).map(([c,t])=>`<span class="tag ${c}">${t}</span>`).join('')}</span></td><td><span class="pill ${sc(r.status)}">${r.status}</span></td></tr>`; }).join('')}
  </tbody></table></div>` : `<div class="empty">${S.reqs.length?'No requests in this view.':'No requests yet. They appear here as vendors submit invoices.'}</div>`;
}
async function renderReview(){
  const el = document.getElementById('review'); if(!el) return;
  const r = S.reqs.find(x=>x.id===S.sel); S.selSig = r ? JSON.stringify(r) : '';
  if(!r){ el.innerHTML = `<div class="panel"><div class="empty"><p><b>Select a request to review it</b></p><p class="small" style="margin-top:6px">You’ll see the invoice, the funds check, and the job breakdown side by side.</p></div></div>`; return; }
  const it = S.byId[r.item], open = ['Submitted','In review','Needs info'].includes(r.status);
  const pend = it ? pendExcl(it, r) : 0, avlBefore = it ? r2(it.rem - pend) : 0, fundsOk = it && r.amount<=avlBefore;
  const readBy = r.source==='claude' ? 'Read from the PDF by Claude' : 'Entered by the vendor';
  el.innerHTML = `<div class="panel pad stack">
    <div class="row" style="justify-content:space-between"><div><h2>${esc(r.id)}</h2><p class="small muted">${esc(vname(r.v))} (${esc(r.v)})</p></div><span class="pill ${sc(r.status)}">${r.status}</span></div>
    <div><h3>Invoice attachment</h3><div class="att-meta" id="attMeta"></div><div class="viewer" id="att" aria-label="Invoice attachment preview"></div></div>
    <dl class="kv">
      <dt>Invoice no.</dt><dd>${esc(r.invNo)}</dd>
      <dt>Invoice date</dt><dd>${dfmt(r.invDate)||'Not given'}</dd>
      <dt>Read from PDF</dt><dd>${r.extracted!=null?money(r.extracted):'Not read'}<span class="sub muted" style="display:block">${readBy}</span></dd>
      <dt>Vendor confirmed</dt><dd><b>${money(r.amount)}</b>${r.extracted!=null && r.amount!==r.extracted?`<span class="sub flag" style="display:block">Differs by ${money(Math.abs(r.amount-r.extracted))}</span>`:''}</dd>
      ${r.nameOnInvoice?`<dt>Name on invoice</dt><dd>${esc(r.nameOnInvoice)}</dd>`:''}
      ${r.refOnInvoice?`<dt>Reference on invoice</dt><dd>${esc(r.refOnInvoice)}</dd>`:''}
      <dt>Billed to</dt><dd>${it?`${itemLabel(it)}<span class="sub muted" style="display:block">${esc(it.prop)}, ${esc(it.cat)}</span>`:`${esc(r.item)}<span class="sub neg" style="display:block">Not in the latest Yardi import</span>`}</dd>
      <dt>Submitted</dt><dd>${tfmt(r.submitted)}</dd>
    </dl>
    ${it?`<div><h3>Funds check</h3>${r.reflected?`<p class="small muted">This invoice is already reflected in the Yardi balance below.</p>`:''}${meterHTML(it, r.reflected?0:r.amount, pend)}
      ${!r.reflected?`<p class="small" style="margin-top:6px">${fundsOk?`<span style="color:var(--fund)">Funds available.</span>`:`<span class="neg">Not enough funds now: other requests or a new import reduced the balance.</span>`}</p>`:''}</div>
    <div><h3>Job breakdown for ${itemLabel(it)}</h3><p class="small muted">Rows that count toward available funds. Code this invoice to the right job when entering it in Yardi.</p><div class="tw" id="jobs"><p class="small muted"><span class="spin"></span>Loading jobs…</p></div></div>`:''}
    ${open?`<div><label class="f" for="boNote">Note to vendor</label><textarea id="boNote" placeholder="Required to reject or to ask for more information"></textarea>
      <div class="row" style="margin-top:10px"><button class="btn good" data-act="approve" ${fundsOk?'':'disabled'}>Approve</button><button class="btn" data-act="askinfo">Ask for information</button><button class="btn danger" data-act="reject">Reject</button><span class="err" id="boErr"></span></div></div>`:''}
    ${r.status==='Approved'?`<p class="note" style="background:var(--fund-soft)">Approved. Enter it in Yardi; the next import matches it by vendor code and invoice number and moves it to “Entered in Yardi.”</p>`:''}
    ${r.status==='Entered in Yardi'?`<div class="row"><button class="btn good" data-act="paid">Mark as paid</button></div>`:''}
    <div><h3>History</h3><ul class="hist" style="margin-top:6px">${r.history.slice().reverse().map(h=>`<li><b>${esc(h.s)}</b> <span class="muted">by ${esc(h.by)}, ${tfmt(h.at)}</span>${h.note?`<div class="small">${esc(h.note)}</div>`:''}</li>`).join('')}</ul></div>
  </div>`;
  renderAttachment(r);
  if(it){ try{ const jobs = await loadJobs(it.id); const j = document.getElementById('jobs'); if(j && S.sel===r.id) j.innerHTML = jobs.length ? `<table><thead><tr><th>Job</th><th>Status</th><th class="num">Amount</th><th class="num">Invoiced</th><th class="num">Remaining</th></tr></thead><tbody>${jobs.map(x=>`<tr><td>${esc(x.job_code)}<span class="sub">${esc(x.job_description)}</span></td><td>${esc(x.job_status)}</td><td class="num">${money(+x.amount)}</td><td class="num">${money(+x.invoiced)}</td><td class="num ${+x.remaining<0?'neg':''}">${money(+x.remaining)}</td></tr>`).join('')}</tbody></table>` : `<p class="small muted">No job rows in the latest import.</p>`; }
    catch(e){ const j = document.getElementById('jobs'); if(j) j.innerHTML = `<p class="err">Job breakdown couldn’t load.</p>`; } }
}

if(window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
let attToken = 0;
async function renderAttachment(r){
  const box = document.getElementById('att'), meta = document.getElementById('attMeta'); if(!box) return;
  const my = ++attToken;
  box.className = 'viewer'+(S.bigView?' big':''); box.innerHTML = `<p class="small muted"><span class="spin"></span>Loading invoice…</p>`;
  const { data, error } = await sb.storage.from('invoices').createSignedUrl(r.filePath, 900);
  if(my!==attToken) return;
  if(error || !data){ meta.innerHTML = ''; box.innerHTML = `<p class="err">The invoice PDF couldn’t be found in storage.</p>`; return; }
  meta.innerHTML = `<span class="file-ic" style="width:26px;height:30px;font-size:9px">PDF</span><span><b>${esc(r.file)}</b> <span class="small muted">${kb(r.fileSize)}<span id="attPages"></span></span></span>
    <span style="margin-left:auto" class="row"><a class="btn" href="${esc(data.signedUrl)}" target="_blank" rel="noopener" style="padding:4px 10px;text-decoration:none">Open PDF</a><button class="btn" data-act="bigview" style="padding:4px 10px">${S.bigView?'Shrink preview':'Expand preview'}</button></span>`;
  if(!window.pdfjsLib){ box.innerHTML = `<p class="small">The preview couldn’t load. Use Open PDF instead.</p>`; return; }
  try{
    const buf = await (await fetch(data.signedUrl)).arrayBuffer(); if(my!==attToken) return;
    const pdf = await pdfjsLib.getDocument({data:buf}).promise; if(my!==attToken) return;
    const n = Math.min(pdf.numPages, 15), pg = document.getElementById('attPages'); if(pg) pg.textContent = `${r.fileSize?', ':''}${pdf.numPages} page${pdf.numPages>1?'s':''}`;
    box.innerHTML = '';
    const width = Math.max(box.clientWidth - 20, 300), dpr = window.devicePixelRatio || 1;
    for(let i=1;i<=n;i++){
      const page = await pdf.getPage(i); if(my!==attToken) return;
      const v0 = page.getViewport({scale:1}), vp = page.getViewport({scale: width/v0.width*dpr});
      const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height; c.setAttribute('role','img'); c.setAttribute('aria-label',`Invoice page ${i}`);
      box.appendChild(c); await page.render({canvasContext:c.getContext('2d'), viewport:vp}).promise;
    }
    if(pdf.numPages>n) box.insertAdjacentHTML('beforeend',`<p class="small muted">Showing the first ${n} of ${pdf.numPages} pages. Use Open PDF for the rest.</p>`);
  }catch(e){ if(my===attToken) box.innerHTML = `<p class="err">The preview couldn’t be displayed. Use Open PDF instead.</p>`; }
}
async function boAction(kind){
  const r = S.reqs.find(x=>x.id===S.sel); if(!r) return;
  const note = (document.getElementById('boNote')?.value||'').trim(), err = document.getElementById('boErr');
  if((kind==='reject'||kind==='askinfo') && !note){ err.textContent = kind==='reject'?'Add a reason so the vendor knows what to fix.':'Add the question for the vendor.'; return; }
  const status = {approve:'Approved', reject:'Rejected', askinfo:'Needs info', paid:'Paid'}[kind];
  document.querySelectorAll('#review .btn').forEach(b=>b.disabled=true);
  const { error } = await sb.rpc('set_request_status', {p_id:r.id, p_status:status, p_note: note || null});
  if(error){ toast(errText(error)); document.querySelectorAll('#review .btn').forEach(b=>b.disabled=false); return; }
  toast(kind==='approve'?`${r.id} approved`:kind==='reject'?`${r.id} rejected`:kind==='askinfo'?`Question sent to ${vname(r.v)}`:`${r.id} marked as paid`);
  await loadBo().catch(()=>{}); render();
}

/* ---------- import ---------- */
const PO_COLS = ['Vendor Code','Vendor Name','PO Code','PO Line Status','PO Workflow Status','Job Status','Job Code','Job Description','Property Code','Property Name','Cost Category','Job Asset Class','PO Order Date','PO Amount Detail','PO Invoiced Amount','PO Remaining Balance','Invoice Numbers POs'];
const CT_COLS = ['Contract Vendor Code','Contract Vendor Name','Contract Code','Job Status','Job Code','Job Description','Property Code','Property Name','Cost Category','Job Asset Class','Contract Request Date','Contract Commitments','Contract Invoiced Amount','Contract Remaining Balance','Invoice Numbers Contracts'];
function importView(){
  const m = S.imp || {};
  const last = S.imports[0];
  return `<div class="stack">
    <section class="panel pad stack">
      <h3>Load new Yardi exports</h3>
      <p class="small muted">Choose this week’s PO and contract EDP reports. Only the Export tab is read. Check the summary, then load it. Vendors see the new balances right away.</p>
      <div class="grid2">
        <div><label class="f" for="poFile">PO EDP report</label><input type="file" id="poFile" accept=".xlsx,.xls"><p class="small muted">${m.poName?esc(m.poName):''}</p></div>
        <div><label class="f" for="ctFile">Contract EDP report</label><input type="file" id="ctFile" accept=".xlsx,.xls"><p class="small muted">${m.ctName?esc(m.ctName):''}</p></div>
      </div>
      <div style="max-width:260px"><label class="f" for="asOf">Data as of</label><input type="date" id="asOf" value="${esc(m.asOf||new Date().toISOString().slice(0,10))}"></div>
      <div class="row"><button class="btn" data-act="imp-check" ${m.busy?'disabled':''}>Check files</button>${m.busy?`<span class="small muted"><span class="spin"></span>${esc(m.busy)}</span>`:''}${m.err?`<span class="err">${esc(m.err)}</span>`:''}</div>
      ${m.preview?`<div class="kpis">
        <div class="panel kpi"><span class="small muted">POs open for billing</span><b>${m.preview.po.toLocaleString()}</b><span class="small muted">${money(m.preview.poAmt)}</span></div>
        <div class="panel kpi"><span class="small muted">Contracts open for billing</span><b>${m.preview.ct.toLocaleString()}</b><span class="small muted">${money(m.preview.ctAmt)}</span></div>
        <div class="panel kpi"><span class="small muted">Vendors</span><b>${m.preview.vendors.toLocaleString()}</b><span class="small muted">${m.preview.withItems.toLocaleString()} with something to bill</span></div>
        <div class="panel kpi"><span class="small muted">Invoice numbers in Yardi</span><b>${m.preview.invoices.toLocaleString()}</b><span class="small muted">used to match and block duplicates</span></div>
      </div>
      <p class="small">Currently in the portal: ${S.counts?`${S.counts.po.toLocaleString()} POs and ${S.counts.ct.toLocaleString()} contracts`:'…'}. Loading replaces them with the numbers above.</p>
      <div class="row"><button class="btn primary" data-act="imp-load" ${m.busy?'disabled':''}>Load into portal</button></div>`:''}
      ${m.done?`<div class="note" style="background:var(--fund-soft)">${esc(m.done)}</div>`:''}
    </section>
    <section class="panel pad"><h3>What counts as available</h3>
      <div class="grid2" style="margin-top:10px">
        <div><p><b>POs</b></p><p class="small">Grouped by PO number. Rows count when the PO line is Open, the workflow is Approved, and the job isn’t Cancelled or Rejected. Available is the sum of remaining balance on those rows, less requests pending in the portal.</p></div>
        <div><p><b>Contracts</b></p><p class="small">Grouped by contract number. Rows count when the job isn’t Cancelled or Rejected. Available is the sum of remaining balance on those rows, less requests pending in the portal.</p></div>
      </div></section>
    <section class="panel"><div class="pad" style="padding-bottom:6px"><h3>Import history</h3></div>${S.imports.length?`<div class="tw"><table><thead><tr><th>Loaded</th><th>Data as of</th><th>What</th><th class="num">PO rows</th><th class="num">Contract rows</th><th class="num">Requests matched</th></tr></thead><tbody>
      ${S.imports.map(i=>`<tr><td>${tfmt(i.imported_at)}</td><td>${dfmt(i.data_as_of)}</td><td>${esc(i.label)}</td><td class="num">${(+i.po_rows).toLocaleString()}</td><td class="num">${(+i.contract_rows).toLocaleString()}</td><td class="num">${i.matched}</td></tr>`).join('')}</tbody></table></div>`:`<p class="muted pad">Nothing loaded yet. Load the PO and contract exports above to get started.</p>`}</section>
    ${last?'':''}</div>`;
}
async function loadXlsx(){ if(!window.XLSX) await loadScript('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js'); return window.XLSX; }
const num = v => v==null || v==='' ? 0 : (typeof v==='number' ? v : (+String(v).replace(/[$,\s]/g,'') || 0));
const str = v => v==null ? '' : String(v).trim();
const dstr = v => { if(v instanceof Date && !isNaN(v)) return new Date(v.getTime()+12*3600e3).toISOString().slice(0,10); const s = str(v); return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0,10) : null; };
async function readExport(file, cols, label){
  const XLSX = await loadXlsx();
  const wb = XLSX.read(await file.arrayBuffer(), {type:'array', cellDates:true});
  const ws = wb.Sheets['Export']; if(!ws) throw new Error(`${label} has no tab named Export.`);
  const rows = XLSX.utils.sheet_to_json(ws, {defval:null, raw:true});
  if(!rows.length) throw new Error(`The Export tab in the ${label} is empty.`);
  const missing = cols.filter(c=>!(c in rows[0]));
  if(missing.length) throw new Error(`The ${label} is missing these columns: ${missing.join(', ')}.`);
  return rows;
}
function buildImport(po, ct){
  const bad = new Set(['Cancelled','Rejected']), vendors = {}, items = [], jobs = [], inv = new Set();
  const addInv = (code, list) => str(list).split(',').forEach(n=>{ n = norm(n); if(n && code) inv.add(code+'\u0001'+n); });
  po.forEach(r=>{ const c = str(r['Vendor Code']); if(c){ vendors[c] = str(r['Vendor Name']) || vendors[c] || c; addInv(c, r['Invoice Numbers POs']); } });
  ct.forEach(r=>{ const c = str(r['Contract Vendor Code']); if(c){ vendors[c] = str(r['Contract Vendor Name']) || vendors[c] || c; addInv(c, r['Invoice Numbers Contracts']); } });
  const group = (rows, key) => { const g = new Map(); rows.forEach(r=>{ const k = str(r[key]); if(!k) return; if(!g.has(k)) g.set(k,[]); g.get(k).push(r); }); return g; };
  for(const [code, g] of group(po.filter(r=>str(r['PO Line Status'])==='Open' && str(r['PO Workflow Status'])==='Approved' && !bad.has(str(r['Job Status']))), 'PO Code')){
    const net = r2(g.reduce((a,r)=>a+num(r['PO Remaining Balance']),0)); if(net<=0.005) continue;
    const f = g[0], id = 'PO:'+code;
    items.push({id, kind:'PO', code, vendor_code:str(f['Vendor Code']), property:`${str(f['Property Code'])} ${str(f['Property Name'])}`.trim(),
      description: g.length===1 ? str(f['Job Description']).slice(0,60) : `${g.length} jobs`, category:str(f['Cost Category']), asset_class:str(f['Job Asset Class']),
      issued_on:dstr(f['PO Order Date']), amount:r2(g.reduce((a,r)=>a+num(r['PO Amount Detail']),0)), invoiced:r2(g.reduce((a,r)=>a+num(r['PO Invoiced Amount']),0)), remaining:net});
    g.forEach(r=>jobs.push({item_id:id, job_code:str(r['Job Code']), job_description:str(r['Job Description']).slice(0,80), job_status:str(r['Job Status']),
      amount:r2(num(r['PO Amount Detail'])), invoiced:r2(num(r['PO Invoiced Amount'])), remaining:r2(num(r['PO Remaining Balance']))}));
  }
  for(const [code, g] of group(ct.filter(r=>!bad.has(str(r['Job Status']))), 'Contract Code')){
    const net = r2(g.reduce((a,r)=>a+num(r['Contract Remaining Balance']),0)); if(net<=0.005) continue;
    const f = g[0], id = 'Contract:'+code, props = new Set(g.map(r=>str(r['Property Code']))).size;
    items.push({id, kind:'Contract', code, vendor_code:str(f['Contract Vendor Code']), property: props===1 ? `${str(f['Property Code'])} ${str(f['Property Name'])}`.trim() : `${props} properties`,
      description: g.length===1 ? str(f['Job Description']).slice(0,60) : `${g.length} jobs`, category:str(f['Cost Category']), asset_class:str(f['Job Asset Class']),
      issued_on:dstr(f['Contract Request Date']), amount:r2(g.reduce((a,r)=>a+num(r['Contract Commitments']),0)), invoiced:r2(g.reduce((a,r)=>a+num(r['Contract Invoiced Amount']),0)), remaining:net});
    g.forEach(r=>jobs.push({item_id:id, job_code:str(r['Job Code']), job_description:str(r['Job Description']).slice(0,80), job_status:str(r['Job Status']),
      amount:r2(num(r['Contract Commitments'])), invoiced:r2(num(r['Contract Invoiced Amount'])), remaining:r2(num(r['Contract Remaining Balance']))}));
  }
  return { vendors:Object.entries(vendors).map(([code,name])=>({code,name})), items, jobs,
    invoices:[...inv].map(k=>{ const [vendor_code, invoice_no] = k.split('\u0001'); return {vendor_code, invoice_no}; }), poRows:po.length, ctRows:ct.length };
}
async function impCheck(){
  const po = document.getElementById('poFile').files[0], ct = document.getElementById('ctFile').files[0];
  const asOf = document.getElementById('asOf').value;
  if(!po || !ct){ S.imp = {...(S.imp||{}), err:'Choose both the PO and the contract report.'}; return renderBody(); }
  const guess = (po.name.match(/\d{4}-\d{2}-\d{2}/)||[])[0];
  S.imp = {busy:'Reading the reports…', poName:po.name, ctName:ct.name, asOf: guess && asOf===new Date().toISOString().slice(0,10) ? guess : asOf};
  renderBody();
  try{
    const [poRows, ctRows] = await Promise.all([readExport(po, PO_COLS, 'PO report'), readExport(ct, CT_COLS, 'contract report')]);
    const data = buildImport(poRows, ctRows);
    const sum = k => data.items.filter(i=>i.kind===k).reduce((s,i)=>s+i.remaining,0);
    const [cpo, cct] = await Promise.all([sb.from('items').select('id',{count:'exact',head:true}).eq('kind','PO').gt('remaining',0), sb.from('items').select('id',{count:'exact',head:true}).eq('kind','Contract').gt('remaining',0)]);
    S.counts = {po:cpo.count||0, ct:cct.count||0};
    S.imp = {...S.imp, busy:'', data, preview:{po:data.items.filter(i=>i.kind==='PO').length, ct:data.items.filter(i=>i.kind==='Contract').length, poAmt:sum('PO'), ctAmt:sum('Contract'),
      vendors:data.vendors.length, withItems:new Set(data.items.map(i=>i.vendor_code)).size, invoices:data.invoices.length}};
  }catch(e){ S.imp = {...S.imp, busy:'', err:errText(e,'The reports couldn’t be read.')}; }
  renderBody();
}
async function impLoad(){
  const m = S.imp; if(!m || !m.data) return;
  m.asOf = document.getElementById('asOf').value || m.asOf;
  m.busy = 'Loading into the portal. This can take up to a minute…'; m.err = ''; renderBody();
  try{
    const res = await api('/api/import', {...m.data, asOf:m.asOf, label:`${m.poName} and ${m.ctName}`});
    S.imp = {done:`Loaded ${res.items.toLocaleString()} POs and contracts for ${res.vendors.toLocaleString()} vendors. ${res.matched} request${res.matched===1?'':'s'} matched to Yardi.${res.closed?` ${res.closed} PO${res.closed===1?'':'s'} or contract${res.closed===1?'':'s'} with portal requests closed in Yardi and now show no balance.`:''}`};
    await reload().catch(()=>{});
  }catch(e){ m.busy = ''; m.err = errText(e,'The import didn’t finish. Check the files and try again.'); }
  render();
}

/* ---------- events ---------- */
document.addEventListener('click', e=>{
  if(e.target.closest('#drop')){ document.getElementById('file').click(); return; }
  const t = e.target.closest('[data-act]'); if(!t) return;
  const a = t.dataset.act;
  if(a==='login') sendLink();
  else if(a==='login-again') showLogin();
  else if(a==='signout') sb.auth.signOut();
  else if(a==='view'){ S.view = t.dataset.v; S.sel = null; app.innerHTML = `<div class="empty"><span class="spin"></span>Loading…</div>`; reload().then(render).catch(err=>toast(errText(err))); window.scrollTo(0,0); }
  else if(a==='vtab'){ S.vtab = t.dataset.v; renderBody(); }
  else if(a==='btab'){ S.btab = t.dataset.v; renderBody(); }
  else if(a==='clearfile'){ S.readToken++; S.draft = newDraft(); renderBody(); }
  else if(a==='pick'){ if(t.classList.contains('off') || S.draft.stage!=='ready') return; S.draft.item = t.dataset.id; S.draft.autoPicked = false; S.draft.hint = ''; renderItemList(); renderChecks(); }
  else if(a==='submit') submitDraft();
  else if(a==='reply'){ const id = t.dataset.id, ta = document.getElementById('reply-'+id), v = (ta && ta.value || '').trim();
    if(!v){ document.getElementById('rerr-'+id).textContent = 'Write a reply before sending.'; return; }
    t.disabled = true;
    sb.rpc('reply_to_request', {p_id:id, p_note:v}).then(async ({error})=>{ if(error){ t.disabled=false; document.getElementById('rerr-'+id).textContent = errText(error); return; } await loadVendor().catch(()=>{}); render(); toast('Reply sent to accounts payable'); }); }
  else if(a==='filter'){ S.filter = t.dataset.v; renderQueue(); }
  else if(a==='sel'){ S.sel = t.dataset.id; renderQueue(); renderReview(); if(window.innerWidth<1100){ const rv = document.getElementById('review'); rv && rv.scrollIntoView({behavior:'smooth'}); } }
  else if(['approve','reject','askinfo','paid'].includes(a)) boAction(a);
  else if(a==='bigview'){ S.bigView = !S.bigView; const r = S.reqs.find(x=>x.id===S.sel); if(r) renderAttachment(r); }
  else if(a==='imp-check') impCheck();
  else if(a==='imp-load') impLoad();
});
document.addEventListener('keydown', e=>{
  if(e.key==='Enter' && e.target.id==='email'){ e.preventDefault(); sendLink(); }
  if((e.key==='Enter'||e.key===' ') && e.target.id==='drop'){ e.preventDefault(); document.getElementById('file').click(); }
  if((e.key==='Enter'||e.key===' ') && e.target.matches && e.target.matches('tr[data-act=sel], .opt[data-act=pick]')){ e.preventDefault(); e.target.click(); }
});
document.addEventListener('change', e=>{
  if(e.target.id==='vsel'){ S.vendor = e.target.value; S.readToken++; S.draft = newDraft(); S.itemQ = ''; S.posQ = ''; loadVendor().then(render).catch(err=>toast(errText(err))); }
  else if(e.target.id==='file' && e.target.files[0]) takeFile(e.target.files[0]);
});
document.addEventListener('input', e=>{
  const k = e.target.dataset.in;
  if(k){ S.draft[k] = e.target.value; S.draft.hint = ''; renderChecks(); }
  else if(e.target.id==='itemQ'){ S.itemQ = e.target.value; renderItemList(); }
  else if(e.target.id==='posQ'){ S.posQ = e.target.value; const p = e.target.selectionStart; renderBody(); const n = document.getElementById('posQ'); n.focus(); n.setSelectionRange(p,p); }
  else if(e.target.id==='boQ'){ S.q = e.target.value; renderQueue(); }
});
document.addEventListener('focusout', ()=>{ setTimeout(()=>{ if(S.dirty && !busyTyping()){ S.dirty = false; renderBody(); } },0); });
['dragover','dragleave','drop'].forEach(ev=>document.addEventListener(ev, e=>{
  const z = e.target.closest && e.target.closest('#drop'); if(!z) return; e.preventDefault();
  if(ev==='dragover') z.classList.add('over'); else z.classList.remove('over');
  if(ev==='drop' && e.dataTransfer.files[0]) takeFile(e.dataTransfer.files[0]);
}));

boot();
