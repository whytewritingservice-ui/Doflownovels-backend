'use strict';

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const admin = require('firebase-admin');

const ADMIN_EMAIL = 'whytewritingservice@gmail.com';
const FRONTEND_URL = 'https://doflownovels.netlify.app/';

const app = express();
app.disable('x-powered-by');

app.use(cors());
app.use(express.json({
  limit: '1mb',
  verify: (req, res, buffer) => {
    req.rawBody = buffer;
  }
}));

let db;
let auth;

try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

  serviceAccount.private_key = String(serviceAccount.private_key)
    .replace(/\\n/g, '\n');

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
  }

  db = admin.firestore();
  auth = admin.auth();

  console.log('Firebase Admin initialized successfully.');
} catch (error) {
  console.error(
    'FATAL ERROR: Firebase Admin initialization failed. Check FIREBASE_SERVICE_ACCOUNT.',
    error
  );

  process.exit(1);
}

const serverTimestamp = () =>
  admin.firestore.FieldValue.serverTimestamp();

const roundMoney = value =>
  Math.round((Number(value) + Number.EPSILON) * 100) / 100;

async function verifyFirebaseToken(req, res, next) {
  try {
    const header = req.headers.authorization || '';

    if (!header.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        error: 'Login required.'
      });
    }

    req.user = await auth.verifyIdToken(
      header.substring(7),
      true
    );

    return next();
  } catch (error) {
    console.error('Firebase token verification failed:', error?.code);

    return res.status(401).json({
      success: false,
      error: 'Invalid or expired login.'
    });
  }
}

function requireAdmin(req, res, next) {
  const email = String(req.user?.email || '').toLowerCase();

  if (email !== ADMIN_EMAIL) {
    return res.status(403).json({
      success: false,
      error: 'Administrator access only.'
    });
  }

  return next();
}

app.get('/', (req, res) => {
  res.json({
    success: true,
    service: 'Doflownovels Backend',
    status: 'running'
  });
});

app.get('/health', (req, res) => {
  res.json({
    success: true,
    status: 'healthy'
  });
});
// =========================================================
// OLD FLUTTERWAVE AUTHOR UNLOCK WEBHOOK
// =========================================================

