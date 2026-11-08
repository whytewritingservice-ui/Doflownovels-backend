const express = require('express');
const admin = require('firebase-admin');
const axios = require('axios');

const app = express();

// We need this to parse the JSON body sent by Domco Hub
app.use(express.json());

const FLW_SECRET_HASH = process.env.FLW_SECRET_HASH; 
const FLW_SECRET_KEY = process.env.FLW_SECRET_KEY; 

// --- Firebase Admin Setup ---
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// --- The Receiver Endpoint ---
app.post('/flutterwave-webhook', async (req, res) => {
  // 1. Check the secret hash (Domco Hub will pass this along)
  const signature = req.headers['verif-hash'];
  if (!signature || signature !== FLW_SECRET_HASH) {
    return res.status(401).send('Unauthorized');
  }

  const payload = req.body;
  const { event, data } = payload;

  // 2. Ensure this is a Doflownovels payment (just in case)
  if (data && data.tx_ref && data.tx_ref.startsWith('doflow_')) {
    
    if (event === 'charge.completed' && data.status === 'successful') {
      try {
        // 3. Re-verify the transaction with Flutterwave to be 100% scam-proof
        const verifyResponse = await axios.get(
          `https://api.flutterwave.com/v3/transactions/${data.id}/verify`,
          { headers: { Authorization: `Bearer ${FLW_SECRET_KEY}` } }
        );

        const verification = verifyResponse.data;

        // 4. Ensure the amount is correct (£50)
        if (verification.status === 'success' && verification.data.amount >= 50) {
          const userId = data.meta.userId; // The user ID passed from the frontend

          if (userId) {
            // 5. Unlock the author's account
            await admin.auth().setCustomUserClaims(userId, { isPro: true });
            console.log(`Success: User ${userId} upgraded to Pro!`);
          }
        }
      } catch (error) {
        console.error('Verification failed:', error.message);
      }
    }
  }

  // Always return 200 OK
  res.status(200).send('Webhook received');
});

// A simple test route to check if the server is alive
app.get('/', (req, res) => {
  res.send('Doflownovels Backend is Live and Listening!');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
