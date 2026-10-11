# HOTELI POA POS

A real-time hotel point-of-sale app with a responsive HTML frontend, Firebase Authentication and Firestore, Express API, SQLite backup/outbox, and Firebase Cloud Functions for Stripe and M-Pesa payments.

## Run locally

1. Install Node.js 20 or newer and create a Firebase project.
2. Enable Email/Password in Firebase Authentication. Add `localhost` to the authorized domains.
3. Enter your Firebase Web App settings in `firebase.js` (the modular SDK template is `firebase.example.js`). The Web App config is public; the service account is private.
4. Copy `serviceAccountKey.example.json` to `serviceAccountKey.json`, replace its placeholders with a Firebase Admin service-account key, then copy `.env.example` to `.env`. Set `FIREBASE_SERVICE_ACCOUNT_PATH=./serviceAccountKey.json` and set `CORS_ORIGINS` to the exact frontend origin(s).
5. Install and start the API:

   ```sh
   npm install
   npm start
   ```

6. Open <http://localhost:3000>. The sign-in page supports customer registration. Staff accounts should be created in Firebase Authentication by an administrator.
7. On server startup, the versioned menu seeder imports the 84-item menu in `menu.js` into Firestore, updates the category list, and marks old demo entries unavailable without deleting historical records. The SQLite startup migration adds `sub_category`, Firestore IDs, and availability fields, then imports the same menu without dropping existing tables. You can run the idempotent Firestore seed command manually:

   ```sh
   node seed.js
   ```

8. Create `admin@hotelipoa.com` (or another administrator account) through Firebase Authentication with a unique password, then promote the account using the service account on the trusted server:

   ```sh
   node set-user-role.js manager@example.com manager
   ```

   Supported roles are `waiter`, `cashier`, `supervisor`, `manager`, and `admin`. The staff member must sign out and back in after a role change. Do not give the service account to staff users. The app deliberately does not create the shared `password123` credential; set a unique password in Firebase Authentication.

The client initializes Firebase Auth, Firestore, Realtime Database (`https://hoteli-cd840-default-rtdb.firebaseio.com`), Storage, and Functions. The Realtime Database handle is exported as `rtdb` from `firebase.js` for database features. Use `?emulator=true` with the local URL to connect the client to the Firebase emulators. The emulator ports are Auth 9099, Realtime Database 9000, Firestore 8085, Functions 5001, and Storage 9199. Without the query parameter, the local frontend uses the configured Firebase project.

## Data and access model

- Firebase Authentication owns credentials. The old SQLite plaintext user table is no longer used for authentication or seeded with sample passwords.
- `menu.js` is the shared menu source for Firestore and SQLite, with prices, food/drink department, subcategory, and image URL from the supplied hotel menu.
- Firestore is the primary store for categories, products, orders, order lines, messages, and hotel settings. Browser listeners keep catalog, bills, dashboard data, and team messages current.
- The Express API verifies Firebase ID tokens and role claims before writes. It recalculates order prices from Firestore product records and checks staff/customer access.
- The snapshot API exposes `GET /api/products` and authenticated `GET /api/orders`, `/api/messages`, and `/api/settings`; manager product/settings writes and staff order/message writes accept Firebase bearer tokens. Catalog reads and queued order writes can fall back to SQLite during a Firestore outage.
- Login remains Firebase Authentication on the client. The API intentionally has no SQLite password login endpoint.
- Successful writes are backed up to SQLite. If Firestore is temporarily unavailable, the API persists a durable SQLite outbox and retries it every five minutes. Browser writes made while disconnected are kept locally and submitted when connectivity returns.
- Firebase client offline persistence uses IndexedDB. Offline orders remain pending until synced and paid; they are never marked paid by the browser.
- Waiters can use POS and Messages. Cashiers and supervisors can view and settle pending bills. Only managers/admins can view full billing history, manage products, and change hotel settings.
- Firebase Hosting publishes only `hosting/`, never the backend source, SQLite database, `.env`, or service-account JSON.

Orders are stored in `orders`, nested `orders/{id}/lines`, and the requested top-level `order_items` collection. Profile, product, message, and settings payloads are backed up in SQLite; order payment status updates also update the relational order row.

## Firebase deployment

Refresh the Firebase Hosting bundle after editing the canonical frontend files:

```sh
npm run build:hosting
```

This copies the frontend into `hosting/`. Firebase Hosting publishes only that directory. Set `window.POS_API_BASE_URL` in `hosting/runtime-config.js` to the deployed Express API HTTPS origin.

Review `firestore.rules`, `storage.rules`, and `firestore.indexes.json`, then deploy the Firebase resources:

```sh
firebase use YOUR_PROJECT_ID
firebase deploy --only firestore:rules,firestore:indexes,storage,functions,hosting
```

Update `firebase.js` plus the Firebase Messaging configuration in `sw.js` for your Web App before building. Set API `CORS_ORIGINS` to the Firebase Hosting origin.

Set payment secrets in Firebase Functions (never in `.env` committed to source or frontend files):

```sh
firebase functions:secrets:set STRIPE_SECRET_KEY
firebase functions:secrets:set STRIPE_WEBHOOK_SECRET
firebase functions:secrets:set MPESA_CONSUMER_KEY
firebase functions:secrets:set MPESA_CONSUMER_SECRET
firebase functions:secrets:set MPESA_PASSKEY
firebase functions:config:set app.frontend_url="https://YOUR_PROJECT.web.app"
```

Create a Stripe webhook pointing to `https://us-central1-YOUR_PROJECT_ID.cloudfunctions.net/stripeWebhook` and subscribe to `checkout.session.completed` and `checkout.session.async_payment_succeeded`. Configure the Stripe signing secret above. Stripe checkout uses the authoritative Firestore order total and KES currency. Configure Safaricom Daraja credentials and the correct shortcode/environment before enabling live M-Pesa payments.

Deploy the Express API separately (for example, to Render using the included `render.yaml`, or to a VM/container). On Render, configure `FIREBASE_SERVICE_ACCOUNT_JSON` as a secret and set `CORS_ORIGINS`. The included disk stores SQLite at `/data/hoteli_poa.db`. Set the API origin in `hosting/runtime-config.js`, run `npm run build:hosting`, then deploy Hosting. Firebase Hosting alone does not run the Express server.

## Backups and operations

The default local database is `hoteli_poa.db`. For a persistent production mount set `SQLITE_PATH=/data/hoteli_poa.db`. Back up that file along with Firestore exports according to your recovery policy. `/api/health` reports API status and whether Firebase Admin initialized.

Never commit `.env`, `serviceAccountKey.json`, private payment keys, Firebase debug logs, or production database files. Replace demo passwords and any test payment credentials before opening the system to staff or customers.
