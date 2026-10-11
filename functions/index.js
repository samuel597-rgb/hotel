// cspell:words simplewebauthn firestore PESA Safaricom safaricom Daraja MPESA mpesa Mpesa Pesa stkpush processrequest WEBAUTHN webauthn RPID
const functions = require('firebase-functions');
const admin = require('firebase-admin');
const axios = require('axios');
const PDFDocument = require('pdfkit');
const crypto = require('node:crypto');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse
} = require('@simplewebauthn/server');

admin.initializeApp();
const db = admin.firestore();

// ═══════════════════════════════════════════════
//  ROLE MANAGEMENT
// ═══════════════════════════════════════════════
exports.setUserRole = functions.https.onCall(async (data, ctx) => {
  if (!ctx.auth) throw new functions.https.HttpsError('unauthenticated', 'Sign in required');
  const caller = await admin.auth().getUser(ctx.auth.uid);
  if (!['manager', 'admin'].includes(caller.customClaims?.role))
    throw new functions.https.HttpsError('permission-denied', 'Manager only');
  if (typeof data.uid !== 'string' || !['manager', 'admin', 'supervisor', 'cashier', 'waiter'].includes(data.role))
    throw new functions.https.HttpsError('invalid-argument', 'Valid user ID and role required');
  await admin.auth().setCustomUserClaims(data.uid, { role: data.role });
  const target = await admin.auth().getUser(data.uid);
  await db.collection('users').doc(data.uid).set({
    id: data.uid, name: target.displayName || target.email || 'Staff', email: target.email || '',
    role: data.role, status: target.disabled ? 'disabled' : 'active', updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
  return { ok: true };
});

// ═══════════════════════════════════════════════
//  STRIPE PAYMENT INTENT
// ═══════════════════════════════════════════════
exports.createStripePaymentIntent = functions.runWith({
  secrets: ['STRIPE_SECRET_KEY']
}).https.onCall(async (data, ctx) => {
  if (!ctx.auth) throw new functions.https.HttpsError('unauthenticated', 'Login required');
  if (typeof data.orderId !== 'string' || !data.orderId)
    throw new functions.https.HttpsError('invalid-argument', 'Order ID required');
  if (!process.env.STRIPE_SECRET_KEY)
    throw new functions.https.HttpsError('failed-precondition', 'Stripe is not configured');

  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  try {
    const orderRef = db.collection('orders').doc(data.orderId);
    const orderSnapshot = await orderRef.get();
    if (!orderSnapshot.exists) throw new functions.https.HttpsError('not-found', 'Order not found');
    const order = orderSnapshot.data();
    const staff = ['waiter', 'cashier', 'supervisor', 'manager', 'admin'].includes(ctx.auth.token.role);
    if (!staff && order.customerId !== ctx.auth.uid)
      throw new functions.https.HttpsError('permission-denied', 'This order does not belong to you');
    if (order.paymentStatus === 'paid' || !Number.isFinite(order.total) || order.total <= 0)
      throw new functions.https.HttpsError('failed-precondition', 'Order is not payable');
    const intent = await stripe.paymentIntents.create({
      amount: Math.round(order.total * 100),
      currency: 'kes',
      metadata: { orderId: data.orderId, userId: ctx.auth.uid }
    });
    return { clientSecret: intent.client_secret };
  } catch (err) {
    console.error('Stripe error:', err);
    throw new functions.https.HttpsError('internal', err.message);
  }
});

exports.createStripeCheckoutSession = functions.runWith({
  secrets: ['STRIPE_SECRET_KEY']
}).https.onCall(async (data, ctx) => {
  if (!ctx.auth) throw new functions.https.HttpsError('unauthenticated', 'Login required');
  if (typeof data.orderId !== 'string' || !data.orderId)
    throw new functions.https.HttpsError('invalid-argument', 'Order ID required');
  if (!process.env.STRIPE_SECRET_KEY)
    throw new functions.https.HttpsError('failed-precondition', 'Stripe is not configured');

  const orderRef = db.collection('orders').doc(data.orderId);
  const orderSnapshot = await orderRef.get();
  if (!orderSnapshot.exists) throw new functions.https.HttpsError('not-found', 'Order not found');
  const order = orderSnapshot.data();
  const staff = ['waiter', 'cashier', 'supervisor', 'manager', 'admin'].includes(ctx.auth.token.role);
  if (!staff && order.customerId !== ctx.auth.uid)
    throw new functions.https.HttpsError('permission-denied', 'This order does not belong to you');
  if (order.paymentStatus === 'paid' || !Number.isFinite(order.total) || order.total <= 0)
    throw new functions.https.HttpsError('failed-precondition', 'Order is not payable');

  try {
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    const baseUrl = String(functions.config().app?.frontend_url || process.env.FRONTEND_URL || 'https://hoteli-cd840.web.app').replace(/\/$/, '');
    if (order.stripeSessionId) {
      const existingSession = await stripe.checkout.sessions.retrieve(order.stripeSessionId);
      if (existingSession.status === 'open' && existingSession.url) return { url: existingSession.url };
    }
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'kes',
          unit_amount: Math.round(order.total * 100),
          product_data: { name: `HOTELI POA order ${data.orderId.slice(0, 8)}` }
        },
        quantity: 1
      }],
      client_reference_id: data.orderId,
      metadata: { orderId: data.orderId, userId: ctx.auth.uid },
      success_url: `${baseUrl}/app/#orders`,
      cancel_url: `${baseUrl}/app/#pos`
    }, { idempotencyKey: `hoteli-poa-${data.orderId}-${crypto.randomUUID()}` });
    await orderRef.set({ stripeSessionId: session.id }, { merge: true });
    return { url: session.url };
  } catch (error) {
    if (error instanceof functions.https.HttpsError) throw error;
    console.error('Stripe Checkout error:', error);
    throw new functions.https.HttpsError('internal', 'Could not start card checkout');
  }
});

