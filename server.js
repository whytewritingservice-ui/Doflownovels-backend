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

// --- 5. START SERVER ---
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
