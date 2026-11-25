

'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const admin = require('firebase-admin');

const app = express();
const PORT = Number(process.env.PORT || 10000);

app.set('trust proxy', 1);

app.use(cors({
  origin: true,
  methods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'verif-hash'],
  credentials: false
}));

// Keep the raw request body available for Flutterwave signature checks.
app.use('/api/flutterwave/webhook', express.raw({ type: '*/*' }));

// Normal JSON parsing for every other route.
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

function getFirebaseCredentials() {
  if (process.env.FIREBASE_ADMIN_JSON) {
    return JSON.parse(process.env.FIREBASE_ADMIN_JSON);
  }

  if (
    process.env.FIREBASE_PROJECT_ID &&
    process.env.FIREBASE_CLIENT_EMAIL &&
    process.env.FIREBASE_PRIVATE_KEY
  ) {
    return {
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
    };
  }

  return null;
}

const firebaseCredentials = getFirebaseCredentials();

if (!admin.apps.length) {
  if (firebaseCredentials) {
    admin.initializeApp({
      credential: admin.credential.cert(firebaseCredentials)
    });
  } else {
    console.warn('Firebase Admin credentials are not configured.');
  }
}

const db = admin.apps.length ? admin.firestore() : null;

function requireDb(res) {
  if (!db) {
    res.status(503).json({
      ok: false,
      error: 'Firebase Admin is not configured on the server.'
    });
    return false;
  }
  return true;
}

function sendError(res, status, message, details) {
  return res.status(status).json({
    ok: false,
    error: message,
    ...(details ? { details } : {})
  });
}

function safeJsonBody(req) {
  if (Buffer.isBuffer(req.body)) {
    try {
      return JSON.parse(req.body.toString('utf8'));
    } catch (_) {
      return null;
    }
  }
  return req.body || null;
}

function timingSafeEqualText(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'doflow-novels-backend',
    firebase: Boolean(db),
    timestamp: new Date().toISOString()
  });
});

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    message: 'Doflow Novels backend is running.'
  });
});

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const admin = require('firebase-admin');

const app = express();
const PORT = Number(process.env.PORT || 10000);

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error('Origin not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json({ limit: '1mb' }));

app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    ok: false,
    error: 'Too many requests. Please try again later.',
  },
}));

function getFirebaseCredential() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;

  if (!raw) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT is not configured');
  }

  let serviceAccount;

  try {
    serviceAccount = JSON.parse(raw);
  } catch (_error) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT must be valid JSON');
  }

  return admin.credential.cert(serviceAccount);
}

function initializeFirebase() {
  if (admin.apps.length > 0) {
    return admin.app();
  }

  return admin.initializeApp({
    credential: getFirebaseCredential(),
  });
}

let firebaseReady = false;
let db = null;

try {
  initializeFirebase();
  db = admin.firestore();
  firebaseReady = true;
} catch (_error) {
  firebaseReady = false;
}

function requireFirebase(_req, res, next) {
  if (!firebaseReady || !db) {
    return res.status(503).json({
      ok: false,
      error: 'Firebase is not configured on the server.',
    });
  }

  return next();
}

function getBearerToken(req) {
  const header = req.headers.authorization || '';

  if (!header.startsWith('Bearer ')) {
    return null;
  }

  return header.slice('Bearer '.length).trim() || null;
}

async function requireUser(req, res, next) {
  const token = getBearerToken(req);

  if (!token) {
    return res.status(401).json({
      ok: false,
      error: 'Missing Firebase ID token.',
    });
  }

  try {
    req.user = await admin.auth().verifyIdToken(token);
    return next();
  } catch (_error) {
    return res.status(401).json({
      ok: false,
      error: 'Invalid or expired Firebase ID token.',
    });
  }
}

