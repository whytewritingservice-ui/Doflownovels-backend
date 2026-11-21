const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

const app = express();
app.use(cors());
app.use(express.json());

// --- 1. FIREBASE ADMIN INITIALIZATION ---
try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    // Fix escaped newlines in the private key from Render env vars
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    
    if (!admin.apps.length) {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
    }
    console.log("Firebase Admin initialized successfully.");
} catch (error) {
    console.error("FATAL ERROR: Firebase Admin initialization failed. Check your FIREBASE_SERVICE_ACCOUNT env var.", error);
}

const db = admin.firestore();

// --- 2. HEALTH CHECK ---
app.get('/', (req, res) => {
    res.send('Doflownovels Backend is running smoothly. 🚀');
});

// --- 3. FLUTTERWAVE WEBHOOK (From Domco Hub) ---
app.post('/api/doflow-unlock', async (req, res) => {
    try {
        const payload = req.body;
        
        // Ensure this is a charge.completed event and a doflow_ transaction
        if (!payload.data || !payload.data.tx_ref || !payload.data.tx_ref.startsWith('doflow_')) {
            return res.status(200).send({ status: 'ignored', message: 'Not a doflow transaction' });
        }

        const txId = payload.data.id;
        const txRef = payload.data.tx_ref;
        const customerEmail = payload.data.customer.email;

        console.log(`Received webhook for txRef: ${txRef}. Verifying with Flutterwave...`);

        // Verify with Flutterwave API
        const flwRes = await fetch(`https://api.flutterwave.com/v3/transactions/${txId}/verify`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${process.env.FLW_SECRET_KEY}`,
                'Content-Type': 'application/json'
            }
        });
        
        const flwData = await flwRes.json();

        if (flwData.status === 'success' && flwData.data.status === 'successful') {
            // Find the author in Firestore by email
            const authorsSnapshot = await db.collection('authors').where('email', '==', customerEmail).get();
            
            if (authorsSnapshot.empty) {
                console.log(`No author found with email: ${customerEmail}`);
                return res.status(404).send({ error: 'Author not found in database' });
            }

            // Update all matching author docs to isPro: true
            const batch = db.batch();
            authorsSnapshot.forEach(doc => {
                batch.update(doc.ref, { isPro: true });
            });
            await batch.commit();

            console.log(`Successfully verified and unlocked author: ${customerEmail}`);
            return res.status(200).send({ status: 'success', message: 'Author unlocked' });
        } else {
            console.log(`Flutterwave verification failed for tx: ${txId}`);
            return res.status(400).send({ error: 'Payment verification failed' });
        }
    } catch (error) {
        console.error("Webhook Error:", error);
        res.status(500).send({ error: 'Internal server error' });
    }
});

// --- 4. ADMIN MANUAL UNLOCK ---
app.post('/api/admin/unlock', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).send({ error: 'Unauthorized: Missing token' });
        }

        const idToken = authHeader.split('Bearer ')[1];
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        
        // SECURITY: Only allow the specific admin email
        if (decodedToken.email !== 'whytewritingservice@gmail.com') {
            return res.status(403).send({ error: 'Forbidden: Admin access only' });
        }

        const { targetUid } = req.body;
        if (!targetUid) return res.status(400).send({ error: 'Missing targetUid' });

        await db.collection('authors').doc(targetUid).set({ isPro: true }, { merge: true });
        
        console.log(`Admin manually unlocked UID: ${targetUid}`);
        res.status(200).send({ status: 'success', message: 'Author unlocked' });
    } catch (error) {
        console.error("Admin Unlock Error:", error);
        res.status(500).send({ error: 'Internal server error' });
    }
});

/* =========================================================
   DOFLOWNOVELS — NEW BACKEND ADDITIONS
   BATCH 1 OF 3
   CODO BILLS FOUNDATION
   ========================================================= */

const dfCodoCrypto = require('crypto');

// ---------------------------------------------------------
// 1. CODO AUTHENTICATION
// ---------------------------------------------------------

async function dfCodoAuthenticate(req, res, next) {
    try {
        const header = req.headers.authorization || '';

        if (!header.startsWith('Bearer ')) {
            return res.status(401).json({
                success: false,
                error: 'Login required.'
            });
        }

        req.dfCodoUser = await admin.auth().verifyIdToken(
            header.substring(7)
        );

        next();
    } catch (error) {
        return res.status(401).json({
            success: false,
            error: 'Invalid or expired login.'
        });
    }
}

function dfCodoRequireAdmin(req, res, next) {
    if (
        String(req.dfCodoUser?.email || '').toLowerCase() !==
        'whytewritingservice@gmail.com'
    ) {
        return res.status(403).json({
            success: false,
            error: 'Administrator access only.'
        });
    }

    next();
}

const dfCodoTime = () =>
    admin.firestore.FieldValue.serverTimestamp();

const dfCodoRoundMoney = value =>
    Math.round((Number(value) + Number.EPSILON) * 100) / 100;

// ---------------------------------------------------------
// 2. CENTRAL CODO BILL SETTINGS
// ---------------------------------------------------------

const dfCodoSettingsDocument = db
    .collection('platformSettings')
    .doc('codoBills');

async function dfCodoGetSettings() {
    const snapshot = await dfCodoSettingsDocument.get();
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

// Admin views pricing settings

app.get(
    '/api/admin/codo-bills/settings',
    dfCodoAuthenticate,
    dfCodoRequireAdmin,
    async (req, res) => {
        try {
            res.json({
                success: true,
                settings: await dfCodoGetSettings()
            });
        } catch (error) {
            console.error('Codo settings error:', error);

            res.status(500).json({
                success: false,
                error: 'Unable to load Codo settings.'
            });
        }
    }
);

// Admin changes central price and currency rates

app.put(
    '/api/admin/codo-bills/settings',
    dfCodoAuthenticate,
    dfCodoRequireAdmin,
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

                update.billPriceGBP =
                    dfCodoRoundMoney(price);
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

                for (const [rawCode, rawRate] of
                    Object.entries(body.currencyRates)) {

                    const code = rawCode.toUpperCase();
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

            update.updatedAt = dfCodoTime();
            update.updatedBy = req.dfCodoUser.uid;

            await dfCodoSettingsDocument.set(
                update,
                { merge: true }
            );

            res.json({
                success: true,
                message: 'Codo settings updated.',
                settings: await dfCodoGetSettings()
            });

        } catch (error) {
            console.error('Codo settings update:', error);

            res.status(500).json({
                success: false,
                error: 'Unable to update Codo settings.'
            });
        }
    }
);

// ---------------------------------------------------------
// 3. READER CODO BILL WALLET
// ---------------------------------------------------------

app.get(
    '/api/codo-bills/wallet',
    dfCodoAuthenticate,
    async (req, res) => {
        try {
            const uid = req.dfCodoUser.uid;

            const walletRef = db
                .collection('codoWallets')
                .doc(uid);

            const [walletSnapshot, historySnapshot] =
                await Promise.all([
                    walletRef.get(),

                    db.collection('codoTransactions')
                        .where('uid', '==', uid)
                        .limit(50)
                        .get()
                ]);

            const wallet = walletSnapshot.exists
                ? walletSnapshot.data()
                : {};

            const purchasedBills =
                Number(wallet.purchasedBills || 0);

            const awardedBills =
                Number(wallet.awardedBills || 0);

            const history = historySnapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data()
            }));

            history.sort((a, b) => {
                const first =
                    a.createdAt?.toMillis?.() || 0;

                const second =
                    b.createdAt?.toMillis?.() || 0;

                return second - first;
            });

            res.json({
                success: true,

                wallet: {
                    purchasedBills,
                    awardedBills,
                    totalBills:
                        purchasedBills + awardedBills
                },

                transactions: history
            });

        } catch (error) {
            console.error('Codo wallet error:', error);

            res.status(500).json({
                success: false,
                error: 'Unable to load Codo wallet.'
            });
        }
    }
);

// ---------------------------------------------------------
// 4. CODO BILL CHECKOUT
// Uses your existing FLW_SECRET_KEY.
// No separate Codo secret key.
// No invented exchange rates.
// ---------------------------------------------------------

app.post(
    '/api/codo-bills/checkout',
    dfCodoAuthenticate,
    async (req, res) => {
        let paymentDocument = null;

        try {
            if (!process.env.FLW_SECRET_KEY) {
                return res.status(503).json({
                    success: false,
                    error: 'Flutterwave is not configured.'
                });
            }

            const settings = await dfCodoGetSettings();

            if (!settings.enabled) {
                return res.status(403).json({
                    success: false,
                    error: 'Codo Bill purchases are temporarily disabled.'
                });
            }

            const bundle = Number(req.body.bundle);
            const currency = String(
                req.body.currency || 'GBP'
            ).toUpperCase();

            if (![1, 3, 5, 10].includes(bundle)) {
                return res.status(400).json({
                    success: false,
                    error: 'Choose 1, 3, 5 or 10 Codo Bills.'
                });
            }

            const email = req.dfCodoUser.email;

            if (!email) {
                return res.status(400).json({
                    success: false,
                    error: 'A verified email is required.'
                });
            }

            const rate = Number(
                settings.currencyRates[currency]
            );

            if (!Number.isFinite(rate) || rate <= 0) {
                return res.status(400).json({
                    success: false,
                    error:
                        `Checkout in ${currency} has not been configured.`
                });
            }

            const amount = dfCodoRoundMoney(
                bundle * settings.billPriceGBP * rate
            );

            if (!Number.isFinite(amount) || amount <= 0) {
                return res.status(400).json({
                    success: false,
                    error: 'Invalid payment amount.'
                });
            }

            const txRef =
                'codo_' +
                req.dfCodoUser.uid +
                '_' +
                Date.now() +
                '_' +
                dfCodoCrypto.randomBytes(6).toString('hex');

            paymentDocument = db
                .collection('codoTransactions')
                .doc(txRef);

            await paymentDocument.set({
                uid: req.dfCodoUser.uid,
                email,
                txRef,
                bundle,
                amount,
                currency,
                billPriceGBP: settings.billPriceGBP,
                exchangeRate: rate,
                type: 'bill_purchase',
                status: 'pending',
                createdAt: dfCodoTime()
            });

            const flutterwaveResponse = await fetch(
                'https://api.flutterwave.com/v3/payments',
                {
                    method: 'POST',

                    headers: {
                        Authorization:
                            `Bearer ${process.env.FLW_SECRET_KEY}`,
                        'Content-Type': 'application/json'
                    },

                    body: JSON.stringify({
                        tx_ref: txRef,
                        amount,
                        currency,

                        // Returns the reader to the existing
                        // Doflownovels frontend.
                        redirect_url:
                            'https://doflownovels.netlify.app/',

                        customer: {
                            email,
                            name: req.dfCodoUser.name || email
                        },

                        customizations: {
                            title: 'Doflownovels Codo Bills',
                            description:
                                `${bundle} Codo Bill${bundle === 1 ? '' : 's'}`
                        },

                        meta: {
                            uid: req.dfCodoUser.uid,
                            product: 'doflownovels_codo_bills',
                            bundle
                        }
                    })
                }
            );

            const paymentData =
                await flutterwaveResponse.json();

            if (
                !flutterwaveResponse.ok ||
                paymentData.status !== 'success' ||
                !paymentData.data?.link
            ) {
                await paymentDocument.update({
                    status: 'initialization_failed',
                    updatedAt: dfCodoTime()
                });

                return res.status(502).json({
                    success: false,
                    error: 'Flutterwave checkout could not be started.'
                });
            }

            await paymentDocument.update({
                checkoutUrl: paymentData.data.link,
                checkoutCreatedAt: dfCodoTime()
            });

            res.json({
                success: true,
                txRef,
                checkoutUrl: paymentData.data.link,
                amount,
                currency,
                bills: bundle
            });

        } catch (error) {
            console.error('Codo checkout error:', error);

            if (paymentDocument) {
                try {
                    await paymentDocument.update({
                        status: 'initialization_error',
                        updatedAt: dfCodoTime()
                    });
                } catch (_) {}
            }

            res.status(500).json({
                success: false,
                error: 'Unable to start Codo Bill checkout.'
            });
        }
    }
);

// =========================================================
// END OF NEW BACKEND BATCH 1 OF 3
// =========================================================


/* =========================================================
   DOFLOWNOVELS — NEW BACKEND ADDITIONS
   BATCH 2 OF 3
   PAYMENT VERIFICATION, WALLET CREDIT AND UNLOCKS
   ========================================================= */

// ---------------------------------------------------------
// 1. VERIFY CODO BILL PAYMENT WITH FLUTTERWAVE
// ---------------------------------------------------------

app.post(
    '/api/codo-bills/verify-payment',
    dfCodoAuthenticate,
    async (req, res) => {
        try {
            const { transactionId, txRef } = req.body || {};

            if (!transactionId || !txRef) {
                return res.status(400).json({
                    success: false,
                    error: 'Transaction ID and reference are required.'
                });
            }

            if (
                typeof txRef !== 'string' ||
                !txRef.startsWith(
                    `codo_${req.dfCodoUser.uid}_`
                )
            ) {
                return res.status(403).json({
                    success: false,
                    error: 'This payment does not belong to your account.'
                });
            }

            const paymentRef = db
                .collection('codoTransactions')
                .doc(txRef);

            const paymentSnapshot = await paymentRef.get();

            if (!paymentSnapshot.exists) {
                return res.status(404).json({
                    success: false,
                    error: 'Payment record not found.'
                });
            }

            const payment = paymentSnapshot.data();

            if (payment.uid !== req.dfCodoUser.uid) {
                return res.status(403).json({
                    success: false,
                    error: 'Payment ownership check failed.'
                });
            }

            if (payment.status === 'successful') {
                return res.json({
                    success: true,
                    alreadyProcessed: true,
                    bills: payment.bundle
                });
            }

            if (payment.status !== 'pending') {
                return res.status(400).json({
                    success: false,
                    error: 'This payment is not awaiting verification.'
                });
            }

            const verifyResponse = await fetch(
                `https://api.flutterwave.com/v3/transactions/${encodeURIComponent(transactionId)}/verify`,
                {
                    method: 'GET',
                    headers: {
                        Authorization:
                            `Bearer ${process.env.FLW_SECRET_KEY}`,
                        'Content-Type': 'application/json'
                    }
                }
            );

            const verifyResult = await verifyResponse.json();
            const paid = verifyResult.data;

            if (
                !verifyResponse.ok ||
                verifyResult.status !== 'success' ||
                !paid
            ) {
                return res.status(400).json({
                    success: false,
                    error: 'Flutterwave could not verify this payment.'
                });
            }

            const paidAmount = Number(
                paid.amount
            );

            const expectedAmount = Number(
                payment.amount
            );

            const paidCurrency = String(
                paid.currency || ''
            ).toUpperCase();

            const expectedCurrency = String(
                payment.currency || ''
            ).toUpperCase();

            const paidEmail = String(
                paid.customer?.email || ''
            ).toLowerCase();

            const expectedEmail = String(
                payment.email || ''
            ).toLowerCase();

            if (
                paid.status !== 'successful' ||
                paid.tx_ref !== txRef ||
                paidCurrency !== expectedCurrency ||
                !Number.isFinite(paidAmount) ||
                paidAmount < expectedAmount ||
                paidEmail !== expectedEmail
            ) {
                return res.status(400).json({
                    success: false,
                    error: 'Payment details did not match the checkout.'
                });
            }

            const walletRef = db
                .collection('codoWallets')
                .doc(payment.uid);

            const result = await db.runTransaction(
                async transaction => {
                    // All reads happen before writes.
                    const currentPayment =
                        await transaction.get(paymentRef);

                    const walletSnapshot =
                        await transaction.get(walletRef);

                    if (!currentPayment.exists) {
                        throw new Error('PAYMENT_NOT_FOUND');
                    }

                    const current =
                        currentPayment.data();

                    if (current.status === 'successful') {
                        return {
                            alreadyProcessed: true
                        };
                    }

                    if (current.status !== 'pending') {
                        throw new Error('PAYMENT_NOT_PENDING');
                    }

                    const wallet = walletSnapshot.exists
                        ? walletSnapshot.data()
                        : {};

                    const purchasedBills =
                        Number(wallet.purchasedBills || 0);

                    transaction.set(
                        walletRef,
                        {
                            uid: payment.uid,
                            purchasedBills:
                                purchasedBills + Number(payment.bundle),
                            awardedBills:
                                Number(wallet.awardedBills || 0),
                            updatedAt: dfCodoTime()
                        },
                        { merge: true }
                    );

                    transaction.update(paymentRef, {
                        status: 'successful',
                        flutterwaveTransactionId:
                            String(transactionId),
                        verifiedAmount: paidAmount,
                        verifiedCurrency: paidCurrency,
                        verifiedAt: dfCodoTime()
                    });

                    return {
                        alreadyProcessed: false
                    };
                }
            );

            return res.json({
                success: true,
                alreadyProcessed: result.alreadyProcessed,
                bills: payment.bundle,
                message: result.alreadyProcessed
                    ? 'Payment was already credited.'
                    : 'Payment verified. Codo Bills added to your wallet.'
            });

        } catch (error) {
            console.error('Codo payment verification:', error);

            res.status(500).json({
                success: false,
                error: 'Unable to verify payment.'
            });
        }
    }
);