exports.stripeWebhook = functions.runWith({
  secrets: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']
}).https.onRequest(async (req, res) => {
  if (req.method !== 'POST') return res.status(405).send('Method not allowed');
  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET)
    return res.status(503).send('Stripe webhook is not configured');
  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.rawBody, req.get('stripe-signature'), process.env.STRIPE_WEBHOOK_SECRET);
  } catch (error) {
    console.warn('Rejected Stripe webhook signature:', error.message);
    return res.status(400).send('Invalid webhook signature');
  }
  if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)) {
    const session = event.data.object;
    if (session.payment_status === 'paid') {
      const orderId = session.metadata?.orderId || session.client_reference_id;
      if (orderId) {
        await db.collection('orders').doc(orderId).set({
          status: 'paid', paymentStatus: 'paid', paymentMethod: 'card', paidAt: admin.firestore.FieldValue.serverTimestamp(),
          stripeSessionId: session.id
        }, { merge: true });
      }
    }
  }
  return res.status(200).json({ received: true });
});

// ═══════════════════════════════════════════════
//  M-PESA (Safaricom Daraja)
// ═══════════════════════════════════════════════
const MPESA = {
  key: process.env.MPESA_CONSUMER_KEY,
  secret: process.env.MPESA_CONSUMER_SECRET,
  passkey: process.env.MPESA_PASSKEY,
  shortcode: process.env.MPESA_SHORTCODE || '174379',
  env: process.env.MPESA_ENV || 'sandbox'
};

async function mpesaToken() {
  const auth = Buffer.from(`${MPESA.key}:${MPESA.secret}`).toString('base64');
  const url = `https://${MPESA.env === 'sandbox' ? 'sandbox' : 'api'}.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials`;
  const { data } = await axios.get(url, { headers: { Authorization: `Basic ${auth}` } });
  return data.access_token;
}