function timingSafeEqualText(left, right) {
  const leftBuffer = Buffer.from(String(left || ''));
  const rightBuffer = Buffer.from(String(right || ''));

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function verifyFlutterwaveSignature(rawBody, signature) {
  const secretHash = process.env.FLW_WEBHOOK_HASH;

  if (!secretHash || !signature) {
    return false;
  }

  const expected = crypto
    .createHmac('sha256', secretHash)
    .update(rawBody)
    .digest('hex');

  return timingSafeEqualText(expected, signature);
}

function toPositiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function toNonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function codoFromAmount(amount, currency) {
  const normalizedCurrency = String(currency || 'NGN').toUpperCase();
  const numericAmount = toPositiveNumber(amount);

  if (!numericAmount) {
    return 0;
  }

  if (normalizedCurrency === 'USD') {
    return Math.floor((numericAmount / 2) * 85);
  }

  return Math.floor((numericAmount / 300) * 85);
}

function walletRef(uid) {
  return db.collection('wallets').doc(uid);
}

function transactionRef(transactionId) {
  return db.collection('walletTransactions').doc(String(transactionId));
}
function getFlutterwaveSignature(req) {
  return req.headers['verif-hash'] || req.headers['verif_hash'] || '';
}

function isValidFlutterwaveWebhook(req) {
  const expected = process.env.FLW_WEBHOOK_HASH || '';
  const received = getFlutterwaveSignature(req);

  if (!expected || !received) return false;

  const expectedBuffer = Buffer.from(expected, 'utf8');
  const receivedBuffer = Buffer.from(String(received), 'utf8');

  if (expectedBuffer.length !== receivedBuffer.length) return false;

  return crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

function getWebhookReference(payload) {
  return String(
    payload?.data?.tx_ref ||
    payload?.data?.flw_ref ||
    payload?.data?.id ||
    payload?.tx_ref ||
    ''
  ).trim();
}

function getWebhookUserId(payload) {
  return String(
    payload?.meta?.userId ||
    payload?.data?.meta?.userId ||
    payload?.data?.customer?.userId ||
    ''
  ).trim();
}

function getWebhookAmount(payload) {
  const amount = Number(payload?.data?.amount ?? payload?.amount ?? 0);
  return Number.isFinite(amount) ? amount : 0;
}

function getWebhookCurrency(payload) {
  return String(payload?.data?.currency || payload?.currency || 'NGN').toUpperCase();
}

function codoFor(amount, currency) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) return 0;

  if (currency === 'USD') {
    return Math.floor((value / 2) * 85);
  }

  return Math.floor((value / 300) * 85);
}

