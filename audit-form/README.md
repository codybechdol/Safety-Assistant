# Crew Equipment Inventory Audit — Standalone Foreman Form

Zero-download, mobile/iPad-friendly, offline-capable web form for blind crew equipment inventory audits.

## Hosting on Cloudflare Pages (Free — Supports Private GitHub Repos)

1. Push your latest branch (`App-Migration` or `master`) to GitHub (`codybechdol/rubber-tracker`).
2. Go to [Cloudflare Dashboard](https://dash.cloudflare.com) → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**.
3. Select the `rubber-tracker` repository and choose the branch you deploy from.
4. Configure build settings:
   - **Framework preset:** None
   - **Build command:** *(leave empty)*
   - **Build output directory:** `audit-form`
5. Click **Save and Deploy**. Cloudflare gives you a free HTTPS URL like `https://crew-equipment-audit.pages.dev`.
6. Open **Safety Assistant Desktop App → Equipment → 📋 Equipment Audits → ⚙️ Form URL & Setup**, paste that `https://...pages.dev` URL, and click **Save URL**.

## First-Time Supabase Setup

Run [`supabase/audit_setup.sql`](../supabase/audit_setup.sql) once in your Supabase SQL Editor (or click **📋 Copy Audit SQL Script** inside **Equipment Audits** in the Desktop App).

## Preview Mode

Append `?demo=1` to the hosted URL (e.g., `https://crew-equipment-audit.pages.dev/?demo=1`) to test all 9 categories and offline draft behavior without needing a live token.