// ---------------------------------------------------------
// 2. ADMIN ENABLES OR DISABLES AUTHOR CODO PARTICIPATION
// ---------------------------------------------------------

app.post(
    '/api/admin/codo-bills/participation',
    dfCodoAuthenticate,
    dfCodoRequireAdmin,
    async (req, res) => {
        try {
            const { authorId, enabled } = req.body || {};

            if (
                typeof authorId !== 'string' ||
                !authorId.trim() ||
                typeof enabled !== 'boolean'
            ) {
                return res.status(400).json({
                    success: false,
                    error: 'Valid authorId and enabled value are required.'
                });
            }

            const authorRef = db
                .collection('authors')
                .doc(authorId);

            const authorSnapshot = await authorRef.get();

            if (!authorSnapshot.exists) {
                return res.status(404).json({
                    success: false,
                    error: 'Author account not found.'
                });
            }

            await authorRef.set({
                codoEnabled: enabled,
                codoUpdatedAt: dfCodoTime(),
                codoUpdatedBy: req.dfCodoUser.uid
            }, { merge: true });

            return res.json({
                success: true,
                authorId,
                codoEnabled: enabled
            });

        } catch (error) {
            console.error('Codo participation error:', error);

            res.status(500).json({
                success: false,
                error: 'Unable to update author participation.'
            });
        }
    }
);