app.post('/api/flutterwave/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!isValidFlutterwaveWebhook(req)) {
    return res.status(401).json({ ok: false, error: 'Invalid webhook signature.' });
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '{}');
  } catch (_error) {
    return res.status(400).json({ ok: false, error: 'Invalid JSON payload.' });
  }

  const status = String(payload?.data?.status || payload?.status || '').toLowerCase();
  const reference = getWebhookReference(payload);
  const userId = getWebhookUserId(payload);
  const amount = getWebhookAmount(payload);
  const currency = getWebhookCurrency(payload);
  const codo = codoFor(amount, currency);

  if (status !== 'successful' || !reference || !userId || codo <= 0) {
    return res.status(200).json({ ok: true, ignored: true });
  }

  try {
    const paymentRef = db.collection('payments').doc(reference);
    const walletRef = db.collection('wallets').doc(userId);

    await db.runTransaction(async (transaction) => {
      const paymentSnap = await transaction.get(paymentRef);

      if (paymentSnap.exists && paymentSnap.data()?.credited === true) {
        return;
      }

      const walletSnap = await transaction.get(walletRef);
      const currentBalance = Number(walletSnap.exists ? walletSnap.data()?.codoBalance : 0) || 0;
      const nextBalance = currentBalance + codo;

      transaction.set(paymentRef, {
        reference,
        userId,
        amount,
        currency,
        codo,
        status: 'successful',
        credited: true,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      transaction.set(walletRef, {
        userId,
        codoBalance: nextBalance,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      transaction.create(db.collection('walletTransactions').doc(), {
        userId,
        type: 'credit',
        source: 'flutterwave',
        reference,
        amount,
        currency,
        codo,
        balanceAfter: nextBalance,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    return res.status(200).json({ ok: true, credited: true, reference });
  } catch (error) {
    console.error('Webhook processing failed:', error.message);
    return res.status(500).json({ ok: false, error: 'Webhook processing failed.' });
  }
});
const payoutRequestSchema = {
  amount: 0,
  currency: 'NGN',
  status: 'pending',
  userId: '',
  createdAt: null,
  updatedAt: null,
  rejectionReason: null
};

app.post('/api/payouts/request', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const amount = Number(req.body.amount);
    const currency = String(req.body.currency || 'NGN').toUpperCase();

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ ok: false, error: 'A valid payout amount is required.' });
    }

    const userRef = db.collection('users').doc(userId);
    const payoutRef = db.collection('payouts').doc();
    const now = admin.firestore.Timestamp.now();

    await db.runTransaction(async (tx) => {
      const userSnap = await tx.get(userRef);
      if (!userSnap.exists) throw new Error('USER_NOT_FOUND');

      const user = userSnap.data() || {};
      const balance = Number(user.balance || 0);
      if (balance < amount) throw new Error('INSUFFICIENT_BALANCE');

      tx.update(userRef, {
        balance: admin.firestore.FieldValue.increment(-amount),
        updatedAt: now
      });

      tx.set(payoutRef, {
        ...payoutRequestSchema,
        userId,
        amount,
        currency,
        status: 'pending',
        createdAt: now,
        updatedAt: now
      });
    });

    return res.status(201).json({
      ok: true,
      payoutId: payoutRef.id,
      status: 'pending'
    });
  } catch (error) {
    if (error.message === 'USER_NOT_FOUND') {
      return res.status(404).json({ ok: false, error: 'User account not found.' });
    }
    if (error.message === 'INSUFFICIENT_BALANCE') {
      return res.status(400).json({ ok: false, error: 'Insufficient balance.' });
    }
    console.error('Payout request error:', error);
    return res.status(500).json({ ok: false, error: 'Could not create payout request.' });
  }
});

app.post('/api/admin/payouts/:payoutId/approve', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const payoutRef = db.collection('payouts').doc(req.params.payoutId);
    const now = admin.firestore.Timestamp.now();
    let payout;

    await db.runTransaction(async (tx) => {
      const payoutSnap = await tx.get(payoutRef);
      if (!payoutSnap.exists) throw new Error('PAYOUT_NOT_FOUND');

      payout = payoutSnap.data();
      if (payout.status !== 'pending') throw new Error('PAYOUT_ALREADY_PROCESSED');

      tx.update(payoutRef, {
        status: 'approved',
        approvedBy: req.user.uid,
        approvedAt: now,
        updatedAt: now
      });
    });

    return res.json({ ok: true, payoutId: req.params.payoutId, status: 'approved' });
  } catch (error) {
    if (error.message === 'PAYOUT_NOT_FOUND') {
      return res.status(404).json({ ok: false, error: 'Payout request not found.' });
    }
    if (error.message === 'PAYOUT_ALREADY_PROCESSED') {
      return res.status(409).json({ ok: false, error: 'Payout has already been processed.' });
    }
    console.error('Payout approval error:', error);
    return res.status(500).json({ ok: false, error: 'Could not approve payout.' });
  }
});

app.post('/api/admin/payouts/:payoutId/reject', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const payoutRef = db.collection('payouts').doc(req.params.payoutId);
    const now = admin.firestore.Timestamp.now();
    let payout;

    await db.runTransaction(async (tx) => {
      const payoutSnap = await tx.get(payoutRef);
      if (!payoutSnap.exists) throw new Error('PAYOUT_NOT_FOUND');

      payout = payoutSnap.data();
      if (payout.status !== 'pending') throw new Error('PAYOUT_ALREADY_PROCESSED');

      const reason = String(req.body.reason || 'Payout rejected.').trim();
      const userRef = db.collection('users').doc(payout.userId);

      tx.update(userRef, {
        balance: admin.firestore.FieldValue.increment(Number(payout.amount)),
        updatedAt: now
      });

      tx.update(payoutRef, {
        status: 'rejected',
        rejectionReason: reason,
        rejectedBy: req.user.uid,
        rejectedAt: now,
        updatedAt: now,
        balanceRestored: true
      });
    });

    return res.json({
      ok: true,
      payoutId: req.params.payoutId,
      status: 'rejected',
      balanceRestored: true
    });
  } catch (error) {
    if (error.message === 'PAYOUT_NOT_FOUND') {
      return res.status(404).json({ ok: false, error: 'Payout request not found.' });
    }
    if (error.message === 'PAYOUT_ALREADY_PROCESSED') {
      return res.status(409).json({ ok: false, error: 'Payout has already been processed.' });
    }
    console.error('Payout rejection error:', error);
    return res.status(500).json({ ok: false, error: 'Could not reject payout.' });
  }
});

