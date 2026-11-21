require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { BakongKHQR, khqrData, IndividualInfo } = require('bakong-khqr');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const BAKONG_API_URL = process.env.BAKONG_API_URL || 'https://api-bakong.nbc.gov.kh/v1';
const BAKONG_TOKEN = process.env.BAKONG_TOKEN || '';
const BAKONG_ACCOUNT_ID = process.env.BAKONG_ACCOUNT_ID || 'mon_samnang@bkrt';
const MERCHANT_NAME = process.env.MERCHANT_NAME || 'KHMERACC';
const MERCHANT_CITY = process.env.MERCHANT_CITY || 'Phnom Penh';
const MERCHANT_PHONE = process.env.MERCHANT_PHONE || '85519275144';

// Account inventory unlocked ONLY after Bakong confirms payment (responseCode === 0)
const ACCOUNT_STOCK = {
  'netflix-1m': {
    title: 'Netflix Premium (4K UHD) • 1 ខែ',
    priceUsd: 2.50,
    credentials: {
      email: 'khmeracc.netflix1@example.com',
      password: 'SetRealPassword123!',
      note: 'Profile 1 • PIN: 1122'
    }
  },
  'spotify-1m': {
    title: 'Spotify Premium • 1 ខែ',
    priceUsd: 2.00,
    credentials: {
      email: 'khmeracc.spotify1@example.com',
      password: 'SetRealPassword123!',
      note: 'Individual Slot'
    }
  },
  'chatgpt-1m': {
    title: 'ChatGPT Plus • 1 ខែ',
    priceUsd: 6.50,
    credentials: {
      email: 'khmeracc.gpt1@example.com',
      password: 'SetRealPassword123!',
      note: 'Plus Subscription'
    }
  }
};

const orders = new Map();

app.get('/health', (_req, res) => {
  res.json({ ok: true, merchant: MERCHANT_NAME });
});

app.post('/api/create-payment', (req, res) => {
  try {
    const { itemId, title, amountUsd } = req.body || {};
    const stockItem = itemId && ACCOUNT_STOCK[itemId] ? ACCOUNT_STOCK[itemId] : null;
    const finalAmount = Number(stockItem ? stockItem.priceUsd : amountUsd);

    if (!Number.isFinite(finalAmount) || finalAmount <= 0) {
      return res.status(400).json({ success: false, error: 'ចំនួនទឹកប្រាក់ USD មិនត្រឹមត្រូវ' });
    }

    const billNumber = 'KACC' + Date.now().toString().slice(-8);
    const expirationTimestamp = Date.now() + 15 * 60 * 1000;

    const optionalData = {
      currency: khqrData.currency.usd,
      amount: Number(finalAmount.toFixed(2)),
      billNumber,
      mobileNumber: MERCHANT_PHONE,
      storeLabel: MERCHANT_NAME,
      terminalLabel: 'KHMERACC-WEB',
      expirationTimestamp
    };

    const individualInfo = new IndividualInfo(
      BAKONG_ACCOUNT_ID,
      MERCHANT_NAME,
      MERCHANT_CITY,
      optionalData
    );

    const khqr = new BakongKHQR();
    const generated = khqr.generateIndividual(individualInfo);

    if (!generated || !generated.data || !generated.data.qr) {
      return res.status(500).json({ success: false, error: 'បង្កើត KHQR មិនបានជោគជ័យ' });
    }

    const qrString = generated.data.qr;
    const md5 = crypto.createHash('md5').update(qrString).digest('hex');
    const orderId = 'ORD-' + crypto.randomBytes(4).toString('hex').toUpperCase();

    orders.set(orderId, {
      orderId,
      itemId: itemId || 'custom',
      title: title || (stockItem ? stockItem.title : 'KHMERACC Order'),
      amountUsd: Number(finalAmount.toFixed(2)),
      currency: 'USD',
      billNumber,
      qrString,
      md5,
      status: 'PENDING',
      createdAt: Date.now()
    });

    return res.json({
      success: true,
      orderId,
      merchantName: MERCHANT_NAME,
      amountUsd: Number(finalAmount.toFixed(2)),
      currency: 'USD',
      qrString,
      md5
    });
  } catch (err) {
    console.error('create-payment error:', err);
    return res.status(500).json({ success: false, error: 'មានបញ្ហាក្នុងការបង្កើតការទូទាត់' });
  }
});

app.post('/api/check-payment', async (req, res) => {
  try {
    const { orderId, md5 } = req.body || {};
    const order = orderId ? orders.get(orderId) : null;
    const targetMd5 = md5 || (order && order.md5);

    if (!targetMd5) {
      return res.status(400).json({ paid: false, error: 'ខ្វះ MD5 សម្រាប់ផ្ទៀងផ្ទាត់' });
    }

    if (!BAKONG_TOKEN) {
      return res.status(500).json({ paid: false, error: 'មិនទាន់កំណត់ BAKONG_TOKEN ក្នុង .env' });
    }

    const apiResponse = await fetch(`${BAKONG_API_URL}/check_transaction_by_md5`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${BAKONG_TOKEN}`
      },
      body: JSON.stringify({ md5: targetMd5 })
    });

    const bakongJson = await apiResponse.json();
    const isConfirmed =
      bakongJson &&
      bakongJson.responseCode === 0 &&
      bakongJson.data &&
      bakongJson.data.currency === 'USD' &&
      Number(bakongJson.data.amount || 0) >= (order ? order.amountUsd : 0);

    if (isConfirmed) {
      if (order) {
        order.status = 'PAID';
        order.paidAt = new Date().toISOString();
        order.txHash = bakongJson.data.hash || '';
      }

      const stockEntry = order && ACCOUNT_STOCK[order.itemId];
      return res.json({
        paid: true,
        status: 'PAID',
        amountUsd: Number(bakongJson.data.amount),
        txHash: bakongJson.data.hash || '',
        credentials: stockEntry
          ? stockEntry.credentials
          : {
              info: 'ការទូទាត់បានបញ្ជាក់ជោគជ័យ! សូមទាក់ទង Admin ដើម្បីទទួលអាខោន។'
            }
      });
    }

    return res.json({
      paid: false,
      status: 'PENDING'
    });
  } catch (err) {
    console.error('check-payment error:', err);
    return res.status(500).json({ paid: false, error: 'មិនអាចភ្ជាប់ទៅ Bakong Open API បានទេ' });
  }
});

app.listen(PORT, () => {
  console.log(`KHMERACC Backend running on http://localhost:${PORT}`);
});