// ---------------------------------------------------------
// 3. READER UNLOCKS A PACKAGE OF UP TO 15 CHAPTERS
// ---------------------------------------------------------

app.post(
    '/api/codo-bills/unlock-package',
    dfCodoAuthenticate,
    async (req, res) => {
        try {
            const uid = req.dfCodoUser.uid;
            const { bookId, chapterIndexes } = req.body || {};

            if (
                typeof bookId !== 'string' ||
                !bookId.trim() ||
                !Array.isArray(chapterIndexes) ||
                chapterIndexes.length < 1 ||
                chapterIndexes.length > 15
            ) {
                return res.status(400).json({
                    success: false,
                    error: 'Choose a book and between 1 and 15 chapters.'
                });
            }

            const indexes = chapterIndexes.map(Number);

            if (
                indexes.some(index =>
                    !Number.isInteger(index) || index < 0
                ) ||
                new Set(indexes).size !== indexes.length
            ) {
                return res.status(400).json({
                    success: false,
                    error: 'Invalid or duplicate chapter selection.'
                });
            }

            // Actual platform admin reads everything free.
            // No wallet deduction or fake purchase is created.
            if (
                String(req.dfCodoUser.email || '').toLowerCase() ===
                'whytewritingservice@gmail.com'
            ) {
                return res.json({
                    success: true,
                    unlimitedAccess: true,
                    billsDeducted: 0,
                    message: 'Administrator unlimited reading access.'
                });
            }

            const bookRef = db
                .collection('books')
                .doc(bookId);

            const bookSnapshot = await bookRef.get();

            if (!bookSnapshot.exists) {
                return res.status(404).json({
                    success: false,
                    error: 'Book not found.'
                });
            }

            const book = bookSnapshot.data();
            const authorId = book.authorId;

            if (!authorId) {
                return res.status(400).json({
                    success: false,
                    error: 'Book has no valid author.'
                });
            }

            const authorRef = db
                .collection('authors')
                .doc(authorId);

            const authorSnapshot = await authorRef.get();

            if (
                !authorSnapshot.exists ||
                authorSnapshot.data().codoEnabled !== true
            ) {
                return res.status(403).json({
                    success: false,
                    error: 'This author has not enabled Codo Bills participation.'
                });
            }

            if (!Array.isArray(book.chapters)) {
                return res.status(400).json({
                    success: false,
                    error: 'Book chapters could not be read.'
                });
            }

            const selectedChapters = [];

            for (const index of indexes) {
                const chapter = book.chapters[index];

                if (!chapter) {
                    return res.status(400).json({
                        success: false,
                        error: `Chapter ${index + 1} does not exist.`
                    });
                }

                const isLocked =
                    chapter.locked === true ||
                    chapter.isLocked === true;

                if (!isLocked) {
                    return res.status(400).json({
                        success: false,
                        error: `Chapter ${index + 1} is not marked as locked.`
                    });
                }

                const wordCount = String(
                    chapter.content || ''
                ).trim().split(/\s+/).filter(Boolean).length;

                if (wordCount < 1200) {
                    return res.status(400).json({
                        success: false,
                        error:
                            `Chapter ${index + 1} has fewer than 1,200 words and is not eligible.`
                    });
                }

                selectedChapters.push({
                    index,
                    title: String(
                        chapter.title || `Chapter ${index + 1}`
                    )
                });
            }

            const walletRef = db
                .collection('codoWallets')
                .doc(uid);

            const accessRef = db
                .collection('codoPackageAccess')
                .doc(`${uid}_${bookId}`);

            const transactionRef = db
                .collection('codoTransactions')
                .doc();

            const unlockResult = await db.runTransaction(
                async transaction => {
                    // Read everything first.
                    const walletSnapshot =
                        await transaction.get(walletRef);

                    const accessSnapshot =
                        await transaction.get(accessRef);

                    const wallet = walletSnapshot.exists
                        ? walletSnapshot.data()
                        : {};

                    const existingAccess = accessSnapshot.exists
                        ? accessSnapshot.data()
                        : {};

                    const existingIndexes = Array.isArray(
                        existingAccess.chapterIndexes
                    )
                        ? existingAccess.chapterIndexes
                        : [];

                    const alreadyUnlocked = indexes.filter(
                        index => existingIndexes.includes(index)
                    );

                    if (alreadyUnlocked.length > 0) {
                        throw new Error('CHAPTER_ALREADY_UNLOCKED');
                    }

                    const purchasedBills = Math.max(
                        0,
                        Number(wallet.purchasedBills || 0)
                    );

                    const awardedBills = Math.max(
                        0,
                        Number(wallet.awardedBills || 0)
                    );

                    if (purchasedBills + awardedBills < 1) {
                        throw new Error('INSUFFICIENT_BILLS');
                    }

                    // Use purchased bills first.
                    // Awarded bills are tracked separately.
                    const usePurchased = purchasedBills > 0;

                    const newPurchased = usePurchased
                        ? purchasedBills - 1
                        : purchasedBills;

                    const newAwarded = usePurchased
                        ? awardedBills
                        : awardedBills - 1;

                    const currencyValueGBP = usePurchased
                        ? Number(
                            (await dfCodoGetSettings()).billPriceGBP
                        )
                        : 0;

                    const authorShareGBP =
                        usePurchased
                            ? dfCodoRoundMoney(
                                currencyValueGBP * 0.70
                            )
                            : 0;

                    const platformShareGBP =
                        usePurchased
                            ? dfCodoRoundMoney(
                                currencyValueGBP * 0.30
                            )
                            : 0;

                    transaction.set(walletRef, {
                        uid,
                        purchasedBills: newPurchased,
                        awardedBills: newAwarded,
                        updatedAt: dfCodoTime()
                    }, { merge: true });

                    transaction.set(accessRef, {
                        uid,
                        bookId,
                        authorId,
                        chapterIndexes: [
                            ...existingIndexes,
                            ...indexes
                        ],
                        updatedAt: dfCodoTime()
                    }, { merge: true });

                    transaction.set(transactionRef, {
                        uid,
                        bookId,
                        authorId,
                        type: 'package_unlock',
                        chapterIndexes: indexes,
                        chapterCount: indexes.length,
                        billSource: usePurchased
                            ? 'purchased'
                            : 'awarded',
                        billsSpent: 1,
                        authorShareGBP,
                        platformShareGBP,
                        status: 'successful',
                        createdAt: dfCodoTime()
                    });

                    return {
                        purchasedBills: newPurchased,
                        awardedBills: newAwarded,
                        authorShareGBP,
                        platformShareGBP,
                        billSource: usePurchased
                            ? 'purchased'
                            : 'awarded'
                    };
                }
            );

            // Record purchased-bill author earnings separately.
            if (unlockResult.billSource === 'purchased') {
                await db.collection('codoAuthorEarnings').add({
                    authorId,
                    readerUid: uid,
                    bookId,
                    transactionId: transactionRef.id,
                    authorShareGBP:
                        unlockResult.authorShareGBP,
                    platformShareGBP:
                        unlockResult.platformShareGBP,
                    status: 'pending',
                    createdAt: dfCodoTime()
                });
            }

            return res.json({
                success: true,
                bookId,
                unlockedChapters: indexes,
                billsDeducted: 1,
                billSource: unlockResult.billSource,
                wallet: {
                    purchasedBills:
                        unlockResult.purchasedBills,
                    awardedBills:
                        unlockResult.awardedBills
                },
                message: 'Chapter package unlocked successfully.'
            });

        } catch (error) {
            console.error('Codo package unlock:', error);

            if (error.message === 'INSUFFICIENT_BILLS') {
                return res.status(402).json({
                    success: false,
                    error: 'You do not have enough Codo Bills.'
                });
            }

            if (error.message === 'CHAPTER_ALREADY_UNLOCKED') {
                return res.status(409).json({
                    success: false,
                    error: 'One or more selected chapters are already unlocked.'
                });
            }

            return res.status(500).json({
                success: false,
                error: 'Unable to unlock this chapter package.'
            });
        }
    }
);