const manuscriptImportSchema = {
  bookId: '',
  title: '',
  authorId: '',
  status: 'draft',
  chapterCount: 0,
  totalWordCount: 0,
  createdAt: null,
  updatedAt: null
};

function normalizeText(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function countWords(text) {
  const normalized = normalizeText(text);
  return normalized ? normalized.split(/\s+/).length : 0;
}

function parseChapterHeading(line) {
  const value = String(line || '').trim();
  if (!value) return null;

  const match = value.match(
    /^(?:chapter|chap\.?|part)\s+([0-9]+|[ivxlcdm]+)(?:\s*[-:.)]\s*|\s+)(.*)$/i
  );

  if (!match) return null;

  return {
    numberLabel: match[1],
    title: (match[2] || '').trim()
  };
}

function parseManuscriptChapters(rawText) {
  const lines = normalizeText(rawText).split('\n');
  const chapters = [];
  let current = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const heading = parseChapterHeading(line);

    if (heading) {
      if (current) {
        current.content = normalizeText(current.contentLines.join('\n'));
        current.wordCount = countWords(current.content);
        delete current.contentLines;
        chapters.push(current);
      }

      current = {
        numberLabel: heading.numberLabel,
        title: heading.title || `Chapter ${heading.numberLabel}`,
        contentLines: []
      };
      continue;
    }

    if (current) current.contentLines.push(rawLine);
  }

  if (current) {
    current.content = normalizeText(current.contentLines.join('\n'));
    current.wordCount = countWords(current.content);
    delete current.contentLines;
    chapters.push(current);
  }

  if (!chapters.length) {
    throw new Error(
      'No chapter headings found. Use headings such as "Chapter 1: Title".'
    );
  }

  return chapters.map((chapter, index) => ({
    chapterNumber: index + 1,
    numberLabel: chapter.numberLabel,
    title: chapter.title,
    content: chapter.content,
    wordCount: chapter.wordCount,
    atmosphereMode: null,
    isLocked: index >= 5
  }));
}

async function importManuscript({ bookId, title, authorId, rawText }) {
  if (!bookId || !authorId || !rawText) {
    throw new Error('bookId, authorId, and rawText are required.');
  }

  const chapters = parseManuscriptChapters(rawText);
  const now = admin.firestore.FieldValue.serverTimestamp();
  const bookRef = db.collection('books').doc(bookId);
  const batch = db.batch();

  batch.set(bookRef, {
    ...manuscriptImportSchema,
    bookId,
    title: title || 'Untitled manuscript',
    authorId,
    chapterCount: chapters.length,
    totalWordCount: chapters.reduce(
      (total, chapter) => total + chapter.wordCount,
      0
    ),
    updatedAt: now,
    createdAt: now
  }, { merge: true });

  chapters.forEach((chapter) => {
    const chapterRef = bookRef.collection('chapters')
      .doc(String(chapter.chapterNumber).padStart(4, '0'));

    batch.set(chapterRef, {
      ...chapter,
      bookId,
      updatedAt: now,
      createdAt: now
    });
  });

  await batch.commit();

  return {
    bookId,
    chapterCount: chapters.length,
    totalWordCount: chapters.reduce(
      (total, chapter) => total + chapter.wordCount,
      0
    )
  };
}