exports.initiateMpesaPayment = functions.runWith({
  secrets: ['MPESA_CONSUMER_KEY', 'MPESA_CONSUMER_SECRET', 'MPESA_PASSKEY']
}).https.onCall(async (data, ctx) => {
  if (!ctx.auth) throw new functions.https.HttpsError('unauthenticated', 'Login required');
  if (!/^2547\d{8}$/.test(data.phoneNumber || '') || typeof data.orderId !== 'string' || !data.orderId)
    throw new functions.https.HttpsError('invalid-argument', 'Valid phone number and order ID required');
  const orderRef = db.collection('orders').doc(data.orderId);
  const orderSnapshot = await orderRef.get();
  if (!orderSnapshot.exists) throw new functions.https.HttpsError('not-found', 'Order not found');
  const order = orderSnapshot.data();
  const staff = ['waiter', 'cashier', 'supervisor', 'manager', 'admin'].includes(ctx.auth.token.role);
  if (!staff && order.customerId !== ctx.auth.uid)
    throw new functions.https.HttpsError('permission-denied', 'This order does not belong to you');
  const amount = Math.round(Number(order.total));
  if (!Number.isInteger(amount) || amount <= 0 || order.paymentStatus === 'paid')
    throw new functions.https.HttpsError('failed-precondition', 'Order is not payable');
  try {
    const token = await mpesaToken();
    const ts = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
    const pwd = Buffer.from(`${MPESA.shortcode}${MPESA.passkey}${ts}`).toString('base64');
    const url = `https://${MPESA.env === 'sandbox' ? 'sandbox' : 'api'}.safaricom.co.ke/mpesa/stkpush/v1/processrequest`;

    const body = {
      BusinessShortCode: MPESA.shortcode,
      Password: pwd,
      Timestamp: ts,
      TransactionType: 'CustomerPayBillOnline',
      Amount: amount,
      PartyA: data.phoneNumber,
      PartyB: MPESA.shortcode,
      PhoneNumber: data.phoneNumber,
      CallBackURL: `https://us-central1-${process.env.GCLOUD_PROJECT}.cloudfunctions.net/mpesaCallback`,
      AccountReference: data.orderId || "HOTELI POA",
      TransactionDesc: "HOTELI POA"
    };
    const { data: res } = await axios.post(url, body, {
      headers: { Authorization: `Bearer ${token}` }
    });
    await db.collection('mpesa_payments').add({
      orderId: data.orderId, userId: ctx.auth.uid,
      checkoutRequestId: res.CheckoutRequestID,
      status: 'pending', createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    return { success: true, message: 'STK Push sent. Check your phone.' };
  } catch (err) {
    console.error('M-Pesa error:', err.response?.data || err.message);
    throw new functions.https.HttpsError('internal', 'Payment initiation failed');
  }
});

exports.mpesaCallback = functions.https.onRequest(async (req, res) => {
  const cb = req.body?.Body?.stkCallback;
  if (cb) {
    const snap = await db.collection('mpesa_payments')
      .where('checkoutRequestId', '==', cb.CheckoutRequestID).get();
    const batch = db.batch();
    snap.forEach(d => {
      const status = cb.ResultCode === 0 ? 'paid' : 'failed';
      batch.update(d.ref, { status, resultCode: cb.ResultCode });
      const payment = d.data();
      if (payment.orderId && status === 'paid') {
        batch.update(db.collection('orders').doc(payment.orderId), {
          status: 'paid', paymentStatus: 'paid', paymentMethod: 'mpesa', paidAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }
    });
    await batch.commit();
  }
  res.status(200).send('OK');
});

// ═══════════════════════════════════════════════
//  PDF RECEIPT GENERATION
// ═══════════════════════════════════════════════
exports.generateReceiptPDF = functions.https.onCall(async (data, ctx) => {
  if (!ctx.auth) throw new functions.https.HttpsError('unauthenticated', 'Login required');
  const order = data.order;
  const fileName = `receipts/${order.id || Date.now()}_${Date.now()}.pdf`;
  const file = admin.storage().bucket().file(fileName);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A5' });
    const stream = doc.pipe(file.createWriteStream({
      metadata: { contentType: 'application/pdf' }
    }));

    // Header
    doc.fontSize(22).font('Helvetica-Bold').fillColor('#0A2540')
      .text("HOTELI POA", { align: 'center' });
    doc.fontSize(10).fillColor('#666').font('Helvetica')
       .text('Point of Sale Receipt', { align: 'center' });
    doc.moveDown();

    doc.fillColor('#000').fontSize(11);
    doc.text(`Order: #${(order.id || '').slice(0, 8).toUpperCase()}`);
    doc.text(`Table: ${order.table || '—'}   Guests: ${order.guests || 1}`);
    doc.text(`Waiter: ${order.waiterName || '—'}`);
    doc.text(`Date: ${new Date().toLocaleString()}`);
    doc.moveDown();

    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#ccc').stroke();
    doc.moveDown(0.5);

    // Line items
    doc.font('Helvetica-Bold').fontSize(10);
    doc.text('Item', 50, doc.y, { continued: false });
    let y = doc.y + 14;
    (order.lines || []).forEach(l => {
      doc.font('Helvetica').fontSize(10).fillColor('#000');
      doc.text(`${l.qty} × ${l.name}`, 50, y);
      doc.text(`KSh ${Math.round(l.qty * l.price).toLocaleString('en-KE')}`, 400, y, { width: 145, align: 'right' });
      y += 16;
    });

    doc.moveTo(50, y + 4).lineTo(545, y + 4).strokeColor('#ccc').stroke();
    y += 16;

    // Totals
    doc.font('Helvetica').fontSize(11).fillColor('#000');
    doc.text('Subtotal', 350, y);
    doc.text(`KSh ${Math.round(order.subtotal || 0).toLocaleString('en-KE')}`, 400, y, { width: 145, align: 'right' });
    y += 16;
    doc.text('Tax', 350, y);
    doc.text(`KSh ${Math.round(order.tax || 0).toLocaleString('en-KE')}`, 400, y, { width: 145, align: 'right' });
    y += 20;

    doc.font('Helvetica-Bold').fontSize(14).fillColor('#1E6FD9');
    doc.text('TOTAL', 350, y);
    doc.text(`KSh ${Math.round(order.total || 0).toLocaleString('en-KE')}`, 400, y, { width: 145, align: 'right' });
    y += 30;

    doc.font('Helvetica').fontSize(9).fillColor('#888')
       .text('Thank you for dining with us!', 50, y, { align: 'center' });

    doc.end();

    stream.on('finish', async () => {
      const [url] = await file.getSignedUrl({
        action: 'read',
        expires: Date.now() + 15 * 60 * 1000
      });
      resolve({ url });
    });
    stream.on('error', (e) => {
      console.error('PDF error:', e);
      reject(new functions.https.HttpsError('internal', 'PDF failed'));
    });
  });
});

// ═══════════════════════════════════════════════
//  ANALYTICS (daily aggregation on paid orders)
// ═══════════════════════════════════════════════
exports.onOrderPaid = functions.firestore
  .document('orders/{orderId}')
  .onWrite(async (change) => {
    const before = change.before.data();
    const after = change.after.data();
    if (!after || after.status !== 'paid' || before?.status === 'paid') return;

    const dayKey = new Date().toISOString().slice(0, 10);
    await db.collection('analytics_daily').doc(dayKey).set({
      date: dayKey,
      revenue: admin.firestore.FieldValue.increment(after.total || 0),
      orders: admin.firestore.FieldValue.increment(1)
    }, { merge: true });

    if (after.customerId) {
      await sendPushToUser(
        after.customerId,
        'Payment success',
        `Your order #${change.after.id.slice(0, 6)} was paid.`,
        'Payment success',
        { orderId: change.after.id }
      );
    }
    const managers = await usersWithRoles(['manager', 'admin']);
    await Promise.all(managers
      .filter(user => user.uid !== after.waiterId)
      .map(user => sendPushToUser(
        user.uid,
        'Billing alert',
        `Order #${change.after.id.slice(0, 6)} was paid.`,
        'Billing alert',
        { orderId: change.after.id }
      )));
  });

// ═══════════════════════════════════════════════
//  WEBAUTHN PASSKEYS
// ═══════════════════════════════════════════════
const passkeyCredentials = db.collection('webauthnCredentials');
const passkeyChallenges = db.collection('webauthnChallenges');
const PASSKEY_RP_NAME = "HOTELI POA";
const PASSKEY_CHALLENGE_TTL_MS = 5 * 60 * 1000;

function webauthnSite(ctx) {
  const origin = ctx.rawRequest.get('origin');
  if (process.env.FUNCTIONS_EMULATOR === 'true') {
    let url;
    try { url = new URL(origin); }
    catch { throw new functions.https.HttpsError('failed-precondition', 'A local browser origin is required.'); }
    if (!['localhost', '127.0.0.1'].includes(url.hostname) || !['5000', ''].includes(url.port))
      throw new functions.https.HttpsError('permission-denied', 'Passkeys are restricted to the local Hosting emulator.');
    return { origin: url.origin, rpId: url.hostname };
  }

  const rpId = process.env.WEBAUTHN_RP_ID || process.env.RP_ID || `${process.env.GCLOUD_PROJECT}.web.app`;
  const expectedOrigin = process.env.WEBAUTHN_ORIGIN || process.env.RP_ORIGIN || `https://${rpId}`;
  if (origin !== expectedOrigin)
    throw new functions.https.HttpsError('permission-denied', 'Passkey origin is not configured for this site.');
  return { origin: expectedOrigin, rpId };
}

async function savePasskeyChallenge(data) {
  const challengeId = crypto.randomUUID();
  await passkeyChallenges.doc(challengeId).set({
    ...data,
    expiresAt: Date.now() + PASSKEY_CHALLENGE_TTL_MS,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });
  return challengeId;
}

async function consumePasskeyChallenge(challengeId, action, uid) {
  if (typeof challengeId !== 'string' || !challengeId)
    throw new functions.https.HttpsError('invalid-argument', 'Passkey challenge is missing.');
  const ref = passkeyChallenges.doc(challengeId);
  return db.runTransaction(async transaction => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) throw new functions.https.HttpsError('unauthenticated', 'Passkey challenge is invalid or already used.');
    const challenge = snapshot.data();
    if (challenge.action !== action || challenge.expiresAt < Date.now() || (uid && challenge.uid !== uid))
      throw new functions.https.HttpsError('unauthenticated', 'Passkey challenge is invalid or expired.');
    transaction.delete(ref);
    return challenge;
  });
}