// ---------------------------------------------------------
// 4. CHECK READER ACCESS TO A BOOK'S CHAPTERS
// ---------------------------------------------------------

app.get(
    '/api/codo-bills/access/:bookId',
    dfCodoAuthenticate,
    async (req, res) => {
        try {
            const uid = req.dfCodoUser.uid;
            const email = String(
                req.dfCodoUser.email || ''
            ).toLowerCase();

            if (email === 'whytewritingservice@gmail.com') {
                return res.json({
                    success: true,
                    unlimitedAccess: true,
                    chapterIndexes: []
                });
            }

            const accessSnapshot = await db
                .collection('codoPackageAccess')
                .doc(`${uid}_${req.params.bookId}`)
                .get();

            const data = accessSnapshot.exists
                ? accessSnapshot.data()
                : {};

            return res.json({
                success: true,
                unlimitedAccess: false,
                chapterIndexes:
                    data.chapterIndexes || []
            });

        } catch (error) {
            console.error('Codo access check:', error);

            res.status(500).json({
                success: false,
                error: 'Unable to check chapter access.'
            });
        }
    }
);

// =========================================================
// END OF NEW BACKEND BATCH 2 OF 3
// =========================================================


/* =========================================================
   DOFLOWNOVELS — NEW BACKEND ADDITIONS
   BATCH 3 OF 3
   CODO AWARDS, AUTHOR EARNINGS AND ADMIN FINANCE
   ========================================================= */