app.post('/api/doflow-unlock', async (req, res) => {
  try {
    const payload = req.body || {};
    const txRef = payload?.data?.tx_ref;

    if (!txRef || !String(txRef).startsWith('doflow_')) {
      return res.status(200).json({
        status: 'ignored',
        message: 'Not a Doflow transaction.'
      });
    }

    const transactionId = payload.data.id;
    const customerEmail = payload?.data?.customer?.email;

    if (!transactionId || !customerEmail) {
      return res.status(400).json({
        error: 'Invalid webhook payload.'
      });
    }

    const flutterwaveResponse = await fetch(
      `https://api.flutterwave.com/v3/transactions/${transactionId}/verify`,
      {
        headers: {
          Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`
        }
      }
    );

    const flutterwaveData = await flutterwaveResponse.json();

    const paymentSuccessful =
      flutterwaveData?.status === 'success' &&
      flutterwaveData?.data?.status === 'successful';

    if (!paymentSuccessful) {
      return res.status(400).json({
        error: 'Payment verification failed.'
      });
    }

    const authorsSnapshot = await db
      .collection('authors')
      .where('email', '==', customerEmail)
      .get();

    if (authorsSnapshot.empty) {
      return res.status(404).json({
        error: 'Author not found.'
      });
    }

    const batch = db.batch();

    authorsSnapshot.forEach(document => {
      batch.update(document.ref, {
        isPro: true,
        unlockedAt: serverTimestamp()
      });
    });

    await batch.commit();

    return res.json({
      status: 'success',
      message: 'Author unlocked.'
    });
  } catch (error) {
    console.error('Doflow unlock webhook error:', error);

    return res.status(500).json({
      error: 'Internal server error.'
    });
  }
});

// =========================================================
// ADMIN MANUAL UNLOCK
// =========================================================

app.post(
  '/api/admin/unlock',
  verifyFirebaseToken,
  requireAdmin,
  async (req, res) => {
    try {
      const targetUid = String(req.body?.targetUid || '').trim();

      if (!targetUid) {
        return res.status(400).json({
          error: 'Missing targetUid.'
        });
      }

      const userRecord = await auth.getUser(targetUid);

      await db.collection('authors').doc(targetUid).set({
        email: userRecord.email || '',
        displayName: userRecord.displayName || '',
        isPro: true,
        unlockedByAdmin: true,
        unlockedAt: serverTimestamp()
      }, { merge: true });

      return res.json({
        success: true,
        message: 'Author unlocked.'
      });
    } catch (error) {
      console.error('Admin unlock error:', error);

      return res.status(500).json({
        error: 'Could not unlock author.'
      });
    }
  }
);
// =========================================================
// CODO BILL SETTINGS
// =========================================================

const codoSettingsRef = db
  .collection('platformSettings')
  .doc('codoBills');

async function getCodoSettings() {
  const snapshot = await codoSettingsRef.get();
  const saved = snapshot.exists ? snapshot.data() : {};

  return {
    enabled: saved.enabled !== false,
    billPriceGBP: Number(saved.billPriceGBP || 1),
    currencyRates: {
      GBP: 1,
      ...(saved.currencyRates || {})
    },
    bundles: [1, 3, 5, 10]
  };
}

app.get(
  '/api/admin/codo-bills/settings',
  verifyFirebaseToken,
  requireAdmin,
  async (req, res) => {
    try {
      return res.json({
        success: true,
        settings: await getCodoSettings()
      });
    } catch (error) {
      console.error('Codo settings error:', error);

      return res.status(500).json({
        success: false,
        error: 'Unable to load Codo settings.'
      });
    }
  }
);

app.put(
  '/api/admin/codo-bills/settings',
  verifyFirebaseToken,
  requireAdmin,
  async (req, res) => {
    try {
      const body = req.body || {};
      const update = {};

      if (body.enabled !== undefined) {
        if (typeof body.enabled !== 'boolean') {
          return res.status(400).json({
            error: 'Invalid enabled setting.'
          });
        }

        update.enabled = body.enabled;
      }

      if (body.billPriceGBP !== undefined) {
        const price = Number(body.billPriceGBP);

        if (!Number.isFinite(price) || price <= 0) {
          return res.status(400).json({
            error: 'Invalid bill price.'
          });
        }

        update.billPriceGBP = roundMoney(price);
      }

      if (body.currencyRates !== undefined) {
        if (
          !body.currencyRates ||
          typeof body.currencyRates !== 'object' ||
          Array.isArray(body.currencyRates)
        ) {
          return res.status(400).json({
            error: 'Invalid currency rates.'
          });
        }

        const rates = { GBP: 1 };

        for (const [rawCode, rawRate] of Object.entries(body.currencyRates)) {
          const code = String(rawCode).toUpperCase();
          const rate = Number(rawRate);

          if (
            !/^[A-Z]{3}$/.test(code) ||
            !Number.isFinite(rate) ||
            rate <= 0
          ) {
            return res.status(400).json({
              error: 'Invalid currency rate.'
            });
          }

          if (code !== 'GBP') {
            rates[code] = rate;
          }
        }

        update.currencyRates = rates;
      }

      update.updatedAt = serverTimestamp();
      update.updatedBy = req.user.uid;

      await codoSettingsRef.set(update, { merge: true });

      return res.json({
        success: true,
        message: 'Codo settings updated.',
        settings: await getCodoSettings()
      });
    } catch (error) {
      console.error('Codo settings update error:', error);

      return res.status(500).json({
        success: false,
        error: 'Unable to update Codo settings.'
      });
    }
  }
);

// =========================================================
// CODO WALLET
// =========================================================

app.get(
  '/api/codo-bills/wallet',
  verifyFirebaseToken,
  async (req, res) => {
    try {
      const uid = req.user.uid;

      const [walletSnapshot, transactionsSnapshot] = await Promise.all([
        db.collection('codoWallets').doc(uid).get(),

        db.collection('codoTransactions')
          .where('uid', '==', uid)
          .limit(50)
          .get()
      ]);

      const wallet = walletSnapshot.exists
        ? walletSnapshot.data()
        : {};

      const purchasedBills = Number(wallet.purchasedBills || 0);
      const awardedBills = Number(wallet.awardedBills || 0);

      const transactions = transactionsSnapshot.docs.map(document => ({
        id: document.id,
        ...document.data()
      }));

      transactions.sort((a, b) => {
        const first = a.createdAt?.toMillis?.() || 0;
        const second = b.createdAt?.toMillis?.() || 0;
        return second - first;
      });

      return res.json({
        success: true,
        wallet: {
          purchasedBills,
          awardedBills,
          totalBills: purchasedBills + awardedBills
        },
        transactions
      });
    } catch (error) {
      console.error('Codo wallet error:', error);

      return res.status(500).json({
        success: false,
        error: 'Unable to load Codo wallet.'
      });
    }
  }
);
// =========================================================
// CODO CHECKOUT
// =========================================================

app.post(
  '/api/codo-bills/checkout',
  verifyFirebaseToken,
  async (req, res) => {
    let paymentRef = null;

    try {
      if (!process.env.FLW_SECRET_KEY) {
        return res.status(503).json({
          success: false,
          error: 'Flutterwave is not configured.'
        });
      }

      const settings = await getCodoSettings();

      if (!settings.enabled) {
        return res.status(403).json({
          success: false,
          error: 'Codo Bill purchases are temporarily disabled.'
        });
      }

      const bundle = Number(req.body?.bundle);
      const currency = String(req.body?.currency || 'GBP').toUpperCase();

      if (![1, 3, 5, 10].includes(bundle)) {
        return res.status(400).json({
          success: false,
          error: 'Choose 1, 3, 5 or 10 Codo Bills.'
        });
      }

      const email = req.user.email;

      if (!email) {
        return res.status(400).json({
          success: false,
          error: 'A verified email is required.'
        });
      }

      const rate = Number(settings.currencyRates[currency]);

      if (!Number.isFinite(rate) || rate <= 0) {
        return res.status(400).json({
          success: false,
          error: `Checkout in ${currency} has not been configured.`
        });
      }

      const amount = roundMoney(
        bundle * settings.billPriceGBP * rate
      );

      if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({
          success: false,
          error: 'Invalid payment amount.'
        });
      }

      const txRef = `codo_${req.user.uid}_${Date.now()}_${crypto
        .randomBytes(6)
        .toString('hex')}`;

      paymentRef = db.collection('codoTransactions').doc(txRef);

      await paymentRef.set({
        uid: req.user.uid,
        email,
        txRef,
        bundle,
        amount,
        currency,
        billPriceGBP: settings.billPriceGBP,
        exchangeRate: rate,
        type: 'bill_purchase',
        status: 'pending',
        createdAt: serverTimestamp()
      });

      const flutterwaveResponse = await fetch(
        'https://api.flutterwave.com/v3/payments',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            tx_ref: txRef,
            amount,
            currency,
            redirect_url: FRONTEND_URL,
            customer: {
              email,
              name: req.user.name || email
            },
            customizations: {
              title: 'Doflownovels Codo Bills',
              description: `${bundle} Codo Bill${bundle === 1 ? '' : 's'}`
            },
            meta: {
              uid: req.user.uid,
              product: 'doflownovels_codo_bills',
              bundle
            }
          })
        }
      );

      const paymentData = await flutterwaveResponse.json();

      if (
        !flutterwaveResponse.ok ||
        paymentData?.status !== 'success' ||
        !paymentData?.data?.link
      ) {
        await paymentRef.update({
          status: 'initialization_failed',
          updatedAt: serverTimestamp()
        });

        return res.status(502).json({
          success: false,
          error: 'Flutterwave checkout could not be started.'
        });
      }

      await paymentRef.update({
        checkoutUrl: paymentData.data.link,
        checkoutCreatedAt: serverTimestamp()
      });

      return res.json({
        success: true,
        txRef,
        checkoutUrl: paymentData.data.link,
        amount,
        currency,
        bills: bundle
      });
    } catch (error) {
      console.error('Codo checkout error:', error);

      if (paymentRef) {
        try {
          await paymentRef.update({
            status: 'initialization_error',
            updatedAt: serverTimestamp()
          });
        } catch (_) {}
      }

      return res.status(500).json({
        success: false,
        error: 'Unable to start Codo Bill checkout.'
      });
    }
  }
);
// =========================================================
// CODO PAYMENT VERIFICATION
// =========================================================

app.post(
  '/api/codo-bills/verify-payment',
  verifyFirebaseToken,
  async (req, res) => {
    try {
      const transactionId = String(req.body?.transactionId || '').trim();
      const txRef = String(req.body?.txRef || '').trim();

      if (!transactionId || !txRef) {
        return res.status(400).json({
          success: false,
          error: 'Transaction ID and reference are required.'
        });
      }

      if (!txRef.startsWith(`codo_${req.user.uid}_`)) {
        return res.status(403).json({
          success: false,
          error: 'This payment does not belong to your account.'
        });
      }

      const paymentRef = db.collection('codoTransactions').doc(txRef);
      const paymentSnapshot = await paymentRef.get();

      if (!paymentSnapshot.exists) {
        return res.status(404).json({
          success: false,
          error: 'Payment record not found.'
        });
      }

      const payment = paymentSnapshot.data();

      if (payment.uid !== req.user.uid) {
        return res.status(403).json({
          success: false,
          error: 'Payment ownership check failed.'
        });
      }

      if (payment.status === 'successful') {
        return res.json({
          success: true,
          alreadyProcessed: true,
          billsAdded: payment.bundle
        });
      }

      const flutterwaveResponse = await fetch(
        `https://api.flutterwave.com/v3/transactions/${transactionId}/verify`,
        {
          headers: {
            Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`
          }
        }
      );

      const flutterwaveData = await flutterwaveResponse.json();

      const isValid =
        flutterwaveData?.status === 'success' &&
        flutterwaveData?.data?.status === 'successful' &&
        flutterwaveData?.data?.tx_ref === txRef &&
        Number(flutterwaveData?.data?.amount) === Number(payment.amount) &&
        String(flutterwaveData?.data?.currency).toUpperCase() === payment.currency;

      if (!isValid) {
        await paymentRef.update({
          status: 'verification_failed',
          updatedAt: serverTimestamp()
        });

        return res.status(400).json({
          success: false,
          error: 'Payment verification failed.'
        });
      }

      await db.runTransaction(async transaction => {
        const freshPayment = await transaction.get(paymentRef);
        const paymentData = freshPayment.data();

        if (paymentData.status === 'successful') {
          return;
        }

        const walletRef = db.collection('codoWallets').doc(req.user.uid);
        const walletSnapshot = await transaction.get(walletRef);

        const currentPurchased = walletSnapshot.exists
          ? Number(walletSnapshot.data().purchasedBills || 0)
          : 0;

        transaction.set(walletRef, {
          uid: req.user.uid,
          purchasedBills: currentPurchased + Number(payment.bundle),
          updatedAt: serverTimestamp()
        }, { merge: true });

        transaction.update(paymentRef, {
          status: 'successful',
          flutterwaveTransactionId: transactionId,
          completedAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        });

        transaction.set(db.collection('codoTransactions').doc(), {
          uid: req.user.uid,
          txRef,
          type: 'bill_purchase_completed',
          bills: Number(payment.bundle),
          amount: payment.amount,
          currency: payment.currency,
          status: 'successful',
          createdAt: serverTimestamp()
        });
      });

      return res.json({
        success: true,
        billsAdded: payment.bundle
      });
    } catch (error) {
      console.error('Codo payment verification error:', error);

      return res.status(500).json({
        success: false,
        error: 'Unable to verify Codo Bill payment.'
      });
    }
  }
);

// =========================================================
// CODO WEBHOOK
// =========================================================

app.post('/api/codo-bills/webhook', async (req, res) => {
  try {
    const secretHash = process.env.FLW_SECRET_HASH;
    const signature = req.headers['verif-hash'];

    if (secretHash && signature !== secretHash) {
      return res.status(401).end();
    }

    const payload = req.body || {};
    const txRef = payload?.data?.tx_ref;

    if (!txRef || !String(txRef).startsWith('codo_')) {
      return res.status(200).json({
        status: 'ignored'
      });
    }

    const transactionId = payload?.data?.id;

    if (!transactionId) {
      return res.status(400).json({
        error: 'Invalid webhook payload.'
      });
    }

    const paymentRef = db.collection('codoTransactions').doc(txRef);
    const paymentSnapshot = await paymentRef.get();

    if (!paymentSnapshot.exists) {
      return res.status(200).json({
        status: 'ignored'
      });
    }

    const payment = paymentSnapshot.data();

    if (payment.status === 'successful') {
      return res.status(200).json({
        status: 'already_processed'
      });
    }

    const flutterwaveResponse = await fetch(
      `https://api.flutterwave.com/v3/transactions/${transactionId}/verify`,
      {
        headers: {
          Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`
        }
      }
    );

    const flutterwaveData = await flutterwaveResponse.json();

    const isValid =
      flutterwaveData?.status === 'success' &&
      flutterwaveData?.data?.status === 'successful' &&
      flutterwaveData?.data?.tx_ref === txRef &&
      Number(flutterwaveData?.data?.amount) === Number(payment.amount) &&
      String(flutterwaveData?.data?.currency).toUpperCase() === payment.currency;

    if (!isValid) {
      await paymentRef.update({
        status: 'webhook_verification_failed',
        updatedAt: serverTimestamp()
      });

      return res.status(400).json({
        error: 'Payment verification failed.'
      });
    }

    await db.runTransaction(async transaction => {
      const freshPayment = await transaction.get(paymentRef);
      const paymentData = freshPayment.data();

      if (paymentData.status === 'successful') {
        return;
      }

      const walletRef = db.collection('codoWallets').doc(payment.uid);
      const walletSnapshot = await transaction.get(walletRef);

      const currentPurchased = walletSnapshot.exists
        ? Number(walletSnapshot.data().purchasedBills || 0)
        : 0;

      transaction.set(walletRef, {
        uid: payment.uid,
        purchasedBills: currentPurchased + Number(payment.bundle),
        updatedAt: serverTimestamp()
      }, { merge: true });

      transaction.update(paymentRef, {
        status: 'successful',
        flutterwaveTransactionId: String(transactionId),
        completedAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
    });

    return res.status(200).json({
      status: 'success'
    });
  } catch (error) {
    console.error('Codo webhook error:', error);

    return res.status(500).json({
      error: 'Internal server error.'
    });
  }
});
// =========================================================
// 404 AND ERRORS
// =========================================================

app.use((req, res) => {
  res.status(404).json({
    error: 'Route not found.'
  });
});

app.use((error, req, res, next) => {
  console.error('Unexpected server error:', error);

  if (res.headersSent) {
    return next(error);
  }

  return res.status(500).json({
    error: 'Internal server error.'
  });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Doflownovels backend running on port ${PORT}`);
});