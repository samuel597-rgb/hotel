// Idempotent HOTELI POA Firestore menu seeder.
// Firebase Admin credentials come from FIREBASE_SERVICE_ACCOUNT_PATH,
// FIREBASE_SERVICE_ACCOUNT_JSON, or GOOGLE_APPLICATION_CREDENTIALS.
'use strict';

const admin = require('firebase-admin');
const path = require('node:path');
const menu = require('./menu');
require('dotenv').config();

const MENU_VERSION = 2;
const categoryMap = new Map();
for (const product of menu) {
  if (!categoryMap.has(product.categoryId)) {
    categoryMap.set(product.categoryId, {
      id: product.categoryId,
      name: product.sub_category,
      department: product.department,
      sequence: (categoryMap.size + 1) * 10,
      color: categoryMap.size % 2 ? '#0A2540' : '#1E6FD9',
      icon: product.department === 'drinks' ? '☕' : '🍲',
      isAvailable: true
    });
  }
}
const CATEGORIES = [...categoryMap.values()];
const documentId = name => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

async function commitInBatches(db, operations) {
  for (let offset = 0; offset < operations.length; offset += 400) {
    const batch = db.batch();
    for (const operation of operations.slice(offset, offset + 400)) {
      batch.set(operation.ref, operation.data, { merge: true });
    }
    await batch.commit();
  }
}

async function seed(db, firebaseAdmin = admin) {
  const markerRef = db.collection('settings').doc('menu-version');
  const marker = await markerRef.get();
  if (Number(marker.data()?.version || 0) >= MENU_VERSION) return 0;

  const [oldProducts, oldCategories, generalSettings] = await Promise.all([
    db.collection('products').get(),
    db.collection('categories').get(),
    db.collection('settings').doc('general').get()
  ]);
  const now = firebaseAdmin.firestore.FieldValue.serverTimestamp();
  const activeProductIds = new Set(menu.map(product => documentId(product.name)));
  const activeCategoryIds = new Set(CATEGORIES.map(category => category.id));
  const operations = [];

  for (const category of CATEGORIES) {
    operations.push({ ref: db.collection('categories').doc(category.id), data: category });
  }
  for (const snapshot of oldCategories.docs) {
    if (!activeCategoryIds.has(snapshot.id)) {
      operations.push({ ref: snapshot.ref, data: { isAvailable: false } });
    }
  }

  for (const product of menu) {
    const id = documentId(product.name);
    operations.push({
      ref: db.collection('products').doc(id),
      data: {
        id,
        name: product.name,
        price: product.price,
        categoryId: product.categoryId,
        category: product.category,
        sub_category: product.sub_category,
        department: product.department,
        imageUrl: product.imageUrl,
        image_url: product.image_url,
        unit: product.unit,
        isAvailable: true,
        createdAt: now
      }
    });
  }
  for (const snapshot of oldProducts.docs) {
    if (!activeProductIds.has(snapshot.id)) {
      operations.push({ ref: snapshot.ref, data: { isAvailable: false } });
    }
  }
  if (!generalSettings.exists) {
    operations.push({ ref: db.collection('settings').doc('general'), data: {
      id: 'general', key: 'general', hotelName: 'HOTELI POA', currency: 'KES', taxRate: 0,
      value: { hotelName: 'HOTELI POA', currency: 'KES', taxRate: 0 },
      theme: { primary: '#1E6FD9', bg: '#FFFFFF' }
    } });
  }
  operations.push({ ref: markerRef, data: {
    id: markerRef.id, key: 'menuVersion', value: MENU_VERSION,
    version: MENU_VERSION, updatedAt: now
  } });

  await commitInBatches(db, operations);
  return menu.length + CATEGORIES.length;
}

async function runSeed() {
  if (!admin.apps.length) {
    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)) });
    } else if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
      admin.initializeApp({ credential: admin.credential.cert(require(path.resolve(process.env.FIREBASE_SERVICE_ACCOUNT_PATH))) });
    } else {
      admin.initializeApp({ credential: admin.credential.applicationDefault() });
    }
  }
  const count = await seed(admin.firestore(), admin);
  console.log(count ? `Applied menu version ${MENU_VERSION}: ${menu.length} products and ${CATEGORIES.length} categories.` : 'The current HOTELI POA menu is already seeded.');
  await admin.app().delete();
}

if (require.main === module) runSeed().catch(error => { console.error(error); process.exit(1); });
module.exports = { seed, CATEGORIES, PRODUCTS: menu };