exports.webauthnChallenge = functions.https.onCall(async (data, ctx) => {
  const site = webauthnSite(ctx);
  if (data.action === 'register') {
    if (!ctx.auth) throw new functions.https.HttpsError('unauthenticated', 'Sign in before registering a passkey.');
    const user = await admin.auth().getUser(ctx.auth.uid);
    const existing = await passkeyCredentials.where('uid', '==', user.uid).get();
    const options = await generateRegistrationOptions({
      rpName: PASSKEY_RP_NAME,
      rpID: site.rpId,
      userID: Buffer.from(user.uid),
      userName: user.email || user.phoneNumber || user.uid,
      userDisplayName: data.displayName || user.displayName || user.email || 'Hotel user',
      attestationType: 'none',
      timeout: 60000,
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        residentKey: 'required',
        userVerification: 'required'
      },
      excludeCredentials: existing.docs.map(doc => ({
        id: doc.data().credentialId,
        transports: doc.data().transports || []
      }))
    });
    const challengeId = await savePasskeyChallenge({
      uid: user.uid, action: 'register', challenge: options.challenge, ...site
    });
    return { ...options, challengeId, rpId: site.rpId, rpName: PASSKEY_RP_NAME };
  }

  if (data.action === 'authenticate') {
    const email = String(data.email || '').trim();
    if (!email) throw new functions.https.HttpsError('invalid-argument', 'Enter your account email to use a passkey.');
    let user;
    try { user = await admin.auth().getUserByEmail(email); }
    catch { throw new functions.https.HttpsError('failed-precondition', 'Passkey sign-in is unavailable for this account.'); }
    const existing = await passkeyCredentials.where('uid', '==', user.uid).get();
    if (existing.empty)
      throw new functions.https.HttpsError('failed-precondition', 'Passkey sign-in is unavailable for this account.');
    const options = await generateAuthenticationOptions({
      rpID: site.rpId,
      timeout: 60000,
      userVerification: 'required',
      allowCredentials: existing.docs.map(doc => ({
        id: doc.data().credentialId,
        transports: doc.data().transports || []
      }))
    });
    const challengeId = await savePasskeyChallenge({
      uid: user.uid, action: 'authenticate', challenge: options.challenge, ...site
    });
    return { ...options, challengeId, rpId: site.rpId };
  }

  throw new functions.https.HttpsError('invalid-argument', 'Passkey action must be register or authenticate.');
});