// ---------------------------------------------------------
// 1. AWARD CODO BILLS TO A READER
// ---------------------------------------------------------

app.post(
    '/api/admin/codo-bills/award',
    dfCodoAuthenticate,
    dfCodoRequireAdmin,
    async (req, res) => {
        try {
            const {
                readerUid,
                bills,
                source,
                reason
            } = req.body || {};

            const amount = Number(bills);

            const validSources = [
                'doflow',
                'contest_sponsor',
                'author'
            ];

            if (
                typeof readerUid !== 'string' ||
                !readerUid.trim() ||
                !Number.isInteger(amount) ||
                amount < 1 ||
                amount > 10000 ||
                !validSources.includes(source)
            ) {
                return res.status(400).json({
                    success: false,
                    error: 'Invalid reader, bill amount or award source.'
                });
            }

            const walletRef = db
                .collection('codoWallets')
                .doc(readerUid);

            const awardRef = db
                .collection('codoTransactions')
                .doc();

            await db.runTransaction(async transaction => {
                const walletSnapshot =
                    await transaction.get(walletRef);

                const wallet = walletSnapshot.exists
                    ? walletSnapshot.data()
                    : {};

                transaction.set(walletRef, {
                    uid: readerUid,
                    purchasedBills:
                        Number(wallet.purchasedBills || 0),
                    awardedBills:
                        Number(wallet.awardedBills || 0) + amount,
                    updatedAt: dfCodoTime()
                }, { merge: true });

                transaction.set(awardRef, {
                    uid: readerUid,
                    type: 'bill_award',
                    source,
                    billsAwarded: amount,
                    reason: String(reason || 'Codo Bill award').slice(0, 500),
                    status: 'successful',
                    awardedBy: req.dfCodoUser.uid,
                    createdAt: dfCodoTime()
                });
            });

            return res.json({
                success: true,
                message: `${amount} Codo Bills awarded.`,
                awardId: awardRef.id
            });

        } catch (error) {
            console.error('Codo award error:', error);

            res.status(500).json({
                success: false,
                error: 'Unable to award Codo Bills.'
            });
        }
    }
);

