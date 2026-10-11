# HOTELI POA POS

The POS frontend and API run together as a Node 22 web service on Render. Supabase provides Authentication, Postgres, and private file storage.

## First-time setup

1. In the Supabase SQL Editor, run `server/schema.sql`.
2. In Supabase Authentication settings, enable Email, Google, Facebook, and Phone providers. Configure provider credentials, set the site URL, and allow `https://hoteli-pos-api.onrender.com/auth.html` as an OAuth redirect (also add the local URL when developing).
3. In the Render Dashboard, create a Blueprint from this repository using `render.yaml`. Add the Supabase URL, anon key, service-role key, a random `RESET_CODE_PEPPER`, and Resend SMTP values as environment variables. Keep service-role and mail credentials in Render only.
4. Set the GitHub Actions repository secrets `SUPABASE_URL` and `SUPABASE_ANON_KEY` for the daily Supabase keep-alive workflow. Add Stripe and Safaricom Daraja credentials in Render if card and M-Pesa checkout should be enabled. Point the Stripe webhook to `/api/stripe-webhook`.
5. After the API is deployed, run `npm run seed` once with `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in a local, ignored `.env` file. This installs the initial categories, menu, and general settings.
6. Promote staff accounts by setting their role in Supabase SQL, for example:

   ```sql
   update public.user_roles set role = 'manager' where user_id = '<Supabase Auth user UUID>';
   ```

The Render service serves both the frontend and `/api` routes. If Render assigns a different hostname, update `SITE_URL`, Supabase Auth redirect URLs, and the keep-alive workflow URL to match it.

## Password reset email

The API uses a one-minute, six-digit code. Set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, and `RESET_CODE_PEPPER` in Render. Apply `server/schema.sql` before use.

## Firebase archive and data migration

The previous Firebase source is in `firebase-backup/`. Existing Firebase users, Firestore/Realtime Database rows, Storage images, and custom staff roles are not copied automatically. Export and import those records before switching a production site if they must be retained. Firebase password hashes cannot be moved into Supabase Auth; users will need to create or reset their passwords.