exports.webauthnRegister = functions.https.onCall(async (data, ctx) => {
  if (!ctx.auth) throw new functions.https.HttpsError('unauthenticated', 'Sign in before registering a passkey.');
  const challenge = await consumePasskeyChallenge(data.challengeId, 'register', ctx.auth.uid);
  const verification = await verifyRegistrationResponse({
    response: data.response,
    expectedChallenge: challenge.challenge,
    expectedOrigin: challenge.origin,
    expectedRPID: challenge.rpId,
    requireUserVerification: true
  });
  const info = verification.registrationInfo;
  if (!verification.verified || !info?.userVerified || !info.credential)
    throw new functions.https.HttpsError('permission-denied', 'Passkey registration could not be verified.');

  const credential = info.credential;
  const ref = passkeyCredentials.doc(credential.id);
  await db.runTransaction(async transaction => {
    const existing = await transaction.get(ref);
    if (existing.exists) throw new functions.https.HttpsError('already-exists', 'This passkey is already registered.');
    transaction.set(ref, {
      uid: ctx.auth.uid,
      credentialId: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString('base64'),
      counter: credential.counter,
      transports: credential.transports || data.response.response.transports || [],
      deviceType: info.credentialDeviceType,
      backedUp: info.credentialBackedUp,
      name: String(data.name || 'Fingerprint / passkey').slice(0, 80),
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
  });
  return { ok: true, id: credential.id };
});

exports.webauthnVerify = functions.https.onCall(async (data, ctx) => {
  const challenge = await consumePasskeyChallenge(data.challengeId, 'authenticate');
  const credentialId = data.response?.id;
  if (typeof credentialId !== 'string')
    throw new functions.https.HttpsError('invalid-argument', 'Passkey response is invalid.');
  const credentialRef = passkeyCredentials.doc(credentialId);
  const credentialSnapshot = await credentialRef.get();
  if (!credentialSnapshot.exists || credentialSnapshot.data().uid !== challenge.uid)
    throw new functions.https.HttpsError('unauthenticated', 'Passkey could not be verified.');

  const stored = credentialSnapshot.data();
  const verification = await verifyAuthenticationResponse({
    response: data.response,
    expectedChallenge: challenge.challenge,
    expectedOrigin: challenge.origin,
    expectedRPID: challenge.rpId,
    credential: {
      id: stored.credentialId,
      publicKey: new Uint8Array(Buffer.from(stored.publicKey, 'base64')),
      counter: stored.counter,
      transports: stored.transports || []
    },
    requireUserVerification: true
  });
  if (!verification.verified || !verification.authenticationInfo.userVerified)
    throw new functions.https.HttpsError('unauthenticated', 'Passkey could not be verified.');

  await credentialRef.update({
    counter: verification.authenticationInfo.newCounter,
    lastUsedAt: admin.firestore.FieldValue.serverTimestamp()
  });
  const user = await admin.auth().getUser(challenge.uid);
  const customToken = await admin.auth().createCustomToken(user.uid, user.customClaims || {});
  return { customToken };
});

exports.webauthnListPasskeys = functions.https.onCall(async (data, ctx) => {
  if (!ctx.auth) throw new functions.https.HttpsError('unauthenticated', 'Sign in required.');
  const snapshot = await passkeyCredentials.where('uid', '==', ctx.auth.uid).get();
  return {
    passkeys: snapshot.docs.map(doc => {
      const passkey = doc.data();
      return {
        id: passkey.credentialId,
        name: passkey.name || 'Fingerprint / passkey',
        createdAt: passkey.createdAt?.toDate?.().toISOString() || null,
        lastUsedAt: passkey.lastUsedAt?.toDate?.().toISOString() || null
      };
    })
  };
});

exports.webauthnDeletePasskey = functions.https.onCall(async (data, ctx) => {
  if (!ctx.auth) throw new functions.https.HttpsError('unauthenticated', 'Sign in required.');
  if (typeof data.credentialId !== 'string')
    throw new functions.https.HttpsError('invalid-argument', 'Passkey ID is required.');
  const ref = passkeyCredentials.doc(data.credentialId);
  const snapshot = await ref.get();
  if (!snapshot.exists || snapshot.data().uid !== ctx.auth.uid)
    throw new functions.https.HttpsError('not-found', 'Passkey not found.');
  await ref.delete();
  return { ok: true };
});

// ═══════════════════════════════════════════════
//  PUSH NOTIFICATIONS AND WEEKLY REPORTS
// ═══════════════════════════════════════════════
async function allAuthUsers() {
  const users = [];
  let pageToken;
  do {
    const page = await admin.auth().listUsers(1000, pageToken);
    users.push(...page.users);
    pageToken = page.pageToken;
  } while (pageToken);
  return users;
}

async function usersWithRoles(roles) {
  const users = await allAuthUsers();
  return users.filter(user => roles.includes(user.customClaims?.role));
}

async function sendPushToUser(uid, title, body, preferenceName, payload = {}) {
  const settingsRef = db.collection('userSettings').doc(uid);
  const settingsSnap = await settingsRef.get();
  if (!settingsSnap.exists) return false;
  const settings = settingsSnap.data();
  const preference = settings.notifications?.[preferenceName];
  const token = settings.fcmToken;
  if (preference?.push !== true || !token) return false;

  const data = Object.fromEntries(Object.entries(payload).map(([key, value]) => [key, String(value)]));
  data.type = preferenceName;
  try {
    await admin.messaging().send({ token, notification: { title, body }, data });
    return true;
  } catch (error) {
    if (['messaging/invalid-registration-token', 'messaging/registration-token-not-registered'].includes(error.code)) {
      await settingsRef.set({ fcmToken: null }, { merge: true });
      return false;
    }
    throw error;
  }
}

exports.onNewMessage = functions.firestore
  .document('messages/{messageId}')
  .onCreate(async snapshot => {
    const message = snapshot.data();
    if (!message.team || !message.fromUid) return;
    const staff = await usersWithRoles(['waiter', 'cashier', 'supervisor', 'manager', 'admin']);
    await Promise.all(staff
      .filter(user => user.uid !== message.fromUid)
      .map(user => sendPushToUser(
        user.uid,
        `New message · ${message.team}`,
        `${message.fromName || 'Staff'}: ${message.text || ''}`,
        'New messages',
        { messageId: snapshot.id, team: message.team }
      )));
  });

exports.onNewInventory = functions.firestore
  .document('products/{productId}')
  .onCreate(async snapshot => {
    const product = snapshot.data();
    const managers = await usersWithRoles(['manager', 'admin']);
    await Promise.all(managers.map(user => sendPushToUser(
      user.uid,
      'New inventory',
      `${product.name || 'A product'} was added to the menu.`,
      'New inventory',
      { productId: snapshot.id }
    )));
  });

exports.weeklyReport = functions.pubsub
  .schedule('every monday 08:00')
  .timeZone('Africa/Nairobi')
  .onRun(async () => {
    const staff = await usersWithRoles(['waiter', 'cashier', 'supervisor', 'manager', 'admin']);
    const staffById = new Map(staff.map(user => [user.uid, user]));
    const settingsSnapshot = await db.collection('userSettings').get();
    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - 7);

    for (const settingsDoc of settingsSnapshot.docs) {
      const user = staffById.get(settingsDoc.id);
      const settings = settingsDoc.data();
      const preference = settings.notifications?.['Weekly report'];
      if (!user || (!preference?.email && !preference?.push)) continue;

      const ordersSnapshot = await db.collection('orders').where('waiterId', '==', user.uid).get();
      const recentPaidOrders = ordersSnapshot.docs.filter(order => {
        const data = order.data();
        const createdAt = data.createdAt?.toDate?.();
        return createdAt && createdAt >= weekStart && (data.paymentStatus === 'paid' || data.status === 'paid');
      });
      const revenue = recentPaidOrders.reduce((sum, order) => sum + (order.data().total || 0), 0);
      const report = `Orders: ${recentPaidOrders.length}. Revenue: KSh ${Math.round(revenue).toLocaleString('en-KE')}.`;

      if (preference.email === true && user.email) {
        await db.collection('mail').add({
          to: user.email,
          message: {
            subject: "HOTELI POA — Weekly report",
            text: `Your weekly report\n${report}`
          }
        });
      }
      if (preference.push === true) {
        await sendPushToUser(user.uid, 'Weekly report ready', report, 'Weekly report', { weekStart: weekStart.toISOString() });
      }
    }
  });