// ---------------------------------------------------------
// 2. READER AWARD HISTORY
// ---------------------------------------------------------

app.get(
    '/api/codo-bills/awards',
    dfCodoAuthenticate,
    async (req, res) => {
        try {
            const snapshot = await db
                .collection('codoTransactions')
                .where('uid', '==', req.dfCodoUser.uid)
                .where('type', '==', 'bill_award')
                .limit(100)
                .get();

            const awards = snapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data()
            }));

            awards.sort((a, b) => {
                const first = a.createdAt?.toMillis?.() || 0;
                const second = b.createdAt?.toMillis?.() || 0;
                return second - first;
            });

            res.json({
                success: true,
                awards
            });

        } catch (error) {
            console.error('Codo award history:', error);

            res.status(500).json({
                success: false,
                error: 'Unable to load award history.'
            });
        }
    }
);

// ---------------------------------------------------------
// 3. AUTHOR VIEWS CODO EARNINGS
// ---------------------------------------------------------

app.get(
    '/api/codo-bills/author/earnings',
    dfCodoAuthenticate,
    async (req, res) => {
        try {
            const authorId = req.dfCodoUser.uid;

            const authorSnapshot = await db
                .collection('authors')
                .doc(authorId)
                .get();

            if (!authorSnapshot.exists) {
                return res.status(404).json({
                    success: false,
                    error: 'Author account not found.'
                });
            }

            const snapshot = await db
                .collection('codoAuthorEarnings')
                .where('authorId', '==', authorId)
                .limit(500)
                .get();

            const earnings = snapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data()
            }));

            let pendingGBP = 0;
            let paidGBP = 0;
            let totalGBP = 0;

            for (const item of earnings) {
                const amount = Number(item.authorShareGBP || 0);

                totalGBP += amount;

                if (item.status === 'paid') {
                    paidGBP += amount;
                } else if (item.status === 'pending') {
                    pendingGBP += amount;
                }
            }

            earnings.sort((a, b) => {
                const first = a.createdAt?.toMillis?.() || 0;
                const second = b.createdAt?.toMillis?.() || 0;
                return second - first;
            });

            res.json({
                success: true,
                earnings: {
                    totalGBP: dfCodoRoundMoney(totalGBP),
                    pendingGBP: dfCodoRoundMoney(pendingGBP),
                    paidGBP: dfCodoRoundMoney(paidGBP)
                },
                transactions: earnings
            });

        } catch (error) {
            console.error('Author Codo earnings:', error);

            res.status(500).json({
                success: false,
                error: 'Unable to load author earnings.'
            });
        }
    }
);

