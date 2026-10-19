# QuadReal Vendor Portal

Vendors sign in, upload an invoice PDF, confirm the details Claude reads from it, and bill it against one of their open POs or contracts. QuadReal staff review requests in the back end and load Yardi EDP exports.

## What's in this repo

| File | What it does |
|---|---|
| `index.html` | The page (QuadReal styling, logo, banner). |
| `app.js` | The app: sign-in, vendor portal, back end, Yardi import. |
| `api/config.js` | Gives the browser the Supabase URL and public (anon) key. |
| `api/extract.js` | Reads an uploaded invoice with Claude. Holds the Anthropic key server-side. |
| `api/import.js` | Loads Yardi exports into Supabase. Staff only. Uses the service role key. |
| `api/_lib.js` | Shared helpers for the API functions. |
| `supabase-schema.sql` | Database tables, security rules, and storage bucket. |

No vendor data lives in this repo. Everything is loaded from Supabase after sign-in.

## 1. Supabase

1. Create a project in the Canada (Central) region.
2. SQL Editor: run `supabase-schema.sql` once.
3. Authentication > Sign In / Providers: keep Email on, and turn **off** "Allow new users to sign up". Only invited people can sign in.
4. Authentication > URL Configuration: set **Site URL** to your Vercel URL (for example `https://vendor-portal.vercel.app`) and add the same URL under Redirect URLs.
5. Project Settings > API: note the Project URL, the `anon` key, and the `service_role` key.

## 2. Vercel

1. Push this folder to a **private** GitHub repo and import it in Vercel (Framework preset: Other, no build command).
2. Settings > Environment Variables:

| Name | Value |
|---|---|
| `SUPABASE_URL` | Supabase Project URL |
| `SUPABASE_ANON_KEY` | Supabase `anon` key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase `service_role` key (server only, never in the page) |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `ANTHROPIC_MODEL` | Optional. Defaults to `claude-sonnet-5-5`. |

3. Deploy.

## 3. First run

1. Supabase > Authentication > Users: **Invite user** with your own email. Open the link once.
2. SQL Editor: make yourself staff:
   ```sql
   insert into public.staff (user_id, role) select id, 'admin' from auth.users where email = 'you@quadreal.com';
   ```
3. Sign in to the portal. In **Back end > Import data**, choose the PO and contract EDP reports, check the summary, and load them.
4. For each vendor: invite their billing contact in Supabase, then link them to their vendor code:
   ```sql
   insert into public.vendor_users (user_id, vendor_code) select id, 'v0000106' from auth.users where email = 'billing@vendor.com';
   ```
   One login can be linked to several vendor codes. To test the vendor side yourself, link your own login to a vendor code.

## Weekly routine

Load the new PO and contract exports in **Import data**. Approved requests that now appear in Yardi (same vendor code and invoice number) move to "Entered in Yardi" automatically, and balances update for vendors.

## Rules the portal applies

- **POs:** grouped by PO number. Rows count when the PO line is Open, the workflow is Approved, and the job isn't Cancelled or Rejected.
- **Contracts:** grouped by contract number. Rows count when the job isn't Cancelled or Rejected.
- **Available** = sum of remaining balance on those rows, less portal requests not yet in Yardi.
- A request needs a PDF, an invoice number, a total, and a PO or contract with enough funds. Duplicate invoice numbers (in the portal or in Yardi) are refused. These checks run again in the database on submit.
