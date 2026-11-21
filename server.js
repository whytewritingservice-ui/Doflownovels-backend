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


/* =========================================================
   DOFLOWNOVELS — CHAPTER PRIVACY UPGRADE
   PRIVATE CHAPTER STORAGE AND SECURE READING
   ========================================================= */

// ---------------------------------------------------------
// A. ADMIN: CHECK WHETHER A BOOK HAS BEEN MIGRATED
// ---------------------------------------------------------

app.get(
    '/api/admin/books/:bookId/chapter-migration',
    dfCodoAuthenticate,
    dfCodoRequireAdmin,
    async (req, res) => {
        try {
            const bookRef = db.collection('books').doc(req.params.bookId);
            const privateRef = db.collection('privateBookChapters').doc(req.params.bookId);

            const [bookSnapshot, privateSnapshot] = await Promise.all([
                bookRef.get(),
                privateRef.get()
            ]);

            if (!bookSnapshot.exists) {
                return res.status(404).json({
                    success: false,
                    error: 'Book not found.'
                });
            }

            const book = bookSnapshot.data();

            res.json({
                success: true,
                bookId: req.params.bookId,
                publicChaptersPresent: Array.isArray(book.chapters),
                privateCopyPresent: privateSnapshot.exists,
                chapterCount: Array.isArray(book.chapters)
                    ? book.chapters.length
                    : (
                        privateSnapshot.exists &&
                        Array.isArray(privateSnapshot.data().chapters)
                            ? privateSnapshot.data().chapters.length
                            : 0
                    )
            });
        } catch (error) {
            console.error('Chapter migration status:', error);
            res.status(500).json({
                success: false,
                error: 'Unable to check migration status.'
            });
        }
    }
);

// ---------------------------------------------------------
// B. ADMIN: SAFELY MOVE ONE BOOK'S CHAPTERS
// ---------------------------------------------------------

app.post(
    '/api/admin/books/:bookId/migrate-chapters',
    dfCodoAuthenticate,
    dfCodoRequireAdmin,
    async (req, res) => {
        try {
            const bookId = req.params.bookId;

            const bookRef = db.collection('books').doc(bookId);
            const privateRef = db.collection('privateBookChapters').doc(bookId);

            const [bookSnapshot, privateSnapshot] = await Promise.all([
                bookRef.get(),
                privateRef.get()
            ]);

            if (!bookSnapshot.exists) {
                return res.status(404).json({
                    success: false,
                    error: 'Book not found.'
                });
            }

            if (privateSnapshot.exists) {
                return res.status(409).json({
                    success: false,
                    error: 'A private chapter copy already exists. No changes were made.'
                });
            }

            const book = bookSnapshot.data();

            if (!Array.isArray(book.chapters)) {
                return res.status(400).json({
                    success: false,
                    error: 'No public chapters found to migrate.'
                });
            }

            // Preserve every chapter field and its original array position.
            const chapters = book.chapters.map(chapter => ({
                ...chapter
            }));

            const batch = db.batch();

            // Copy chapters privately, then remove the public copy
            // in the SAME atomic Firestore batch.
            batch.set(privateRef, {
                bookId,
                authorId: book.authorId || null,
                chapters,
                migratedAt: dfCodoTime(),
                migratedBy: req.dfCodoUser.uid,
                migrationVersion: 1
            });

            batch.update(bookRef, {
                chapters: admin.firestore.FieldValue.delete(),
                chaptersPrivate: true,
                chapterCount: chapters.length,
                chaptersMigratedAt: dfCodoTime()
            });

            await batch.commit();

            res.json({
                success: true,
                message: 'Chapter content moved into private storage.',
                bookId,
                chaptersMigrated: chapters.length
            });

        } catch (error) {
            console.error('Chapter migration error:', error);

            res.status(500).json({
                success: false,
                error: 'Chapter migration failed. Check backend logs.'
            });
        }
    }
);

// ---------------------------------------------------------
// C. SECURE CHAPTER READING ENDPOINT
// ---------------------------------------------------------

app.get(
    '/api/books/:bookId/chapters',
    dfCodoAuthenticate,
    async (req, res) => {
        try {
            const uid = req.dfCodoUser.uid;
            const email = String(req.dfCodoUser.email || '').toLowerCase();

            const isPlatformAdmin =
                email === 'whytewritingservice@gmail.com';

            const bookRef = db.collection('books').doc(req.params.bookId);
            const privateRef = db.collection('privateBookChapters').doc(req.params.bookId);

            const [bookSnapshot, privateSnapshot] = await Promise.all([
                bookRef.get(),
                privateRef.get()
            ]);

            if (!bookSnapshot.exists) {
                return res.status(404).json({
                    success: false,
                    error: 'Book not found.'
                });
            }

            const book = bookSnapshot.data();

            if (!privateSnapshot.exists) {
                return res.status(409).json({
                    success: false,
                    error: 'This book has not yet been migrated to private chapter storage.'
                });
            }

            const privateData = privateSnapshot.data();
            const chapters = Array.isArray(privateData.chapters)
                ? privateData.chapters
                : [];

            const isAuthor = book.authorId === uid;

            let unlockedIndexes = [];

            if (!isPlatformAdmin && !isAuthor) {
                const accessSnapshot = await db
                    .collection('codoPackageAccess')
                    .doc(`${uid}_${req.params.bookId}`)
                    .get();

                if (accessSnapshot.exists) {
                    unlockedIndexes =
                        accessSnapshot.data().chapterIndexes || [];
                }
            }

            const safeChapters = chapters.map((chapter, index) => {
                const locked =
                    chapter.locked === true ||
                    chapter.isLocked === true;

                const canRead =
                    isPlatformAdmin ||
                    isAuthor ||
                    !locked ||
                    unlockedIndexes.includes(index);

                return {
                    index,
                    title: chapter.title || `Chapter ${index + 1}`,
                    locked,
                    content: canRead
                        ? (chapter.content || '')
                        : null,
                    hasAccess: canRead
                };
            });

            res.json({
                success: true,
                bookId: req.params.bookId,
                unlimitedAccess: isPlatformAdmin,
                chapters: safeChapters
            });

        } catch (error) {
            console.error('Secure chapter reading:', error);

            res.status(500).json({
                success: false,
                error: 'Unable to load chapters.'
            });
        }
    }
);

