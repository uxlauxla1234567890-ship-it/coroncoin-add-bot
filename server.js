const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DB_FILE = path.join(__dirname, 'db.json');
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const COIN_PER_AD = 5;
const COIN_TO_TON = 0.00001; // 500 coin = 0.005 TON
const MIN_WITHDRAW_TON = 0.5;

function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ users: {}, withdrawals: [] }, null, 2));
  }
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function verifyTelegramData(initData) {
  if (!BOT_TOKEN) return { ok: true, user: { id: 'test_user' } }; // dev mode
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    params.delete('hash');
    const dataCheckArr = [];
    for (const [key, value] of [...params.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      dataCheckArr.push(`${key}=${value}`);
    }
    const dataCheckString = dataCheckArr.join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    if (computedHash !== hash) return { ok: false };
    const user = JSON.parse(params.get('user') || '{}');
    return { ok: true, user };
  } catch (e) {
    return { ok: false };
  }
}

function sendJSON(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Static files
  if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
    let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
    filePath = path.join(__dirname, 'public', filePath);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath);
      const contentType = ext === '.html' ? 'text/html' : ext === '.js' ? 'application/javascript' : ext === '.css' ? 'text/css' : 'text/plain';
      res.writeHead(200, { 'Content-Type': contentType });
      fs.createReadStream(filePath).pipe(res);
      return;
    }
    sendJSON(res, 404, { error: 'not found' });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/watch-ad') {
    const body = await readBody(req);
    const auth = verifyTelegramData(body.initData);
    if (!auth.ok) return sendJSON(res, 401, { error: 'invalid auth' });
    const userId = String(auth.user.id);
    const db = loadDB();
    if (!db.users[userId]) db.users[userId] = { balance: 0, totalViews: 0 };
    db.users[userId].balance += COIN_PER_AD;
    db.users[userId].totalViews += 1;
    saveDB(db);
    return sendJSON(res, 200, { balance: db.users[userId].balance });
  }

  if (req.method === 'GET' && url.pathname === '/api/balance') {
    const initData = url.searchParams.get('initData');
    const auth = verifyTelegramData(initData);
    if (!auth.ok) return sendJSON(res, 401, { error: 'invalid auth' });
    const userId = String(auth.user.id);
    const db = loadDB();
    const balance = db.users[userId] ? db.users[userId].balance : 0;
    return sendJSON(res, 200, { balance });
  }

  if (req.method === 'POST' && url.pathname === '/api/withdraw') {
    const body = await readBody(req);
    const auth = verifyTelegramData(body.initData);
    if (!auth.ok) return sendJSON(res, 401, { error: 'invalid auth' });
    const userId = String(auth.user.id);
    const db = loadDB();
    const user = db.users[userId];
    if (!user) return sendJSON(res, 400, { error: 'no balance' });

    const tonAddress = (body.tonAddress || '').trim();
    const isValidTon = /^[EU]Q[A-Za-z0-9_-]{46}$/.test(tonAddress);
    if (!isValidTon) return sendJSON(res, 400, { error: 'Tonkeeper manzili noto\'g\'ri' });

    const tonAmount = user.balance * COIN_TO_TON;
    if (tonAmount < MIN_WITHDRAW_TON) {
      return sendJSON(res, 400, { error: `Minimal chiqarish: ${MIN_WITHDRAW_TON} TON` });
    }

    db.withdrawals.push({
      id: crypto.randomUUID(),
      userId,
      coinAmount: user.balance,
      tonAmount,
      tonAddress,
      status: 'pending',
      createdAt: new Date().toISOString()
    });
    user.balance = 0;
    saveDB(db);
    return sendJSON(res, 200, { ok: true, tonAmount });
  }

  sendJSON(res, 404, { error: 'not found' });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
