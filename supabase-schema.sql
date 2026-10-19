-- QuadReal Vendor Portal: Supabase schema
-- Run once in Supabase: SQL Editor > New query > paste > Run.
--
-- Design:
--   * Vendors only ever see their own vendor code's POs, contracts and requests (row level security).
--   * Nobody writes tables directly from the browser. Vendors submit and reply through functions
--     that re-check funds and duplicates on the server; AP staff change statuses through a function.
--   * Yardi imports are loaded by a server function on Vercel using the service role key, never the browser.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- People
-- ---------------------------------------------------------------------------
create table public.vendors (
  code text primary key,                 -- Yardi vendor code, e.g. v0000106
  name text not null
);

create table public.vendor_users (        -- which login can act for which vendor code(s)
  user_id     uuid not null references auth.users(id) on delete cascade,
  vendor_code text not null references public.vendors(code) on delete cascade,
  primary key (user_id, vendor_code)
);

create table public.staff (               -- QuadReal staff who use the back end
  user_id uuid primary key references auth.users(id) on delete cascade,
  role    text not null default 'ap' check (role in ('ap', 'admin'))
);

-- ---------------------------------------------------------------------------
-- Yardi data (replaced by each import)
-- ---------------------------------------------------------------------------
create table public.imports (
  id            bigint generated always as identity primary key,
  imported_at   timestamptz not null default now(),
  data_as_of    date not null,
  label         text not null,
  po_rows       int not null default 0,
  contract_rows int not null default 0,
  matched       int not null default 0,
  imported_by   uuid references auth.users(id)
);

create table public.items (               -- one row per PO or contract that is open for billing
  id          text primary key,           -- 'PO:334662' or 'Contract:1050'
  kind        text not null check (kind in ('PO', 'Contract')),
  code        text not null,
  vendor_code text not null references public.vendors(code),
  property    text,
  description text,
  category    text,
  asset_class text,
  issued_on   date,
  amount      numeric(14,2) not null default 0,   -- PO amount or contract commitment (counted rows)
  invoiced    numeric(14,2) not null default 0,
  remaining   numeric(14,2) not null default 0,   -- sum of remaining balance on counted rows
  updated_at  timestamptz not null default now()
);
create index items_vendor_idx on public.items (vendor_code);

create table public.item_jobs (           -- job breakdown, staff only
  id              bigint generated always as identity primary key,
  item_id         text not null references public.items(id) on delete cascade,
  job_code        text not null,
  job_description text,
  job_status      text,
  amount          numeric(14,2) not null default 0,
  invoiced        numeric(14,2) not null default 0,
  remaining       numeric(14,2) not null default 0
);
create index item_jobs_item_idx on public.item_jobs (item_id);

create table public.yardi_invoices (      -- invoice numbers already in Yardi, for duplicate checks
  vendor_code text not null,
  invoice_no  text not null,              -- stored upper-cased and trimmed
  primary key (vendor_code, invoice_no)
);