// =========================================================
// END CHAPTER PRIVACY UPGRADE
// =========================================================


/*
 DOFLOWNOVELS — CONSOLIDATED ADDITIVE BACKEND OVERRIDE
 Targets the current Express 4.18.2 server.js in:
 whytewritingservice-ui/Doflownovels-backend (main)

 INSTALL: Paste this entire file's contents immediately BEFORE
 the existing // --- 5. START SERVER --- line in server.js.
 Do NOT delete the existing Codo routes, Flutterwave webhook,
 admin unlock route, Firebase initialization, or app.listen.

 This patches matching existing Express route handlers in place.
 New manuscripts are stored as one Firestore document per chapter
 to avoid the Firestore 1 MiB document-size limit.
*/

(function dfInstallConsolidatedBackendOverride() {
  'use strict';

  if (globalThis.__DF_CODO_OVERRIDE_INSTALLED__) return;
  globalThis.__DF_CODO_OVERRIDE_INSTALLED__ = true;

  if (!app || !db || !admin || !app._router || !Array.isArray(app._router.stack)) {
    throw new Error('Doflow override could not locate the existing Express 4 app/router/Firebase Admin objects.');
  }

  // The existing express.json() default is 100 KB. Private manuscript publishing
  // needs a larger JSON body limit while the existing 5 MB DOCX upload cap remains.
  const dfJsonParserLayer = app._router.stack.find(layer => layer && layer.name === 'jsonParser');
  if (!dfJsonParserLayer) throw new Error('Doflow override could not locate the existing Express JSON parser.');
  dfJsonParserLayer.handle = express.json({ limit: '12mb' });

  function dfFindRoute(method, path) {
    const layer = app._router.stack.find(item =>
      item && item.route && item.route.path === path &&
      item.route.methods && item.route.methods[String(method).toLowerCase()]
    );
    if (!layer) throw new Error('Doflow override could not find existing route: ' + method + ' ' + path);
    return layer.route;
  }

  function dfReplaceRouteHandler(method, path, handler) {
    const route = dfFindRoute(method, path);
    if (!Array.isArray(route.stack) || !route.stack.length) {
      throw new Error('Doflow override found an empty route stack: ' + method + ' ' + path);
    }
    route.stack[route.stack.length - 1].handle = handler;
  }

  function dfReplaceRouteAuth(method, path, handler) {
    const route = dfFindRoute(method, path);
    if (!Array.isArray(route.stack) || !route.stack.length) {
      throw new Error('Doflow override found an empty route stack: ' + method + ' ' + path);
    }
    route.stack[0].handle = handler;
  }

  function dfOptionalFirebaseAuth(req, res, next) {
    const header = String(req.headers.authorization || '');
    if (!header) {
      req.dfCodoUser = null;
      return next();
    }
    if (!header.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'Invalid authorization header.' });
    }
    admin.auth().verifyIdToken(header.slice(7))
      .then(decoded => {
        req.dfCodoUser = decoded;
        next();
      })
      .catch(() => res.status(401).json({ success: false, error: 'Your login session is invalid or expired.' }));
  }

  function dfOverrideIsLocked(chapter) {
    return !!(chapter && (chapter.locked === true || chapter.isLocked === true || chapter.lock === true));
  }

  function dfOverrideWordCount(content) {
    const plain = String(content || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;|&#160;|&#xA0;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      .trim();
    return plain ? plain.split(/\s+/).filter(Boolean).length : 0;
  }

  function dfOverrideChapterId(chapter, index) {
    return String((chapter && (chapter.id || chapter.chapterId)) || index);
  }

  function dfOverrideChapterDocId(index) {
    return String(index).padStart(6, '0');
  }

  async function dfOverrideLoadChapterDocuments(bookId) {
    const snapshot = await db.collection('privateBookChapters')
      .doc(bookId).collection('chapters').orderBy('index').get();
    return snapshot.docs.map(doc => doc.data() || {});
  }

  async function dfOverrideDeleteChapterDocuments(bookId) {
    const collectionRef = db.collection('privateBookChapters')
      .doc(bookId).collection('chapters');
    for (;;) {
      const snapshot = await collectionRef.limit(400).get();
      if (snapshot.empty) break;
      const batch = db.batch();
      snapshot.docs.forEach(doc => batch.delete(doc.ref));
      await batch.commit();
    }
  }

  function dfOverrideError(res, error) {
    const map = {
      BOOK_NOT_FOUND: [404, 'Book not found.'],
      CHAPTERS_NOT_FOUND: [404, 'Chapter data is not available for this book.'],
      INVALID_BOOK_AUTHOR: [400, 'This book has no valid author account.'],
      AUTHOR_NOT_PARTICIPATING: [403, 'This author is not participating in Codo Bills.'],
      INVALID_CHAPTER_SELECTION: [400, 'Choose between 1 and 15 valid chapters.'],
      CHAPTER_ID_INDEX_MISMATCH: [400, 'The chapter IDs and chapter indexes do not match.'],
      CHAPTER_NOT_LOCKED: [400, 'Every selected chapter must be locked.'],
      CHAPTER_BELOW_WORD_LIMIT: [400, 'Every selected chapter must contain at least 1,200 words.'],
      CHAPTER_ALREADY_UNLOCKED: [409, 'One or more selected chapters have already been unlocked.'],
      INSUFFICIENT_BILLS: [402, 'You do not have enough Codo Bills.'],
      PAYMENT_NOT_FOUND: [404, 'Payment record not found.'],
      PAYMENT_NOT_PENDING: [409, 'This payment is not awaiting verification.'],
      PAYMENT_ID_REUSED: [409, 'This Flutterwave transaction has already been used for another payment.'],
      PAYMENT_DETAILS_MISMATCH: [400, 'Flutterwave payment details do not exactly match the checkout.']
    };
    const entry = map[error && error.message];
    if (entry) return res.status(entry[0]).json({ success: false, error: entry[1] });
    console.error('Doflow consolidated override error:', error);
    return res.status(500).json({ success: false, error: 'The request could not be completed. Please try again.' });
  }

  // ---------------------------------------------------------
  // 1. PACKAGE UNLOCK — IDs/indexes accepted; all writes atomic
  // ---------------------------------------------------------
  async function dfCorrectedUnlockPackage(req, res) {
    try {
      const uid = req.dfCodoUser.uid;
      const email = String(req.dfCodoUser.email || '').toLowerCase();
      const body = req.body || {};
      const bookId = String(body.bookId || '').trim();
      const wantedIndexes = Array.isArray(body.chapterIndexes) ? body.chapterIndexes : null;
      const wantedIds = Array.isArray(body.chapterIds) ? body.chapterIds.map(String) : null;

      if (!bookId || (!wantedIndexes && !wantedIds)) throw new Error('INVALID_CHAPTER_SELECTION');
      if ((wantedIndexes && (wantedIndexes.length < 1 || wantedIndexes.length > 15)) ||
          (wantedIds && (wantedIds.length < 1 || wantedIds.length > 15))) {
        throw new Error('INVALID_CHAPTER_SELECTION');
      }
      if (wantedIndexes && (wantedIndexes.some(v => !Number.isInteger(Number(v)) || Number(v) < 0) ||
          new Set(wantedIndexes.map(Number)).size !== wantedIndexes.length)) {
        throw new Error('INVALID_CHAPTER_SELECTION');
      }
      if (wantedIds && (wantedIds.some(v => !v.trim()) || new Set(wantedIds).size !== wantedIds.length)) {
        throw new Error('INVALID_CHAPTER_SELECTION');
      }

      // The real platform administrator has reading access without a deduction.
      if (email === 'whytewritingservice@gmail.com') {
        return res.json({ success: true, unlimitedAccess: true, billsDeducted: 0, message: 'Administrator unlimited reading access.' });
      }

      const settings = await dfCodoGetSettings();
      if (!settings.enabled) return res.status(403).json({ success: false, error: 'Codo Bills are temporarily disabled.' });

      const bookRef = db.collection('books').doc(bookId);
      const privateRef = db.collection('privateBookChapters').doc(bookId);
      const walletRef = db.collection('codoWallets').doc(uid);
      const accessRef = db.collection('codoPackageAccess').doc(uid + '_' + bookId);

      // A stable ID makes a repeat request for the exact same package idempotent.
      const canonicalSelection = (wantedIndexes ? wantedIndexes.map(Number) : wantedIds.slice()).map(String).sort().join('|');
      const idempotencyHash = dfCodoCrypto.createHash('sha256')
        .update(uid + '|' + bookId + '|' + canonicalSelection)
        .digest('hex');
      const transactionId = 'unlock_' + idempotencyHash;
      const transactionRef = db.collection('codoTransactions').doc(transactionId);
      const earningRef = db.collection('codoAuthorEarnings').doc(transactionId);

      const outcome = await db.runTransaction(async tx => {
        const [bookSnap, privateSnap, walletSnap, accessSnap, priorTxSnap] = await Promise.all([
          tx.get(bookRef), tx.get(privateRef), tx.get(walletRef), tx.get(accessRef), tx.get(transactionRef)
        ]);
        if (!bookSnap.exists) throw new Error('BOOK_NOT_FOUND');
        const book = bookSnap.data() || {};
        const chapterSource = privateSnap.exists ? (privateSnap.data() || {}) : book;
        let chapters = Array.isArray(chapterSource.chapters) ? chapterSource.chapters : [];
        if (!chapters.length && privateSnap.exists) {
          const chapterDocs = await tx.get(
            privateRef.collection('chapters').orderBy('index')
          );
          chapters = chapterDocs.docs.map(doc => doc.data() || {});
        }
        if (!chapters.length) throw new Error('CHAPTERS_NOT_FOUND');
        const authorId = book.authorId || chapterSource.authorId;
        if (!authorId) throw new Error('INVALID_BOOK_AUTHOR');

        const authorRef = db.collection('authors').doc(authorId);
        const authorSnap = await tx.get(authorRef);
        if (!authorSnap.exists || authorSnap.data().codoEnabled !== true) throw new Error('AUTHOR_NOT_PARTICIPATING');

        let indexes;
        if (wantedIndexes) {
          indexes = wantedIndexes.map(Number);
        } else {
          indexes = wantedIds.map(id => chapters.findIndex((chapter, index) => dfOverrideChapterId(chapter, index) === id));
        }
        if (indexes.length < 1 || indexes.length > 15 || indexes.some(i => !Number.isInteger(i) || i < 0 || i >= chapters.length) || new Set(indexes).size !== indexes.length) {
          throw new Error('INVALID_CHAPTER_SELECTION');
        }
        const resolvedIds = indexes.map(i => dfOverrideChapterId(chapters[i], i));
        if (wantedIds && (resolvedIds.length !== wantedIds.length || resolvedIds.some(id => !wantedIds.includes(id)))) {
          throw new Error('CHAPTER_ID_INDEX_MISMATCH');
        }
        if (wantedIndexes && wantedIds && wantedIndexes.length !== wantedIds.length) throw new Error('CHAPTER_ID_INDEX_MISMATCH');

        // If this exact package has already committed, acknowledge it without charging again.
        if (priorTxSnap.exists && priorTxSnap.data().status === 'successful') {
          const wallet = walletSnap.exists ? walletSnap.data() : {};
          return {
            alreadyProcessed: true,
            indexes,
            purchasedBills: Number(wallet.purchasedBills || 0),
            awardedBills: Number(wallet.awardedBills || 0),
            billSource: priorTxSnap.data().billSource || 'unknown',
            awardFundingSource: priorTxSnap.data().awardFundingSource || null
          };
        }

        const existing = accessSnap.exists ? (accessSnap.data() || {}) : {};
        const existingIndexes = Array.isArray(existing.chapterIndexes) ? existing.chapterIndexes : [];
        if (indexes.some(i => existingIndexes.includes(i))) throw new Error('CHAPTER_ALREADY_UNLOCKED');

        for (const index of indexes) {
          const chapter = chapters[index];
          if (!dfOverrideIsLocked(chapter)) throw new Error('CHAPTER_NOT_LOCKED');
          if (dfOverrideWordCount(chapter.content) < 1200) throw new Error('CHAPTER_BELOW_WORD_LIMIT');
        }

        const wallet = walletSnap.exists ? (walletSnap.data() || {}) : {};
        const purchased = Math.max(0, Number(wallet.purchasedBills || 0));
        const awarded = Math.max(0, Number(wallet.awardedBills || 0));
        if (purchased + awarded < 1) throw new Error('INSUFFICIENT_BILLS');

        const usePurchased = purchased > 0;
        const nextPurchased = usePurchased ? purchased - 1 : purchased;
        const nextAwarded = usePurchased ? awarded : awarded - 1;
        const awardedBySource = Object.assign({ doflow: 0, contest_sponsor: 0, author: 0 }, wallet.awardedBySource || {});
        const knownAwarded = Number(awardedBySource.doflow || 0) + Number(awardedBySource.contest_sponsor || 0) + Number(awardedBySource.author || 0);
        const legacyAwarded = Math.max(0, awarded - knownAwarded);
        if (legacyAwarded) awardedBySource.legacy_unattributed = legacyAwarded;
        let awardFundingSource = null;
        if (!usePurchased) {
          const sourceOrder = ['doflow', 'contest_sponsor', 'author', 'legacy_unattributed'];
          awardFundingSource = sourceOrder.find(source => Number(awardedBySource[source] || 0) > 0) || 'legacy_unattributed';
          awardedBySource[awardFundingSource] = Math.max(0, Number(awardedBySource[awardFundingSource] || 0) - 1);
        }
        const billValueGBP = usePurchased ? Number(settings.billPriceGBP) : 0;
        const authorShareGBP = usePurchased ? dfCodoRoundMoney(billValueGBP * 0.70) : 0;
        const platformShareGBP = usePurchased ? dfCodoRoundMoney(billValueGBP * 0.30) : 0;

        // Every read is complete before any write in this transaction.
        tx.set(walletRef, { uid, purchasedBills: nextPurchased, awardedBills: nextAwarded, awardedBySource, updatedAt: dfCodoTime() }, { merge: true });
        tx.set(accessRef, {
          uid, bookId, authorId,
          chapterIndexes: Array.from(new Set(existingIndexes.concat(indexes))).sort((a, b) => a - b),
          updatedAt: dfCodoTime()
        }, { merge: true });
        tx.set(transactionRef, {
          uid, bookId, authorId, type: 'package_unlock', chapterIndexes: indexes,
          chapterIds: resolvedIds, chapterCount: indexes.length, billsSpent: 1,
          billSource: usePurchased ? 'purchased' : 'awarded', awardFundingSource,
          authorShareGBP, platformShareGBP, status: 'successful', createdAt: dfCodoTime()
        });
        // Cash earnings are created atomically only for purchased bills.
        // Promotional/awarded bills do not create cash earnings in this policy.
        if (usePurchased) {
          tx.set(earningRef, {
            authorId, readerUid: uid, bookId, transactionId,
            authorShareGBP, platformShareGBP, status: 'pending', createdAt: dfCodoTime()
          });
        }
        return {
          alreadyProcessed: false, indexes, purchasedBills: nextPurchased, awardedBills: nextAwarded,
          billSource: usePurchased ? 'purchased' : 'awarded', awardFundingSource, authorShareGBP, platformShareGBP
        };
      });

      return res.json({
        success: true,
        alreadyProcessed: outcome.alreadyProcessed,
        bookId,
        unlockedChapters: outcome.indexes,
        billsDeducted: outcome.alreadyProcessed ? 0 : 1,
        billSource: outcome.billSource,
        awardFundingSource: outcome.awardFundingSource || null,
        transactionId,
        wallet: { purchasedBills: outcome.purchasedBills, awardedBills: outcome.awardedBills },
        message: outcome.alreadyProcessed ? 'This package was already unlocked; no extra bill was deducted.' : 'Chapter package unlocked successfully.'
      });
    } catch (error) {
      return dfOverrideError(res, error);
    }
  }

  // ---------------------------------------------------------
  // 2. PAYMENT VERIFICATION — exact amount/currency + replay guard
  // ---------------------------------------------------------
  async function dfCorrectedVerifyPayment(req, res) {
    try {
      const uid = req.dfCodoUser.uid;
      const { transactionId, txRef } = req.body || {};
      if (!transactionId || typeof txRef !== 'string' || !txRef.startsWith('codo_' + uid + '_')) {
        return res.status(400).json({ success: false, error: 'A valid payment transaction ID and your own payment reference are required.' });
      }
      if (!process.env.FLW_SECRET_KEY) return res.status(503).json({ success: false, error: 'Flutterwave is not configured.' });

      const paymentRef = db.collection('codoTransactions').doc(txRef);
      const initialSnap = await paymentRef.get();
      if (!initialSnap.exists) throw new Error('PAYMENT_NOT_FOUND');
      const initial = initialSnap.data() || {};
      if (initial.uid !== uid || initial.type !== 'bill_purchase') return res.status(403).json({ success: false, error: 'Payment ownership check failed.' });
      if (initial.status === 'successful') return res.json({ success: true, alreadyProcessed: true, bills: Number(initial.bundle || 0) });
      if (initial.status !== 'pending') throw new Error('PAYMENT_NOT_PENDING');

      const verifyResponse = await fetch('https://api.flutterwave.com/v3/transactions/' + encodeURIComponent(transactionId) + '/verify', {
        method: 'GET',
        headers: { Authorization: 'Bearer ' + process.env.FLW_SECRET_KEY, 'Content-Type': 'application/json' }
      });
      const verifyResult = await verifyResponse.json();
      const paid = verifyResult && verifyResult.data;
      const actualAmount = Number(paid && paid.amount);
      const expectedAmount = Number(initial.amount);
      const actualCurrency = String((paid && paid.currency) || '').toUpperCase();
      const expectedCurrency = String(initial.currency || '').toUpperCase();
      const actualEmail = String((paid && paid.customer && paid.customer.email) || '').toLowerCase();
      const expectedEmail = String(initial.email || '').toLowerCase();
      const idMatches = !paid || paid.id == null || String(paid.id) === String(transactionId);
      const metaUidMatches = !paid || !paid.meta || !paid.meta.uid || paid.meta.uid === uid;
      if (!verifyResponse.ok || !verifyResult || verifyResult.status !== 'success' || !paid ||
          paid.status !== 'successful' || paid.tx_ref !== txRef || !idMatches || !metaUidMatches ||
          !Number.isFinite(actualAmount) || Math.round(actualAmount * 100) !== Math.round(expectedAmount * 100) ||
          actualCurrency !== expectedCurrency || actualEmail !== expectedEmail) {
        throw new Error('PAYMENT_DETAILS_MISMATCH');
      }

      const walletRef = db.collection('codoWallets').doc(uid);
      const processorRef = db.collection('codoFlutterwaveTransactions').doc(String(transactionId));

      const result = await db.runTransaction(async tx => {
        const [currentPaymentSnap, walletSnap, processorSnap] = await Promise.all([
          tx.get(paymentRef), tx.get(walletRef), tx.get(processorRef)
        ]);
        if (!currentPaymentSnap.exists) throw new Error('PAYMENT_NOT_FOUND');
        const current = currentPaymentSnap.data() || {};
        if (current.uid !== uid || current.type !== 'bill_purchase') throw new Error('PAYMENT_DETAILS_MISMATCH');
        if (current.status === 'successful') return { alreadyProcessed: true, bills: Number(current.bundle || 0) };
        if (current.status !== 'pending') throw new Error('PAYMENT_NOT_PENDING');
        if (processorSnap.exists) {
          const claimed = processorSnap.data() || {};
          if (claimed.txRef !== txRef || claimed.uid !== uid) throw new Error('PAYMENT_ID_REUSED');
          throw new Error('PAYMENT_NOT_PENDING');
        }
        const wallet = walletSnap.exists ? (walletSnap.data() || {}) : {};
        const bills = Number(current.bundle);
        if (!Number.isInteger(bills) || ![1, 3, 5, 10].includes(bills)) throw new Error('PAYMENT_DETAILS_MISMATCH');
        tx.set(walletRef, {
          uid,
          purchasedBills: Number(wallet.purchasedBills || 0) + bills,
          awardedBills: Number(wallet.awardedBills || 0),
          updatedAt: dfCodoTime()
        }, { merge: true });
        tx.update(paymentRef, {
          status: 'successful',
          flutterwaveTransactionId: String(transactionId),
          verifiedAmount: actualAmount,
          verifiedCurrency: actualCurrency,
          verifiedAt: dfCodoTime()
        });
        tx.set(processorRef, { uid, txRef, amount: actualAmount, currency: actualCurrency, createdAt: dfCodoTime() });
        return { alreadyProcessed: false, bills };
      });

      return res.json({ success: true, alreadyProcessed: result.alreadyProcessed, bills: result.bills, message: result.alreadyProcessed ? 'Payment was already credited.' : 'Payment verified and Codo Bills added.' });
    } catch (error) {
      if (error && error.message === 'PAYMENT_DETAILS_MISMATCH') {
        return res.status(400).json({ success: false, error: 'Payment details did not exactly match the checkout. No bills were credited.' });
      }
      return dfOverrideError(res, error);
    }
  }

  // ---------------------------------------------------------
  // 3. SECURE READER — public visitors can read free chapters
  // ---------------------------------------------------------
  async function dfCorrectedReadChapters(req, res) {
    try {
      const bookId = req.params.bookId;
      const uid = req.dfCodoUser ? req.dfCodoUser.uid : null;
      const email = String(req.dfCodoUser && req.dfCodoUser.email || '').toLowerCase();
      const isAdmin = email === 'whytewritingservice@gmail.com';
      const bookRef = db.collection('books').doc(bookId);
      const privateRef = db.collection('privateBookChapters').doc(bookId);
      const [bookSnap, privateSnap] = await Promise.all([bookRef.get(), privateRef.get()]);
      if (!bookSnap.exists) return res.status(404).json({ success: false, error: 'Book not found.' });
      const book = bookSnap.data() || {};
      const source = privateSnap.exists ? (privateSnap.data() || {}) : book;
      let chapters = Array.isArray(source.chapters) ? source.chapters : [];
      if (!chapters.length && privateSnap.exists) {
        chapters = await dfOverrideLoadChapterDocuments(bookId);
      }
      if (!chapters.length) return res.status(404).json({ success: false, error: 'No chapter content is available for this book.' });
      const isAuthor = !!uid && book.authorId === uid;
      let unlockedIndexes = [];
      if (uid && !isAdmin && !isAuthor) {
        const accessSnap = await db.collection('codoPackageAccess').doc(uid + '_' + bookId).get();
        if (accessSnap.exists && Array.isArray(accessSnap.data().chapterIndexes)) unlockedIndexes = accessSnap.data().chapterIndexes;
      }
      const safeChapters = chapters.map((chapter, index) => {
        const locked = dfOverrideIsLocked(chapter);
        const hasAccess = isAdmin || isAuthor || !locked || unlockedIndexes.includes(index);
        return {
          id: dfOverrideChapterId(chapter, index),
          index,
          title: chapter.title || 'Chapter ' + (index + 1),
          locked,
          wordCount: dfOverrideWordCount(chapter.content),
          hasAccess,
          content: hasAccess ? String(chapter.content || '') : null
        };
      });
      return res.json({
        success: true,
        bookId,
        unlimitedAccess: isAdmin,
        chapters: safeChapters,
        chaptersPrivate: !!privateSnap.exists,
        privacyEnforced: !!privateSnap.exists
      });
    } catch (error) {
      console.error('Doflow secure reader override:', error);
      return res.status(500).json({ success: false, error: 'Unable to load chapters.' });
    }
  }

  // ---------------------------------------------------------
  // 4. OPTIONAL-LOGIN ACCESS LOOKUP (anonymous = no paid access)
  // ---------------------------------------------------------
  async function dfCorrectedAccessLookup(req, res) {
    try {
      const uid = req.dfCodoUser ? req.dfCodoUser.uid : null;
      const email = String(req.dfCodoUser && req.dfCodoUser.email || '').toLowerCase();
      if (email === 'whytewritingservice@gmail.com') {
        return res.json({ success: true, unlimitedAccess: true, chapterIndexes: [] });
      }
      if (!uid) return res.json({ success: true, unlimitedAccess: false, chapterIndexes: [] });
      const snap = await db.collection('codoPackageAccess').doc(uid + '_' + req.params.bookId).get();
      const data = snap.exists ? snap.data() : {};
      return res.json({ success: true, unlimitedAccess: false, chapterIndexes: Array.isArray(data.chapterIndexes) ? data.chapterIndexes : [] });
    } catch (error) {
      console.error('Doflow access lookup override:', error);
      return res.status(500).json({ success: false, error: 'Unable to check chapter access.' });
    }
  }

  // ---------------------------------------------------------
  // 5. MARK-PAID — atomic status transition prevents double payout
  // ---------------------------------------------------------
  async function dfCorrectedMarkEarningPaid(req, res) {
    try {
      const payoutReference = String(req.body && req.body.payoutReference || '').trim();
      if (!payoutReference) return res.status(400).json({ success: false, error: 'Enter the payout reference.' });
      const earningRef = db.collection('codoAuthorEarnings').doc(req.params.earningId);
      const result = await db.runTransaction(async tx => {
        const snap = await tx.get(earningRef);
        if (!snap.exists) return 'NOT_FOUND';
        const earning = snap.data() || {};
        if (earning.status === 'paid') return 'ALREADY_PAID';
        if (earning.status !== 'pending') return 'NOT_PENDING';
        tx.update(earningRef, {
          status: 'paid', payoutReference: payoutReference.slice(0, 200),
          paidAt: dfCodoTime(), markedPaidBy: req.dfCodoUser.uid
        });
        return 'PAID';
      });
      if (result === 'NOT_FOUND') return res.status(404).json({ success: false, error: 'Earnings record not found.' });
      if (result === 'ALREADY_PAID') return res.status(409).json({ success: false, error: 'This earning has already been marked as paid.' });
      if (result === 'NOT_PENDING') return res.status(400).json({ success: false, error: 'Only pending earnings can be marked as paid.' });
      return res.json({ success: true, message: 'Earning marked as paid.' });
    } catch (error) {
      console.error('Doflow mark-paid override:', error);
      return res.status(500).json({ success: false, error: 'Unable to update earnings record.' });
    }
  }



  // ---------------------------------------------------------
  // 5A. PRIVATE BOOK PUBLISHING — metadata public, manuscript private
  // ---------------------------------------------------------

      }
      const safeChapters = chapters.map((ch, index) => ({
        id: String(ch.id || ch.chapterId || index),
        chapterId: String(ch.chapterId || ch.id || index),
        index,
        title: String(ch.title || ('Chapter ' + (index + 1))).slice(0, 200),
        content: ch.content,
        locked: dfOverrideIsLocked(ch),
        isLocked: dfOverrideIsLocked(ch)
      }));
      // Firestore documents are limited to 1 MiB. Leave headroom for document metadata.
      const oversizedIndex = safeChapters.findIndex(ch => Buffer.byteLength(JSON.stringify(ch), 'utf8') > 850000);
      if (oversizedIndex !== -1) {
        return res.status(413).json({ success: false, error: 'Chapter ' + (oversizedIndex + 1) + ' is too large to store safely. Split that chapter into smaller chapters and upload again.' });
      }

      const authorRef = db.collection('authors').doc(uid);
      const authorSnap = await authorRef.get();
      if (!authorSnap.exists || authorSnap.data().isPro !== true) {
        return res.status(403).json({ success: false, error: 'Verified author status is required to publish.' });
      }
      const existing = await db.collection('books').where('penName', '==', penName).get();
      const takenByOther = existing.docs.some(doc => (doc.data() || {}).authorId !== uid);
      if (takenByOther) return res.status(409).json({ success: false, error: 'That pen name is already in use by another author.' });

      createdBookRef = db.collection('books').doc();
      createdPrivateRef = db.collection('privateBookChapters').doc(createdBookRef.id);

      // Create private metadata first, then store each chapter in its own document.
      // The public book record is not created until all chapter writes succeed.
      await createdPrivateRef.set({
        bookId: createdBookRef.id,
        authorId: uid,
        chapterCount: safeChapters.length,
        storageMode: 'chapter_documents',
        migrationVersion: 2,
        createdAt: dfCodoTime()
      });

      for (let offset = 0; offset < safeChapters.length; offset += 400) {
        const batch = db.batch();
        safeChapters.slice(offset, offset + 400).forEach(chapter => {
          const chapterRef = createdPrivateRef.collection('chapters')
            .doc(dfOverrideChapterDocId(chapter.index));
          batch.set(chapterRef, chapter);
        });
        await batch.commit();
      }

      const batch = db.batch();
      batch.set(createdBookRef, {
        authorId: uid,
        authorName: String(req.dfCodoUser.name || authorSnap.data().displayName || ''),
        penName,
        title,
        cover,
        color: String(body.color || '#8b5cf6'),
        vibe: String(body.vibe || 'none'),
        tipLink: String(body.tipLink || ''),
        views: 0,
        clicks: 0,
        vibeActive: true,
        chaptersPrivate: true,
        chapterCount: safeChapters.length,
        createdAt: dfCodoTime()
      });
      batch.set(authorRef, {
        email: String(req.dfCodoUser.email || authorSnap.data().email || ''),
        displayName: String(req.dfCodoUser.name || authorSnap.data().displayName || ''),
        penName
      }, { merge: true });
      await batch.commit();
      return res.json({ success: true, bookId: createdBookRef.id, message: 'Book published with private chapter-by-chapter storage.' });
    } catch (error) {
      console.error('Private book publishing:', error);
      if (createdPrivateRef) {
        try {
          await dfOverrideDeleteChapterDocuments(createdPrivateRef.id);
          await createdPrivateRef.delete();
        } catch (cleanupError) {
          console.error('Private chapter cleanup after failed publish:', cleanupError);
        }
      }
      if (createdBookRef) {
        try { await createdBookRef.delete(); } catch (_) {}
      }
      return res.status(500).json({ success: false, error: 'Unable to publish the book. Check the chapter sizes and try again.' });
    }
  });

  // ---------------------------------------------------------
  // 5B. BOOK DELETE — removes public metadata and private manuscript
  // ---------------------------------------------------------
  app.post('/api/author/books/:bookId/delete', dfCodoAuthenticate, async (req, res) => {
    try {
      const uid = req.dfCodoUser.uid;
      const email = String(req.dfCodoUser.email || '').toLowerCase();
      const bookRef = db.collection('books').doc(req.params.bookId);
      const privateRef = db.collection('privateBookChapters').doc(req.params.bookId);
      const [bookSnap, privateSnap] = await Promise.all([bookRef.get(), privateRef.get()]);
      if (!bookSnap.exists) return res.status(404).json({ success: false, error: 'Book not found.' });
      const book = bookSnap.data() || {};
      if (book.authorId !== uid && email !== 'whytewritingservice@gmail.com') {
        return res.status(403).json({ success: false, error: 'You are not allowed to delete this book.' });
      }
      // Delete private chapter documents first; support both the new subcollection
      // format and the earlier single-document chapters array.
      await dfOverrideDeleteChapterDocuments(req.params.bookId);
      const batch = db.batch();
      batch.delete(bookRef);
      if (privateSnap.exists) batch.delete(privateRef);
      await batch.commit();
      return res.json({ success: true, message: 'Book and private manuscript deleted.' });
    } catch (error) {
      console.error('Book deletion override:', error);
      return res.status(500).json({ success: false, error: 'Unable to delete this book.' });
    }
  });

  // ---------------------------------------------------------
  // 6. PUBLIC CODO SETTINGS — only safe display configuration
  // ---------------------------------------------------------
  app.get('/api/codo-bills/public-settings', async (req, res) => {
    try {
      const settings = await dfCodoGetSettings();
      return res.json({
        success: true,
        settings: {
          enabled: settings.enabled,
          billPriceGBP: settings.billPriceGBP,
          currencyRates: settings.currencyRates,
          bundles: [1, 3, 5, 10]
        }
      });
    } catch (error) {
      console.error('Public Codo settings:', error);
      return res.status(500).json({ success: false, error: 'Unable to load Codo Bill settings.' });
    }
  });

  async function dfReadAllDocuments(collectionRef, whereField, whereValue) {
    const results = [];
    let last = null;
    for (;;) {
      let query = collectionRef;
      if (whereField) query = query.where(whereField, '==', whereValue);
      query = query.orderBy(admin.firestore.FieldPath.documentId()).limit(500);
      if (last) query = query.startAfter(last);
      const page = await query.get();
      if (page.empty) break;
      results.push(...page.docs);
      if (page.size < 500) break;
      last = page.docs[page.docs.length - 1];
    }
    return results;
  }

  // Award route: retain totals and a funding-source ledger in the wallet.
  async function dfCorrectedAwardBills(req, res) {
    try {
      const { readerUid, bills, source, reason } = req.body || {};
      const amount = Number(bills);
      const allowed = ['doflow', 'contest_sponsor', 'author'];
      if (typeof readerUid !== 'string' || !readerUid.trim() || !Number.isInteger(amount) || amount < 1 || amount > 10000 || !allowed.includes(source)) {
        return res.status(400).json({ success: false, error: 'Invalid reader, bill amount or award source.' });
      }
      const walletRef = db.collection('codoWallets').doc(readerUid);
      const awardRef = db.collection('codoTransactions').doc();
      await db.runTransaction(async tx => {
        const snap = await tx.get(walletRef);

        const wallet = snap.exists ? (snap.data() || {}) : {};
        const bySource = Object.assign({ doflow: 0, contest_sponsor: 0, author: 0 }, wallet.awardedBySource || {});
        const oldAwarded = Number(wallet.awardedBills || 0);
        const known = Number(bySource.doflow || 0) + Number(bySource.contest_sponsor || 0) + Number(bySource.author || 0);
        if (oldAwarded > known) bySource.legacy_unattributed = Math.max(Number(bySource.legacy_unattributed || 0), oldAwarded - known);
        bySource[source] = Number(bySource[source] || 0) + amount;
        tx.set(walletRef, {
          uid: readerUid,
          purchasedBills: Number(wallet.purchasedBills || 0),
          awardedBills: oldAwarded + amount,
          awardedBySource: bySource,
          updatedAt: dfCodoTime()
        }, { merge: true });
        tx.set(awardRef, {
          uid: readerUid, type: 'bill_award', source, billsAwarded: amount,
          remainingBills: amount,
          reason: String(reason || 'Codo Bill award').slice(0, 500),
          status: 'successful', awardedBy: req.dfCodoUser.uid, createdAt: dfCodoTime()
        });
      });
      return res.json({ success: true, message: amount + ' Codo Bills awarded.', awardId: awardRef.id });
    } catch (error) {
      console.error('Codo award override:', error);
      return res.status(500).json({ success: false, error: 'Unable to award Codo Bills.' });
    }
  }

  async function dfCorrectedAwardHistory(req, res) {
    try {
      const docs = await dfReadAllDocuments(db.collection('codoTransactions'));
      const awards = docs.filter(doc => { const d = doc.data() || {}; return d.uid === req.dfCodoUser.uid && d.type === 'bill_award'; }).map(doc => ({ id: doc.id, ...doc.data() }));
      awards.sort((a, b) => (b.createdAt && b.createdAt.toMillis ? b.createdAt.toMillis() : 0) - (a.createdAt && a.createdAt.toMillis ? a.createdAt.toMillis() : 0));
      return res.json({ success: true, awards });
    } catch (error) {
      console.error('Codo award history override:', error);
      return res.status(500).json({ success: false, error: 'Unable to load award history.' });
    }
  }

  async function dfCorrectedAuthorEarnings(req, res) {
    try {
      const authorId = req.dfCodoUser.uid;
      const authorSnap = await db.collection('authors').doc(authorId).get();
      if (!authorSnap.exists) return res.status(404).json({ success: false, error: 'Author account not found.' });
      const docs = await dfReadAllDocuments(db.collection('codoAuthorEarnings'));
      const earnings = docs.filter(doc => (doc.data() || {}).authorId === authorId).map(doc => ({ id: doc.id, ...doc.data() }));
      let totalGBP = 0, pendingGBP = 0, paidGBP = 0;
      earnings.forEach(item => {
        const amount = Number(item.authorShareGBP || 0);
        totalGBP += amount;
        if (item.status === 'paid') paidGBP += amount;
        else if (item.status === 'pending') pendingGBP += amount;
      });
      earnings.sort((a, b) => (b.createdAt && b.createdAt.toMillis ? b.createdAt.toMillis() : 0) - (a.createdAt && a.createdAt.toMillis ? a.createdAt.toMillis() : 0));
      return res.json({ success: true, earnings: { totalGBP: dfCodoRoundMoney(totalGBP), pendingGBP: dfCodoRoundMoney(pendingGBP), paidGBP: dfCodoRoundMoney(paidGBP) }, transactions: earnings });
    } catch (error) {
      console.error('Author Codo earnings override:', error);
      return res.status(500).json({ success: false, error: 'Unable to load author earnings.' });
    }
  }

  async function dfCorrectedAdminEarnings(req, res) {
    try {
      const docs = await dfReadAllDocuments(db.collection('codoAuthorEarnings'));
      const records = docs.map(doc => ({ id: doc.id, ...doc.data() }));
      records.sort((a, b) => (b.createdAt && b.createdAt.toMillis ? b.createdAt.toMillis() : 0) - (a.createdAt && a.createdAt.toMillis ? a.createdAt.toMillis() : 0));
      return res.json({ success: true, records });
    } catch (error) {
      console.error('Admin Codo earnings override:', error);
      return res.status(500).json({ success: false, error: 'Unable to load earnings records.' });
    }
  }

  async function dfCorrectedFinance(req, res) {
    try {
      const [paymentDocs, earningDocs, walletDocs] = await Promise.all([
        dfReadAllDocuments(db.collection('codoTransactions'), 'type', 'bill_purchase'),
        dfReadAllDocuments(db.collection('codoAuthorEarnings')),
        dfReadAllDocuments(db.collection('codoWallets'))
      ]);
      let successfulPayments = 0, pendingPayments = 0, grossPaymentsGBP = 0;
      paymentDocs.forEach(doc => {
        const item = doc.data() || {};
        if (item.status === 'successful') {
          successfulPayments++;
          grossPaymentsGBP += Number(item.bundle || 0) * Number(item.billPriceGBP || 1);
        } else if (item.status === 'pending') pendingPayments++;
      });
      let pendingAuthorGBP = 0, paidAuthorGBP = 0, platformShareGBP = 0;
      earningDocs.forEach(doc => {
        const item = doc.data() || {};
        const authorAmount = Number(item.authorShareGBP || 0);
        platformShareGBP += Number(item.platformShareGBP || 0);
        if (item.status === 'paid') paidAuthorGBP += authorAmount;
        else if (item.status === 'pending') pendingAuthorGBP += authorAmount;
      });
      let purchasedBillsOutstanding = 0, awardedBillsOutstanding = 0;
      walletDocs.forEach(doc => {
        const wallet = doc.data() || {};
        purchasedBillsOutstanding += Number(wallet.purchasedBills || 0);
        awardedBillsOutstanding += Number(wallet.awardedBills || 0);
      });
      return res.json({ success: true, finance: {
        successfulPayments, pendingPayments,
        grossPaymentsGBP: dfCodoRoundMoney(grossPaymentsGBP),
        pendingAuthorGBP: dfCodoRoundMoney(pendingAuthorGBP),
        paidAuthorGBP: dfCodoRoundMoney(paidAuthorGBP),
        recordedPlatformShareGBP: dfCodoRoundMoney(platformShareGBP),
        purchasedBillsOutstanding, awardedBillsOutstanding,
        recordsIncluded: { payments: paymentDocs.length, earnings: earningDocs.length, wallets: walletDocs.length },
        note: 'All stored records are included. Figures are gross of Flutterwave/processor fees and external settlement adjustments.'
      } });
    } catch (error) {
      console.error('Codo finance override:', error);
      return res.status(500).json({ success: false, error: 'Unable to load Codo finance summary.' });
    }
  }

  // Patch the existing routes, preserving their existing authentication middleware
  // except where anonymous public reading is explicitly required.
  dfReplaceRouteHandler('post', '/api/codo-bills/unlock-package', dfCorrectedUnlockPackage);
  dfReplaceRouteHandler('post', '/api/codo-bills/verify-payment', dfCorrectedVerifyPayment);
  dfReplaceRouteHandler('get', '/api/books/:bookId/chapters', dfCorrectedReadChapters);
  dfReplaceRouteHandler('get', '/api/codo-bills/access/:bookId', dfCorrectedAccessLookup);
  dfReplaceRouteHandler('post', '/api/admin/codo-bills/earnings/:earningId/mark-paid', dfCorrectedMarkEarningPaid);
  dfReplaceRouteHandler('post', '/api/admin/codo-bills/award', dfCorrectedAwardBills);
  dfReplaceRouteHandler('get', '/api/codo-bills/awards', dfCorrectedAwardHistory);
  dfReplaceRouteHandler('get', '/api/codo-bills/author/earnings', dfCorrectedAuthorEarnings);
  dfReplaceRouteHandler('get', '/api/admin/codo-bills/earnings', dfCorrectedAdminEarnings);
  dfReplaceRouteHandler('get', '/api/admin/codo-bills/finance', dfCorrectedFinance);
  dfReplaceRouteAuth('get', '/api/books/:bookId/chapters', dfOptionalFirebaseAuth);
  dfReplaceRouteAuth('get', '/api/codo-bills/access/:bookId', dfOptionalFirebaseAuth);

  console.log('Doflownovels consolidated override installed: Codo Bills routes patched; private chapter documents enabled; original webhooks/admin unlock/server startup preserved.');
})();


// --- 5. START SERVER ---
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
