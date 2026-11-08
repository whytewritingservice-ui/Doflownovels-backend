const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

// A simple test route
app.get('/', (req, res) => {
    res.send('Doflownovels Backend is Live!');
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
