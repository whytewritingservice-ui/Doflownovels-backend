'use strict';

require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const admin = require('firebase-admin');

const app = express();
const PORT = Number(process.env.PORT || 10000);

// Trust Render / reverse proxy for accurate client IP & rate limiting
app.set('trust proxy', 1);

// ---------------------------------------------------------------------------
// Firebase Admin Initialization
// ---------------------------------------------------------------------------
function initFirebaseAdmin() {
  if (admin.apps.length > 0) {
    return admin.app();
  }

  const rawServiceAccount =
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON ||
    process.env.FIREBASE_SERVICE_ACCOUNT ||
    '';

  if (rawServiceAccount.trim()) {
    const parsed = JSON.parse(rawServiceAccount);
    if (parsed.private_key && typeof parsed.private_key === 'string') {
      parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
    }
    admin.initializeApp({
      credential: admin.credential.cert(parsed),
      projectId: process.env.FIREBASE_PROJECT_ID || parsed.project_id || 'doflownovels',
    });
    return admin.app();
  }

  const projectId = process.env.FIREBASE_PROJECT_ID || 'doflownovels';
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL || '';
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

  if (clientEmail && privateKey) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId,
        clientEmail,
        privateKey,
      }),
      projectId,
    });
    return admin.app();
  }

  // Fallback to Application Default Credentials if present in environment
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    projectId,
  });
  return admin.app();
}

let firebaseReady = false;
let db = null;

try {
  initFirebaseAdmin();
  db = admin.firestore();
  firebaseReady = true;
} catch (err) {
  console.error('[BOOT] Firebase Admin initialization warning:', err.message);
}

// ---------------------------------------------------------------------------
// Configuration & Allowed Origins
// ---------------------------------------------------------------------------
const ADMIN_EMAIL = String(
  process.env.ADMIN_EMAIL || 'whytewritingservice@gmail.com'
)
  .trim()
  .toLowerCase();

const FLW_SECRET_KEY = String(process.env.FLW_SECRET_KEY || '').trim();
const FLW_SECRET_HASH = String(process.env.FLW_SECRET_HASH || '').trim();
const FLW_VERIFY_BASE_URL = String(
  process.env.FLW_VERIFY_BASE_URL || 'https://api.flutterwave.com/v3'
).replace(/\/+$/, '');

const DEFAULT_ALLOWED_ORIGINS = [
  'https://doflownovels.netlify.app',
  'https://doflownovels.firebaseapp.com',
  'http://localhost:3000',
  'http://localhost:5173',
  'http://127.0.0.1:5500',
];

const extraOrigins = String(process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const allowedOrigins = new Set([...DEFAULT_ALLOWED_ORIGINS, ...extraOrigins]);

function logEvent(level, event, details = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    ...details,
  };
  if (level === 'error') {
    console.error(JSON.stringify(entry));
  } else {
    console.log(JSON.stringify(entry));
  }
}

// ---------------------------------------------------------------------------
// Security, CORS, Rate Limiting & Body Parsing
// ---------------------------------------------------------------------------
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
);

app.use(
  cors({
    origin(origin, callback) {
      // Allow server-to-server / webhook / health probes with no Origin header
      if (!origin) return callback(null, true);
      if (allowedOrigins.has(origin)) {
        return callback(null, true);
      }
      logEvent('warn', 'cors_blocked', { origin });
      return callback(new Error('Origin not allowed by CORS policy'), false);
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'verif-hash'],
    credentials: true,
    maxAge: 86400,
  })
);

const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.RATE_LIMIT_MAX_PER_MIN || 120),
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many requests. Please slow down.' },
});

const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.WEBHOOK_RATE_LIMIT_MAX_PER_MIN || 180),
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Webhook rate limit exceeded.' },
});

const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.ADMIN_RATE_LIMIT_MAX_PER_MIN || 60),
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Admin rate limit exceeded.' },
});

app.use(globalLimiter);