app.post('/api/books/:bookId/import-manuscript', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const { title, authorId, rawText } = req.body || {};

    const result = await importManuscript({
      bookId: req.params.bookId,
      title,
      authorId,
      rawText
    });

    return res.status(201).json({
      success: true,
      message: 'Manuscript imported successfully.',
      ...result
    });
  } catch (error) {
    console.error('Manuscript import failed:', error);
    return res.status(400).json({
      success: false,
      error: error.message || 'Manuscript import failed.'
    });
  }
});

const manuscriptImportSchema = {
  bookId: '',
  title: '',
  authorId: '',
  status: 'draft',
  chapterCount: 0,
  totalWordCount: 0,
  createdAt: null,
  updatedAt: null
};

function normalizeManuscriptText(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function countWords(text) {
  const value = String(text || '').trim();
  return value ? value.split(/\s+/).length : 0;
}

function parseManuscriptChapters(text) {
  const normalized = normalizeManuscriptText(text);

  // Supports: Chapter 1, Chapter 1: Title, Chapter 1 - Title,
  // Part 3: Title, and similar explicit headings.
  const headingRegex = /^\s*((?:chapter|chap\.?|part)\s+\d+(?:\s*[:\-.]\s*[^\n]+)?)[ \t]*$/gim;
  const matches = [...normalized.matchAll(headingRegex)];

  if (!matches.length) {
    return [{
      number: 1,
      title: 'Chapter 1',
      text: normalized,
      wordCount: countWords(normalized)
    }];
  }

  const chapters = [];

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const heading = match[1].trim();
    const bodyStart = match.index + match[0].length;
    const bodyEnd = index + 1 < matches.length
      ? matches[index + 1].index
      : normalized.length;
    const chapterText = normalized.slice(bodyStart, bodyEnd).trim();

    chapters.push({
      number: index + 1,
      title: heading,
      text: chapterText,
      wordCount: countWords(chapterText)
    });
  }

  return chapters;
}

function getUploadedText(file) {
  if (!file) return '';
  if (typeof file === 'string') return file;
  if (Buffer.isBuffer(file)) return file.toString('utf8');
  if (file.buffer && Buffer.isBuffer(file.buffer)) {
    return file.buffer.toString('utf8');
  }
  return String(file.text || file.content || '');
}

app.post('/api/books/:bookId/manuscript/import', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const { bookId } = req.params;
    const { title = '', authorId = req.user.uid, text = '', manuscriptText = '' } = req.body || {};
    const sourceText = getUploadedText(text || manuscriptText);

    if (!sourceText.trim()) {
      return res.status(400).json({ error: 'Manuscript text is required.' });
    }

    const chapters = parseManuscriptChapters(sourceText);
    const bookRef = db.collection('books').doc(bookId);
    const now = admin.firestore.FieldValue.serverTimestamp();

    await db.runTransaction(async (transaction) => {
      const bookSnap = await transaction.get(bookRef);
      if (!bookSnap.exists) {
        throw new Error('BOOK_NOT_FOUND');
      }

      const existingChapters = await bookRef.collection('chapters').get();
      existingChapters.docs.forEach((chapterDoc) => {
        transaction.delete(chapterDoc.ref);
      });

      chapters.forEach((chapter) => {
        const chapterRef = bookRef.collection('chapters').doc();
        transaction.set(chapterRef, {
          number: chapter.number,
          title: chapter.title,
          text: chapter.text,
          wordCount: chapter.wordCount,
          createdAt: now,
          updatedAt: now
        });
      });

      transaction.update(bookRef, {
        title: title || bookSnap.data().title || 'Untitled Book',
        authorId,
        status: 'draft',
        chapterCount: chapters.length,
        totalWordCount: chapters.reduce((sum, chapter) => sum + chapter.wordCount, 0),
        updatedAt: now
      });
    });

    return res.status(200).json({
      success: true,
      bookId,
      chapterCount: chapters.length,
      totalWordCount: chapters.reduce((sum, chapter) => sum + chapter.wordCount, 0)
    });
  } catch (error) {
    if (error.message === 'BOOK_NOT_FOUND') {
      return res.status(404).json({ error: 'Book not found.' });
    }

    console.error('Manuscript import failed:', error);
    return res.status(500).json({ error: 'Manuscript import failed.' });
  }
});