// ---------------------------------------------------------
// 4. ADMIN VIEWS CODO FINANCE SUMMARY
// ---------------------------------------------------------

app.get(
    '/api/admin/codo-bills/finance',
    dfCodoAuthenticate,
    dfCodoRequireAdmin,
    async (req, res) => {
        try {
            const [payments, earnings, wallets] =
                await Promise.all([
                    db.collection('codoTransactions')
                        .where('type', '==', 'bill_purchase')
                        .limit(1000)
                        .get(),

                    db.collection('codoAuthorEarnings')
                        .limit(1000)
                        .get(),

                    db.collection('codoWallets')
                        .limit(1000)
                        .get()
                ]);

            let successfulPayments = 0;
            let pendingPayments = 0;
            let grossPaymentsGBP = 0;

            for (const doc of payments.docs) {
                const item = doc.data();

                if (item.status === 'successful') {
                    successfulPayments++;
                    grossPaymentsGBP +=
                        Number(item.bundle || 0) *
                        Number(item.billPriceGBP || 1);
                } else if (item.status === 'pending') {
                    pendingPayments++;
                }
            }

            let pendingAuthorGBP = 0;
            let paidAuthorGBP = 0;
            let platformShareGBP = 0;

            for (const doc of earnings.docs) {
                const item = doc.data();

                const authorAmount =
                    Number(item.authorShareGBP || 0);

                const platformAmount =
                    Number(item.platformShareGBP || 0);

                platformShareGBP += platformAmount;

                if (item.status === 'paid') {
                    paidAuthorGBP += authorAmount;
                } else if (item.status === 'pending') {
                    pendingAuthorGBP += authorAmount;
                }
            }

            let purchasedBillsOutstanding = 0;
            let awardedBillsOutstanding = 0;

            for (const doc of wallets.docs) {
                const wallet = doc.data();

                purchasedBillsOutstanding +=
                    Number(wallet.purchasedBills || 0);

                awardedBillsOutstanding +=
                    Number(wallet.awardedBills || 0);
            }

            res.json({
                success: true,

                finance: {
                    successfulPayments,
                    pendingPayments,
                    grossPaymentsGBP:
                        dfCodoRoundMoney(grossPaymentsGBP),

                    pendingAuthorGBP:
                        dfCodoRoundMoney(pendingAuthorGBP),

                    paidAuthorGBP:
                        dfCodoRoundMoney(paidAuthorGBP),

                    recordedPlatformShareGBP:
                        dfCodoRoundMoney(platformShareGBP),

                    purchasedBillsOutstanding,
                    awardedBillsOutstanding,

                    note:
                        'Figures are based on the latest 1,000 matching records and exclude payment processor fees and external settlement adjustments.'
                }
            });

        } catch (error) {
            console.error('Codo finance summary:', error);

            res.status(500).json({
                success: false,
                error: 'Unable to load Codo finance summary.'
            });
        }
    }
);