// Capture rawBody for webhook signature checks while parsing JSON with bounded limit
app.use(
  express.json({
    limit: process.env.JSON_BODY_LIMIT || '256kb',
    verify(req, _res, buf) {
      req.rawBody = buf;
    },
  })
);
// ---------------------------------------------------------------------------
// Helper Functions: Auth, Signature Verification & Flutterwave API Check
// ---------------------------------------------------------------------------
function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function verifyWebhookSignature(req) {
  // Flutterwave webhooks commonly send `verif-hash` matching FLW_SECRET_HASH
  const verifHash = String(req.headers['verif-hash'] || '').trim();
  if (FLW_SECRET_HASH) {
    return timingSafeEqualStr(verifHash, FLW_SECRET_HASH);
  }
  // Optional fallback if HMAC-SHA256 signature is configured
  const hmacSecret = String(process.env.FLW_WEBHOOK_HMAC_SECRET || '').trim();
  const sigHeader = String(req.headers['x-flw-signature'] || '').trim();
  if (hmacSecret && sigHeader && req.rawBody) {
    const expected = crypto
      .createHmac('sha256', hmacSecret)
      .update(req.rawBody)
      .digest('hex');
    return timingSafeEqualStr(sigHeader, expected);
  }
  return false;
}

async function fetchVerifiedFlutterwaveTransaction(transactionId) {
  if (!FLW_SECRET_KEY) {
    throw new Error('FLW_SECRET_KEY is not configured on server');
  }
  const safeId = encodeURIComponent(String(transactionId).trim());
  const url = `${FLW_VERIFY_BASE_URL}/transactions/${safeId}/verify`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${FLW_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Flutterwave verify HTTP ${response.status}`);
    }

    const payload = await response.json();
    if (payload.status !== 'success' || !payload.data) {
      throw new Error('Flutterwave verification returned unsuccessful status');
    }
    return payload.data;
  } finally {
    clearTimeout(timeout);
  }
}

async function requireVerifiedAdmin(req, res, next) {
  try {
    if (!firebaseReady || !db) {
      return res.status(503).json({ ok: false, error: 'Database unavailable' });
    }

    const authHeader = String(req.headers.authorization || '');
    if (!authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ ok: false, error: 'Missing bearer token' });
    }

    const idToken = authHeader.slice('Bearer '.length).trim();
    if (!idToken) {
      return res.status(401).json({ ok: false, error: 'Empty bearer token' });
    }

    const decoded = await admin.auth().verifyIdToken(idToken, true);
    const email = String(decoded.email || '').trim().toLowerCase();
    const emailVerified = Boolean(decoded.email_verified);
    const isAdminClaim = decoded.admin === true || decoded.role === 'admin';

    const userDocSnap = await db.collection('users').doc(decoded.uid).get();
    const userDoc = userDocSnap.exists ? userDocSnap.data() : {};
    const docRole = String(userDoc.role || '').toLowerCase();

    const authorizedOwnerEmail = email === ADMIN_EMAIL && emailVerified;
    const authorizedRecord =
      (docRole === 'admin' || isAdminClaim) &&
      (!ADMIN_EMAIL || email === ADMIN_EMAIL || isAdminClaim);

    if (!authorizedOwnerEmail && !authorizedRecord) {
      logEvent('warn', 'admin_auth_denied', {
        uid: decoded.uid,
        emailPresent: Boolean(email),
      });
      return res.status(403).json({ ok: false, error: 'Admin privileges required' });
    }

    req.adminUser = {
      uid: decoded.uid,
      email,
    };
    return next();
  } catch (err) {
    logEvent('warn', 'admin_token_invalid', { message: err.message });
    return res.status(401).json({ ok: false, error: 'Invalid or expired auth token' });
  }
}

function normalizeUnlockType(rawType, meta = {}) {
  const val = String(rawType || meta.unlock_type || meta.product_type || '')
    .trim()
    .toLowerCase();

  if (['author_unlock', 'author_account', 'author', 'unlock_author'].includes(val)) {
    return 'author_unlock';
  }
  if (['codo_topup', 'codo', 'codo_package', 'wallet_credit'].includes(val)) {
    return 'codo_topup';
  }
  if (['chapter_unlock', 'chapters', 'book_chapters', 'chapter_bundle'].includes(val)) {
    return 'chapter_unlock';
  }
  if (['beta_access', 'beta_reader', 'beta'].includes(val)) {
    return 'beta_access';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Routes: Health & Webhook Unlock
// ---------------------------------------------------------------------------
app.get('/health', (_req, res) => {
  res.status(200).json({
    ok: true,
    service: 'doflownovels-backend',
    firebaseReady,
    timestamp: new Date().toISOString(),
  });
});

/**
 * POST /api/doflow-unlock
 * Handles Flutterwave webhook notifications, verifies signature & transaction
 * server-side, checks idempotency, and applies entitlement in a Firestore tx.
 */
app.post('/api/doflow-unlock', webhookLimiter, async (req, res) => {
  try {
    if (!firebaseReady || !db) {
      return res.status(503).json({ ok: false, error: 'Database not initialized' });
    }

    if (!verifyWebhookSignature(req)) {
      logEvent('warn', 'webhook_signature_invalid', {
        ip: req.ip,
      });
      return res.status(401).json({ ok: false, error: 'Invalid webhook signature' });
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const eventName = String(body.event || '').trim();
    const eventData = body.data && typeof body.data === 'object' ? body.data : body;

    if (eventName && eventName !== 'charge.completed') {
      logEvent('info', 'webhook_ignored_event', { event: eventName });
      return res.status(200).json({ ok: true, ignored: true, event: eventName });
    }

    const txId = eventData.id || eventData.transaction_id;
    const txRef = String(eventData.tx_ref || eventData.reference || '').trim();

    if (!txId || !txRef) {
      return res.status(400).json({
        ok: false,
        error: 'Missing transaction id or tx_ref',
      });
    }

    // Always verify authoritative payment state directly with Flutterwave API
    const verifiedTx = await fetchVerifiedFlutterwaveTransaction(txId);

    const verifiedStatus = String(verifiedTx.status || '').toLowerCase();
    const verifiedRef = String(verifiedTx.tx_ref || '').trim();
    const verifiedCurrency = String(verifiedTx.currency || '').toUpperCase();
    const verifiedAmount = Number(verifiedTx.amount);

    if (verifiedStatus !== 'successful' || verifiedRef !== txRef) {
      logEvent('warn', 'webhook_tx_verification_failed', {
        txId: String(txId),
        txRef,
        verifiedStatus,
      });
      return res.status(400).json({
        ok: false,
        error: 'Transaction not successful or reference mismatch',
      });
    }

    if (!Number.isFinite(verifiedAmount) || verifiedAmount <= 0) {
      return res.status(400).json({ ok: false, error: 'Invalid verified amount' });
    }

    const meta =
      verifiedTx.meta && typeof verifiedTx.meta === 'object'
        ? verifiedTx.meta
        : eventData.meta && typeof eventData.meta === 'object'
          ? eventData.meta
          : {};

    const purchaserUid = String(meta.uid || meta.userId || '').trim();
    const purchaserEmail = String(
      (verifiedTx.customer && verifiedTx.customer.email) || meta.email || ''
    )
      .trim()
      .toLowerCase();

    const unlockType = normalizeUnlockType(meta.unlock_type || meta.product_type, meta);
    if (!unlockType) {
      logEvent('warn', 'webhook_unknown_unlock_type', { txRef, meta });
      return res.status(400).json({ ok: false, error: 'Unrecognized unlock product type' });
    }

    // Server-side package/product validation (never trust client-claimed credit counts)
    let codoCredit = 0;
    const bookId = String(meta.bookId || meta.book_id || '').trim() || null;
    const assignmentId =
      String(meta.assignmentId || meta.assignment_id || '').trim() || null;
    const chapterIds = Array.isArray(meta.chapterIds)
      ? meta.chapterIds.map((c) => String(c).trim()).filter(Boolean).slice(0, 5)
      : [];

    if (unlockType === 'codo_topup') {
      // Confirmed regional baseline packages: NGN 300 -> 85 CODO, USD 2 -> 85 CODO
      if (verifiedCurrency === 'NGN' && Math.abs(verifiedAmount - 300) < 0.01) {
        codoCredit = 85;
      } else if (verifiedCurrency === 'USD' && Math.abs(verifiedAmount - 2) < 0.01) {
        codoCredit = 85;
      } else {
        logEvent('warn', 'codo_package_unmatched', {
          txRef,
          verifiedCurrency,
          verifiedAmount,
        });
        return res.status(400).json({
          ok: false,
          error: 'Amount and currency do not match an approved CODO package',
        });
      }
    }

    if (unlockType === 'chapter_unlock' && (!bookId || chapterIds.length === 0)) {
      return res.status(400).json({
        ok: false,
        error: 'Chapter unlock requires bookId and up to 5 chapterIds',
      });
    }

    if (unlockType === 'beta_access' && !assignmentId) {
      return res.status(400).json({
        ok: false,
        error: 'Beta access unlock requires assignmentId',
      });
    }

    const paymentDocId = `flw_${String(txId)}`;
    const paymentRef = db.collection('payments').doc(paymentDocId);

    const txResult = await db.runTransaction(async (t) => {
      const existingPayment = await t.get(paymentRef);
      if (existingPayment.exists) {
        return { duplicate: true, docId: paymentDocId };
      }

      // Resolve target user document (by UID or verified customer email)
      let userRef = null;
      if (purchaserUid) {
        userRef = db.collection('users').doc(purchaserUid);
      } else if (purchaserEmail) {
        const snap = await t.get(
          db.collection('users').where('emailLower', '==', purchaserEmail).limit(1)
        );
        if (!snap.empty) {
          userRef = snap.docs[0].ref;
        }
      }

      if (!userRef) {
        throw new Error('PURCHASER_NOT_FOUND');
      }

      const userSnap = await t.get(userRef);
      if (!userSnap.exists) {
        throw new Error('PURCHASER_NOT_FOUND');
      }

      const userData = userSnap.data() || {};
      const resolvedUid = userRef.id;
      const currentCodo = Number(userData.codoBalance || 0);

      const userUpdates = {
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      if (unlockType === 'author_unlock') {
        userUpdates.authorUnlocked = true;
        userUpdates.authorUnlockedAt = admin.firestore.FieldValue.serverTimestamp();
        userUpdates.role = userData.role === 'admin' ? 'admin' : 'author';
      } else if (unlockType === 'codo_topup') {
        userUpdates.codoBalance = currentCodo + codoCredit;
      } else if (unlockType === 'chapter_unlock') {
        const entitlementId = `${resolvedUid}_${bookId}`;
        const entRef = db.collection('entitlements').doc(entitlementId);
        t.set(
          entRef,
          {
            uid: resolvedUid,
            bookId,
            chapterIds: admin.firestore.FieldValue.arrayUnion(...chapterIds),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      } else if (unlockType === 'beta_access') {
        const betaEntRef = db
          .collection('entitlements')
          .doc(`${resolvedUid}_beta_${assignmentId}`);
        t.set(
          betaEntRef,
          {
            uid: resolvedUid,
            assignmentId,
            betaAccessGranted: true,
            grantedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      }

      t.set(userRef, userUpdates, { merge: true });

      t.set(paymentRef, {
        provider: 'flutterwave',
        transactionId: String(txId),
        txRef,
        flwRef: String(verifiedTx.flw_ref || ''),
        status: 'completed',
        unlockType,
        uid: resolvedUid,
        amount: verifiedAmount,
        currency: verifiedCurrency,
        codoCredited: codoCredit,
        bookId,
        chapterIds,
        assignmentId,
        verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      const ledgerRef = db.collection('wallet_ledger').doc(`led_${paymentDocId}`);
      t.set(ledgerRef, {
        uid: resolvedUid,
        entryType: unlockType,
        direction: codoCredit > 0 ? 'credit' : 'entitlement',
        codoDelta: codoCredit,
        amount: verifiedAmount,
        currency: verifiedCurrency,
        txRef,
        paymentId: paymentDocId,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      return {
        duplicate: false,
        docId: paymentDocId,
        uid: resolvedUid,
        unlockType,
        codoCredited: codoCredit,
      };
    });

    if (txResult.duplicate) {
      logEvent('info', 'webhook_duplicate_ignored', { txRef, docId: txResult.docId });
      return res.status(200).json({
        ok: true,
        duplicate: true,
        paymentId: txResult.docId,
      });
    }

    logEvent('info', 'unlock_applied', {
      paymentId: txResult.docId,
      uid: txResult.uid,
      unlockType: txResult.unlockType,
      codoCredited: txResult.codoCredited,
    });

    return res.status(200).json({
      ok: true,
      duplicate: false,
      paymentId: txResult.docId,
      unlockType: txResult.unlockType,
    });
  } catch (err) {
    if (err.message === 'PURCHASER_NOT_FOUND') {
      return res.status(404).json({ ok: false, error: 'Purchaser account not found' });
    }
    logEvent('error', 'doflow_unlock_error', { message: err.message });
    return res.status(500).json({ ok: false, error: 'Failed to process unlock' });
  }
});
/**
 * POST /api/admin/unlock
 * Requires verified Firebase ID token and server-side owner/admin authorization.
 * Supports explicit, audited unlock operations on a validated targetUid.
 */
app.post('/api/admin/unlock', adminLimiter, requireVerifiedAdmin, async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const targetUid = String(body.targetUid || '').trim();
    const operation = String(body.operation || '').trim();
    const reason = String(body.reason || '').trim();

    if (!targetUid || !/^[A-Za-z0-9_-]{6,128}$/.test(targetUid)) {
      return res.status(400).json({ ok: false, error: 'Valid targetUid is required' });
    }

    const allowedOperations = new Set([
      'grant_author_unlock',
      'revoke_author_unlock',
      'credit_codo',
      'grant_beta_access',
    ]);

    if (!allowedOperations.has(operation)) {
      return res.status(400).json({
        ok: false,
        error: 'Unsupported admin unlock operation',
      });
    }

    let codoDelta = 0;
    if (operation === 'credit_codo') {
      codoDelta = Number(body.codoAmount);
      if (!Number.isInteger(codoDelta) || codoDelta <= 0 || codoDelta > 100000) {
        return res.status(400).json({
          ok: false,
          error: 'credit_codo requires a positive integer codoAmount (max 100000)',
        });
      }
    }

    const assignmentId = String(body.assignmentId || '').trim();
    if (operation === 'grant_beta_access' && !assignmentId) {
      return res.status(400).json({
        ok: false,
        error: 'grant_beta_access requires assignmentId',
      });
    }

    const targetUserRef = db.collection('users').doc(targetUid);
    const auditRef = db.collection('audit_logs').doc();

    const result = await db.runTransaction(async (t) => {
      const targetSnap = await t.get(targetUserRef);
      if (!targetSnap.exists) {
        throw new Error('TARGET_USER_NOT_FOUND');
      }

      const targetData = targetSnap.data() || {};
      const updates = {
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      if (operation === 'grant_author_unlock') {
        updates.authorUnlocked = true;
        updates.authorUnlockedAt = admin.firestore.FieldValue.serverTimestamp();
        if (targetData.role !== 'admin') {
          updates.role = 'author';
        }
      } else if (operation === 'revoke_author_unlock') {
        updates.authorUnlocked = false;
      } else if (operation === 'credit_codo') {
        const currentBalance = Number(targetData.codoBalance || 0);
        updates.codoBalance = currentBalance + codoDelta;
      } else if (operation === 'grant_beta_access') {
        const betaEntRef = db
          .collection('entitlements')
          .doc(`${targetUid}_beta_${assignmentId}`);
        t.set(
          betaEntRef,
          {
            uid: targetUid,
            assignmentId,
            betaAccessGranted: true,
            grantedByAdminUid: req.adminUser.uid,
            grantedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      }

      t.set(targetUserRef, updates, { merge: true });

      if (operation === 'credit_codo') {
        const ledgerRef = db.collection('wallet_ledger').doc();
        t.set(ledgerRef, {
          uid: targetUid,
          entryType: 'admin_codo_credit',
          direction: 'credit',
          codoDelta,
          reason: reason || 'admin_unlock',
          adminUid: req.adminUser.uid,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }

      t.set(auditRef, {
        actorUid: req.adminUser.uid,
        actorEmail: req.adminUser.email,
        targetUid,
        operation,
        codoDelta: codoDelta || null,
        assignmentId: assignmentId || null,
        reason: reason || null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      return {
        targetUid,
        operation,
        codoDelta,
        auditId: auditRef.id,
      };
    });

    logEvent('info', 'admin_unlock_executed', {
      auditId: result.auditId,
      adminUid: req.adminUser.uid,
      targetUid: result.targetUid,
      operation: result.operation,
    });

    return res.status(200).json({
      ok: true,
      ...result,
    });
  } catch (err) {
    if (err.message === 'TARGET_USER_NOT_FOUND') {
      return res.status(404).json({ ok: false, error: 'Target user not found' });
    }
    logEvent('error', 'admin_unlock_error', { message: err.message });
    return res.status(500).json({ ok: false, error: 'Admin unlock operation failed' });
  }
});

// ---------------------------------------------------------------------------
// 404 & Global Error Handler
// ---------------------------------------------------------------------------
app.use((_req, res) => {
  res.status(404).json({ ok: false, error: 'Route not found' });
});

app.use((err, _req, res, _next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ ok: false, error: 'Invalid JSON payload' });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ ok: false, error: 'Request payload too large' });
  }
  if (err && err.message === 'Origin not allowed by CORS policy') {
    return res.status(403).json({ ok: false, error: err.message });
  }
  logEvent('error', 'unhandled_server_error', {
    message: err ? err.message : 'Unknown error',
  });
  return res.status(500).json({ ok: false, error: 'Internal server error' });
});

// ---------------------------------------------------------------------------
// Start Server
// ---------------------------------------------------------------------------
app.listen(PORT, '0.0.0.0', () => {
  logEvent('info', 'server_started', {
    port: PORT,
    firebaseReady,
    adminEmailConfigured: Boolean(ADMIN_EMAIL),
  });
});