-- ---------------------------------------------------------------------------
-- Payment requests
-- ---------------------------------------------------------------------------
create table public.requests (
  id               text primary key default ('VR-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))),
  vendor_code      text not null references public.vendors(code),
  item_id          text not null references public.items(id),
  invoice_no       text not null,
  invoice_date     date,
  extracted_amount numeric(14,2),         -- what Claude read from the PDF (null if not read)
  amount           numeric(14,2) not null check (amount > 0),  -- what the vendor confirmed
  file_path        text not null,         -- path in the 'invoices' storage bucket
  file_name        text,
  file_size        int,
  source           text not null default 'upload',
  name_on_invoice  text,
  ref_on_invoice   text,
  status           text not null default 'In review'
                   check (status in ('Submitted','In review','Needs info','Approved','Entered in Yardi','Paid','Rejected')),
  reflected        boolean not null default false,  -- true once the invoice shows up in a Yardi import
  submitted_by     uuid references auth.users(id),
  submitted_at     timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index requests_vendor_idx on public.requests (vendor_code);
create index requests_status_idx on public.requests (status);
create index requests_item_idx   on public.requests (item_id);
-- One live request per vendor invoice number (rejected ones can be resubmitted).
create unique index requests_no_duplicate
  on public.requests (vendor_code, upper(trim(invoice_no))) where status <> 'Rejected';

create table public.request_events (      -- full audit trail of every status change and note
  id         bigint generated always as identity primary key,
  request_id text not null references public.requests(id) on delete cascade,
  status     text not null,
  actor      text not null,               -- 'Vendor', 'AP reviewer', 'System', 'Yardi import'
  actor_id   uuid references auth.users(id),
  note       text,
  created_at timestamptz not null default now()
);
create index request_events_request_idx on public.request_events (request_id);

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from staff where user_id = auth.uid());
$$;

create or replace function public.my_vendor_codes() returns setof text
language sql stable security definer set search_path = public as $$
  select vendor_code from vendor_users where user_id = auth.uid();
$$;

-- Available = Yardi remaining, less portal requests not yet reflected in Yardi.
create or replace view public.item_availability with (security_invoker = true) as
select i.*,
       coalesce(p.pending, 0)               as pending,
       i.remaining - coalesce(p.pending, 0) as available
from public.items i
left join (
  select item_id, sum(amount) as pending
  from public.requests
  where status in ('Submitted','In review','Needs info','Approved') and not reflected
  group by item_id
) p on p.item_id = i.id;

-- ---------------------------------------------------------------------------
-- Vendor actions
-- ---------------------------------------------------------------------------
create or replace function public.submit_request(
  p_vendor_code text, p_item_id text, p_invoice_no text, p_invoice_date date,
  p_amount numeric, p_extracted numeric, p_file_path text, p_file_name text, p_file_size int,
  p_source text default 'upload', p_name_on_invoice text default null, p_ref_on_invoice text default null
) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_item    items%rowtype;
  v_pending numeric;
  v_id      text;
  v_no      text := upper(trim(coalesce(p_invoice_no, '')));
begin
  if not exists (select 1 from vendor_users where user_id = auth.uid() and vendor_code = p_vendor_code) then
    raise exception 'You can only submit invoices for your own vendor account.';
  end if;
  -- Lock the PO/contract row so two submissions can't spend the same balance.
  select * into v_item from items where id = p_item_id for update;
  if not found or v_item.vendor_code <> p_vendor_code then
    raise exception 'Choose one of your open POs or contracts.';
  end if;
  if v_no = '' then raise exception 'Enter the invoice number.'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Enter the invoice total.'; end if;
  if coalesce(p_file_path, '') = '' or split_part(p_file_path, '/', 1) <> p_vendor_code then
    raise exception 'Attach the invoice PDF.';
  end if;
  if exists (select 1 from yardi_invoices where vendor_code = p_vendor_code and invoice_no = v_no) then
    raise exception 'Invoice % is already in Yardi for your account.', trim(p_invoice_no);
  end if;
  select coalesce(sum(amount), 0) into v_pending
  from requests
  where item_id = p_item_id and status in ('Submitted','In review','Needs info','Approved') and not reflected;
  if p_amount > v_item.remaining - v_pending then
    raise exception 'Not enough funds. % has % available.',
      v_item.kind || ' ' || v_item.code, to_char(v_item.remaining - v_pending, 'FM$999,999,990.00');
  end if;

  insert into requests (vendor_code, item_id, invoice_no, invoice_date, amount, extracted_amount,
                        file_path, file_name, file_size, source, name_on_invoice, ref_on_invoice,
                        status, submitted_by)
  values (p_vendor_code, p_item_id, trim(p_invoice_no), p_invoice_date, round(p_amount, 2), p_extracted,
          p_file_path, p_file_name, p_file_size, coalesce(p_source, 'upload'), p_name_on_invoice, p_ref_on_invoice,
          'In review', auth.uid())
  returning id into v_id;

  insert into request_events (request_id, status, actor, actor_id) values (v_id, 'Submitted', 'Vendor', auth.uid());
  insert into request_events (request_id, status, actor, note)
  values (v_id, 'In review', 'System', 'Passed automatic checks: PO/contract selected, funds available, no duplicate found.');
  return v_id;
exception
  when unique_violation then
    raise exception 'Invoice % was already submitted in the portal.', trim(p_invoice_no);
end;
$$;

create or replace function public.reply_to_request(p_id text, p_note text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(trim(p_note), '') = '' then raise exception 'Write a reply before sending.'; end if;
  update requests set status = 'In review', updated_at = now()
  where id = p_id and status = 'Needs info'
    and vendor_code in (select vendor_code from vendor_users where user_id = auth.uid());
  if not found then raise exception 'This request isn''t waiting on a reply from you.'; end if;
  insert into request_events (request_id, status, actor, actor_id, note) values (p_id, 'In review', 'Vendor', auth.uid(), trim(p_note));
end;
$$;

-- ---------------------------------------------------------------------------
-- Staff actions
-- ---------------------------------------------------------------------------
create or replace function public.set_request_status(p_id text, p_status text, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare v_current text;
begin
  if not is_staff() then raise exception 'Only QuadReal staff can change a request.'; end if;
  if p_status not in ('Approved', 'Rejected', 'Needs info', 'Paid') then raise exception 'That status can''t be set here.'; end if;
  if p_status in ('Rejected', 'Needs info') and coalesce(trim(p_note), '') = '' then
    raise exception 'Add a note for the vendor.';
  end if;
  select status into v_current from requests where id = p_id for update;
  if not found then raise exception 'Request % not found.', p_id; end if;
  if p_status in ('Approved', 'Rejected', 'Needs info') and v_current not in ('Submitted', 'In review', 'Needs info') then
    raise exception 'Request % is already %.', p_id, v_current;
  end if;
  if p_status = 'Paid' and v_current <> 'Entered in Yardi' then
    raise exception 'Only requests entered in Yardi can be marked paid.';
  end if;
  update requests set status = p_status, updated_at = now() where id = p_id;
  insert into request_events (request_id, status, actor, actor_id, note)
  values (p_id, p_status, case when p_status = 'Paid' then 'Yardi import' else 'AP reviewer' end, auth.uid(), nullif(trim(p_note), ''));
end;
$$;

-- ---------------------------------------------------------------------------
-- Row level security: read access only; all writes go through the functions above
-- or the server-side import (service role, which bypasses RLS).
-- ---------------------------------------------------------------------------
alter table public.vendors        enable row level security;
alter table public.vendor_users   enable row level security;
alter table public.staff          enable row level security;
alter table public.imports        enable row level security;
alter table public.items          enable row level security;
alter table public.item_jobs      enable row level security;
alter table public.yardi_invoices enable row level security;
alter table public.requests       enable row level security;
alter table public.request_events enable row level security;

create policy vendors_read        on public.vendors        for select to authenticated using (public.is_staff() or code in (select public.my_vendor_codes()));
create policy vendor_users_read   on public.vendor_users   for select to authenticated using (user_id = auth.uid() or public.is_staff());
create policy staff_read          on public.staff          for select to authenticated using (user_id = auth.uid() or public.is_staff());
create policy imports_read        on public.imports        for select to authenticated using (true);  -- shows "data as of"
create policy items_read          on public.items          for select to authenticated using (public.is_staff() or vendor_code in (select public.my_vendor_codes()));
create policy item_jobs_read      on public.item_jobs      for select to authenticated using (public.is_staff());
create policy yardi_invoices_read on public.yardi_invoices for select to authenticated using (public.is_staff());
create policy requests_read       on public.requests       for select to authenticated using (public.is_staff() or vendor_code in (select public.my_vendor_codes()));
create policy request_events_read on public.request_events for select to authenticated using (
  public.is_staff() or exists (select 1 from public.requests r where r.id = request_id and r.vendor_code in (select public.my_vendor_codes()))
);

grant execute on function public.submit_request(text, text, text, date, numeric, numeric, text, text, int, text, text, text) to authenticated;
grant execute on function public.reply_to_request(text, text)        to authenticated;
grant execute on function public.set_request_status(text, text, text) to authenticated;
revoke execute on function public.submit_request(text, text, text, date, numeric, numeric, text, text, int, text, text, text) from anon;
revoke execute on function public.reply_to_request(text, text)        from anon;
revoke execute on function public.set_request_status(text, text, text) from anon;

-- ---------------------------------------------------------------------------
-- Invoice PDF storage: private bucket, files stored as <vendor_code>/<file>.pdf
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('invoices', 'invoices', false, 10485760, array['application/pdf'])
on conflict (id) do nothing;

create policy invoices_vendor_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'invoices' and (storage.foldername(name))[1] in (select public.my_vendor_codes()));

create policy invoices_read on storage.objects for select to authenticated
  using (bucket_id = 'invoices' and (public.is_staff() or (storage.foldername(name))[1] in (select public.my_vendor_codes())));

-- ---------------------------------------------------------------------------
-- After your first sign-in, make yourself staff (replace the email):
--   insert into public.staff (user_id, role)
--   select id, 'admin' from auth.users where email = 'you@quadreal.com';
--
-- Link a vendor login to a vendor code (after the first Yardi import loads vendors):
--   insert into public.vendor_users (user_id, vendor_code)
--   select id, 'v0000106' from auth.users where email = 'billing@vendor.com';
-- ---------------------------------------------------------------------------
