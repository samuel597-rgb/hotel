# HOTELI POA POS — SQLite demo

This demo uses a local SQLite database and a Node.js API. GitHub stores the source code. The API can run locally or on a free Node host such as Render Free; the API host serves the frontend and the SQLite-backed API from one origin. GitHub Pages can host the static frontend separately, but it cannot run the Node API or SQLite itself.

## Run locally

1. Install Node.js 22.13 or newer (the API uses Node's built-in SQLite module).
2. Copy `.env.example` to `.env` if you need to change the defaults. Keep `.env` private.
3. Run `npm install`.
4. Run `npm start` and open `http://localhost:3000`.

On startup the API applies `server/schema.sql`, opens the database at `DB_PATH` (default `./hoteli_poa.db`), and seeds the catalog from `menu.js` only when it is empty. An existing local `hoteli_poa.db` is used in place, preserving its `products` and `settings` rows. If a supplied database has a physical singular `product` table, its rows are imported into the canonical catalog while preserving their IDs. The `product` view is provided as a singular-name compatibility view on fresh databases.

The home page opens directly to the customer menu. Customers can browse and place demo orders without creating an account. Staff sign-in is available from **Admin Login** and **Employee Login** in the top-right corner. Demo credentials: username `admin 1`, password `admin@1234`; username `employee 1`, password `emplo@1234`. These demo accounts are seeded at API startup; do not reuse these credentials for a public or production deployment.

The database file and SQLite journal files are ignored by Git. Do not commit or upload `hoteli_poa.db`; the repository contains the schema and menu seed, not your local records. New accounts are local to that database. New accounts start as customers. To grant staff access, create the account and run `npm run promote -- user@example.com manager` (or choose `waiter`, `cashier`, `supervisor`, or `admin`).

## Admin guide — managing products and images

Sign in with **Admin Login**, then open **Products**. Add or edit a menu item with a name, price, category, description, and optional JPG, PNG, or WEBP image (up to 5 MB). Product images are saved under `uploads/`; the product row stores the `/uploads/...` path. Delete hides a product from the customer catalog while retaining its order history. Use **Floor & Tables** to change table status, create staff logins and categories, choose whether prices include tax, and open the demo register. The **Kitchen Display** view advances active orders through new, preparing, ready, and served. Each table has a token-protected QR link to a secondary customer display. Keep the `uploads/` directory alongside the database during local development; both are ephemeral on free hosting.

## Browser and phone app

The customer site is a responsive Progressive Web App. On a deployed HTTPS URL, Chrome and supported Android browsers can install it from the **Install App** button or the browser menu. On iPhone/iPad, open the site in Safari, tap **Share**, then **Add to Home Screen**. This installs a home-screen web app; it is not a native Play Store or App Store package. Local development still opens at `http://localhost:3000`.

## Free hosting

The checked-in `render.yaml` defines a **free** Node web service. GitHub remains the code host; Render runs the API and serves the page. No persistent disk, paid database, payment integration, or other paid add-on is configured.

For a branded public address, `hoteli-poa.co.ke` is a possible domain name (availability is not confirmed). Registering a `.co.ke` domain requires a domain registrar and may have a registration/renewal fee; the app cannot claim that name just by changing this code. After you own a domain, add it to the Render web service's Custom Domains settings and point the registrar's DNS records at the Render target. Render supports custom domains and managed HTTPS on free web services. Until then, the deployed app uses its free `*.onrender.com` address. The local `localhost` address is only reachable on your own device.

Free hosts use an ephemeral filesystem. SQLite runs wherever the API process runs, and its changes can disappear when the service restarts, spins down, or redeploys. This is acceptable for the demo phase; persistent storage is a later paid upgrade. Since the local database is intentionally excluded from Git, a new hosted instance creates a fresh database and seeds the menu from `menu.js`; it does not receive the local `hoteli_poa.db` contents.

To use GitHub Pages for the static frontend instead, point `window.POS_API_BASE_URL` in `runtime-config.js` at the free API origin and allow the Pages origin in the API host's `CORS_ORIGINS`. GitHub Pages by itself cannot provide the backend or SQLite database.

## Demo limitations

- Email/password accounts are stored locally with scrypt password hashes. Existing Firebase/Supabase accounts are not imported; create new demo accounts.
- Google, Facebook, phone sign-in, email password reset, profile photo uploads, Stripe, and M-Pesa are disabled in this SQLite-only demo. Product images are local files under `uploads/` and may be lost on ephemeral hosts.
- The frontend polls the API for changes because SQLite has no hosted realtime service.
- `USE_FIREBASE=false` is recorded in `.env.example` and the free Render Blueprint. There are no active Firebase imports, initialization calls, or API requests. Historical source remains under `firebase-backup/` without deployment configuration or credentials.

## Firebase cleanup and exposed keys

Firebase is disconnected from the running application. Firebase deployment configuration, rules, logs, archived environment files, and config modules have been removed; `firebase-backup/` retains source history only. Removing files from this checkout does not remove earlier Git commits. If any Firebase keys or secrets in the old configuration were real, rotate or revoke them in the Firebase console. No active credential values are stored in this repository.