// ---------------------------------------------------------
// 5. ADMIN VIEWS AUTHOR EARNINGS RECORDS
// ---------------------------------------------------------

app.get(
    '/api/admin/codo-bills/earnings',
    dfCodoAuthenticate,
    dfCodoRequireAdmin,
    async (req, res) => {
        try {
            const snapshot = await db
                .collection('codoAuthorEarnings')
                .limit(500)
                .get();

            const records = snapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data()
            }));

            records.sort((a, b) => {
                const first = a.createdAt?.toMillis?.() || 0;
                const second = b.createdAt?.toMillis?.() || 0;
                return second - first;
            });

            res.json({
                success: true,
                records
            });

        } catch (error) {
            console.error('Admin earnings records:', error);

            res.status(500).json({
                success: false,
                error: 'Unable to load earnings records.'
            });
        }
    }
);

// ---------------------------------------------------------
// 6. ADMIN MARKS AN AUTHOR EARNING AS PAID
// ---------------------------------------------------------

app.post(
    '/api/admin/codo-bills/earnings/:earningId/mark-paid',
    dfCodoAuthenticate,
    dfCodoRequireAdmin,
    async (req, res) => {
        try {
            const earningRef = db
                .collection('codoAuthorEarnings')
                .doc(req.params.earningId);

            const snapshot = await earningRef.get();

            if (!snapshot.exists) {
                return res.status(404).json({
                    success: false,
                    error: 'Earnings record not found.'
                });
            }

            const earning = snapshot.data();

            if (earning.status === 'paid') {
                return res.status(409).json({
                    success: false,
                    error: 'This earning has already been marked as paid.'
                });
            }

            if (earning.status !== 'pending') {
                return res.status(400).json({
                    success: false,
                    error: 'Only pending earnings can be marked as paid.'
                });
            }

            const payoutReference = String(
                req.body?.payoutReference || ''
            ).trim();

            if (!payoutReference) {
                return res.status(400).json({
                    success: false,
                    error: 'Enter the payout reference.'
                });
            }

            await earningRef.update({
                status: 'paid',
                payoutReference: payoutReference.slice(0, 200),
                paidAt: dfCodoTime(),
                markedPaidBy: req.dfCodoUser.uid
            });

            res.json({
                success: true,
                message: 'Earning marked as paid.'
            });

        } catch (error) {
            console.error('Mark Codo earning paid:', error);

            res.status(500).json({
                success: false,
                error: 'Unable to update earnings record.'
            });
        }
    }
);

// ---------------------------------------------------------
// 7. ADMIN PAYMENT RECONCILIATION RECORD
// ---------------------------------------------------------

app.post(
    '/api/admin/codo-bills/reconciliation',
    dfCodoAuthenticate,
    dfCodoRequireAdmin,
    async (req, res) => {
        try {
            const {
                transactionId,
                action,
                note
            } = req.body || {};

            if (
                typeof transactionId !== 'string' ||
                !transactionId.trim() ||
                !['reviewed', 'flagged'].includes(action)
            ) {
                return res.status(400).json({
                    success: false,
                    error: 'Invalid transaction or reconciliation action.'
                });
            }

            const paymentRef = db
                .collection('codoTransactions')
                .doc(transactionId);

            const paymentSnapshot = await paymentRef.get();

            if (!paymentSnapshot.exists) {
                return res.status(404).json({
                    success: false,
                    error: 'Transaction not found.'
                });
            }

            const reconciliationRef = db
                .collection('codoReconciliation')
                .doc(transactionId);

            await reconciliationRef.set({
                transactionId,
                action,
                note: String(note || '').slice(0, 1000),
                reviewedBy: req.dfCodoUser.uid,
                reviewedAt: dfCodoTime()
            }, { merge: true });

            res.json({
                success: true,
                message: 'Reconciliation record saved.'
            });

        } catch (error) {
            console.error('Codo reconciliation:', error);

            res.status(500).json({
                success: false,
                error: 'Unable to save reconciliation record.'
            });
        }
    }
);

// ---------------------------------------------------------
// 8. ADMIN VIEWS RECONCILIATION RECORDS
// ---------------------------------------------------------

app.get(
    '/api/admin/codo-bills/reconciliation',
    dfCodoAuthenticate,
    dfCodoRequireAdmin,
    async (req, res) => {
        try {
            const snapshot = await db
                .collection('codoReconciliation')
                .limit(500)
                .get();

            const records = snapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data()
            }));

            records.sort((a, b) => {
                const first = a.reviewedAt?.toMillis?.() || 0;
                const second = b.reviewedAt?.toMillis?.() || 0;
                return second - first;
            });

            res.json({
                success: true,
                records
            });

        } catch (error) {
            console.error('Codo reconciliation records:', error);

            res.status(500).json({
                success: false,
                error: 'Unable to load reconciliation records.'
            });
        }
    }
);

// =========================================================
// END OF NEW BACKEND BATCH 3 OF 3
// =========================================================


// --- 5. START SERVER ---
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
