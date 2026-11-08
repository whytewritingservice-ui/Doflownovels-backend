const express = require('express');
const admin = require('firebase-admin');
const axios = require('axios');

const app = express();

// ⚠️ IMPORTANT: You must set these environment variables on Render
const FLW_SECRET_HASH = process.env.FLW_SECRET_HASH; // The secret you create in Flutterwave
const FLW_SECRET_KEY = process.env.FLW_SECRET_KEY; // Your Flutterwave live secret key

// --- Firebase Admin Setup ---
// This reads the JSON key from the environment variable we will set on Render
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// --- The Webhook Endpoint ---
// Flutterwave will send a POST request to this URL when a payment is made
app.post('/flutterwave-webhook', async (req, res) => {
  // 1. Verify the request is genuinely from Flutterwave
  const signature = req.headers['verif-hash'];
  if (!signature || signature !== FLW_SECRET_HASH) {
    return res.status(401).send('Unauthorized');
  }

  const payload = req.body;
  const { event, data } = payload;

  // 2. Check for a successful charge
  if (event === 'charge.completed' && data.status === 'successful') {
    try {
      // 3. Re-verify the transaction with Flutterwave to be 100% scam-proof
      const verifyResponse = await axios.get(
        `https://api.flutterwave.com/v3/transactions/${data.id}/verify`,
        { headers: { Authorization: `Bearer ${FLW_SECRET_KEY}` } }
      );

      const verification = verifyResponse.data;

      // 4. Ensure the amount matches what you expect (£50)
      if (verification.status === 'success' && verification.data.amount >= 50) {
        const userId = data.meta.userId; // The user ID we will pass from the frontend

        if (userId) {
          // 5. Unlock the user's account by setting a custom claim
          await admin.auth().setCustomUserClaims(userId, { isPro: true });
          console.log(`User ${userId} upgraded successfully!`);
        }
      }
    } catch (error) {
      console.error('Verification failed:', error.message);
    }
  }

  // 6. Always return a 200 OK so Flutterwave knows you received the webhook
  res.status(200).send('Webhook received');
});

// A simple test route to check if the server is alive
app.get('/', (req, res) => {
  res.send('Doflownovels Backend is Live!');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
