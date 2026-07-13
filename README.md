# BingPpang POS — Netlify + Supabase

This version is designed for deployment to Netlify and shared use across multiple iPads.

## Architecture

- Netlify: hosts the web app
- Supabase Postgres: stores menu, settings, orders, and order items
- Supabase Realtime: updates preparation screens automatically
- Square app: processes card payments separately

## 1. Create Supabase

1. Create a Supabase project.
2. Open **SQL Editor**.
3. Copy all content from `supabase/schema.sql` and run it once.
4. Open **Project Settings > API**.
5. Copy the project URL and the public anon/publishable key.

## 2. Test locally

Create `.env` in the project root:

```env
VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR_PUBLIC_KEY
```

Then run:

```bash
npm install
npm run dev
```

Open the local URL shown by Vite.

## 3. Deploy to Netlify

Recommended GitHub flow:

1. Upload this folder to a GitHub repository.
2. In Netlify, choose **Add new project > Import an existing project**.
3. Select the repository.
4. Build command: `npm run build`
5. Publish directory: `dist`
6. Add environment variables:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
7. Deploy.

`netlify.toml` already includes the build and single-page-app redirect settings.

## Device URLs

After deployment:

- Cashier: `https://YOUR-SITE.netlify.app/#pos`
- Preparation: `https://YOUR-SITE.netlify.app/#prep`
- History: `https://YOUR-SITE.netlify.app/#history`
- Settings: `https://YOUR-SITE.netlify.app/#settings`

## Clear history

Settings includes **Clear All Order History**. Staff must type `RESET` exactly. It deletes orders and order items and restarts order numbering at #001.

## Important security note

This booth prototype allows anyone with the site URL to access the POS because it does not yet include login/authentication. Do not publicly share the URL. A later production upgrade should add Supabase Auth and role-based permissions.
