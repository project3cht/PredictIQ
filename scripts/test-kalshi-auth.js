/**
 * scripts/test-kalshi-auth.js
 * Standalone Kalshi credential verification — runs a single signed request
 * and prints the full response so you can confirm auth works without
 * running the full agent.
 *
 * Usage: node scripts/test-kalshi-auth.js
 */

require('dotenv').config();
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const axios  = require('axios');

const keyId   = process.env.KALSHI_KEY_ID;
const keyFile = process.env.KALSHI_KEY_FILE;

if (!keyId || !keyFile) {
  console.error('❌ Missing KALSHI_KEY_ID or KALSHI_KEY_FILE in .env');
  process.exit(1);
}

const keyPath = path.isAbsolute(keyFile)
  ? keyFile
  : path.join(__dirname, '..', keyFile);

if (!fs.existsSync(keyPath)) {
  console.error(`❌ Key file not found: ${keyPath}`);
  process.exit(1);
}

const privateKeyPem = fs.readFileSync(keyPath, 'utf8');
const keyType = privateKeyPem.split('\n')[0];
console.log(`Key type: ${keyType}`);
console.log(`Key ID:   ${keyId}`);

const timestampMs   = Date.now().toString();
const urlPath       = '/trade-api/v2/markets';
const message       = timestampMs + 'GET' + urlPath;

let signature;
try {
  const privateKeyObj = crypto.createPrivateKey({ key: privateKeyPem, format: 'pem' });
  signature = crypto.sign('sha256', Buffer.from(message), {
    key: privateKeyObj,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  });
  console.log('✅ Signing succeeded');
} catch (err) {
  console.error('❌ Signing failed:', err.message);
  process.exit(1);
}

const headers = {
  'KALSHI-ACCESS-KEY':       keyId,
  'KALSHI-ACCESS-TIMESTAMP': timestampMs,
  'KALSHI-ACCESS-SIGNATURE': signature.toString('base64'),
  'Content-Type':            'application/json',
  'Accept':                  'application/json',
};

console.log('\nSending test request to Kalshi...');

axios.get('https://api.elections.kalshi.com/trade-api/v2/markets?status=open&limit=5', {
  headers,
  timeout: 10000,
})
  .then(({ data }) => {
    console.log('✅ Auth successful!');
    console.log(`Markets returned: ${data.markets?.length ?? 0}`);
    if (data.markets?.length) {
      console.log('Sample markets:');
      data.markets.slice(0, 3).forEach(m =>
        console.log(`  ${m.ticker} — ${m.title}`)
      );
    }
  })
  .catch(err => {
    console.error('❌ Request failed');
    console.error('  Status:', err.response?.status);
    console.error('  Body:  ', JSON.stringify(err.response?.data, null, 2));
  });
