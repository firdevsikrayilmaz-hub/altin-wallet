import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import sqlite3 from 'sqlite3';
import puppeteer from 'puppeteer';

const app = express();
app.use(cors());
app.use(express.json());

// Veritabanı
const db = new sqlite3.Database('./database.sqlite');

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS investments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    gold_type TEXT NOT NULL,
    trade_type TEXT NOT NULL,
    amount REAL NOT NULL,
    buy_price REAL NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

// ============================================
// PUPPETEER - HIZLI MOD
// ============================================
let latestPrices = {};
let browser = null;
let page = null;

async function initBrowser() {
  if (browser) return;
  console.log('🌐 Chrome başlatılıyor...');
  browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  page = await browser.newPage();
  console.log('✅ Chrome hazır');
}

async function fetchFromHaremAltin() {
  try {
    if (!browser) await initBrowser();
    
    if (!page) {
      page = await browser.newPage();
    }
    
    console.log('⏳ Harem Altın güncelleniyor...');
    
    // Sayfayı yenile (yeni sayfa açmaktan çok daha hızlı)
    await page.goto('https://canlipiyasalar.haremaltin.com/', {
      waitUntil: 'networkidle0',
      timeout: 15000
    });
    
    // 2 saniye bekle (verilerin yüklenmesi için)
    await new Promise(r => setTimeout(r, 2000));
    
    // Verileri çek
    const prices = await page.evaluate(() => {
      const data = {};
      
      // Tüm tablo satırlarını tara
      document.querySelectorAll('table tr').forEach(row => {
        const cells = row.querySelectorAll('td');
        if (cells.length >= 3) {
          const name = cells[0].innerText.trim();
          const buyText = cells[1].innerText.trim().replace(/\./g, '').replace(',', '.');
          const sellText = cells[2].innerText.trim().replace(/\./g, '').replace(',', '.');
          const changeText = cells[3] ? cells[3].innerText.trim() : '';
          
          const buy = parseFloat(buyText) || 0;
          const sell = parseFloat(sellText) || 0;
          
          if (name && name.length > 1 && (buy > 0 || sell > 0)) {
            // Key oluştur - boşluk ve özel karakterleri temizle
            let key = name.toLowerCase()
              .replace(/ı/g, 'i').replace(/ğ/g, 'g').replace(/ü/g, 'u')
              .replace(/ş/g, 's').replace(/ö/g, 'o').replace(/ç/g, 'c')
              .replace(/[^a-z0-9]/g, '');
            
            data[key] = { name, buy, sell, change: changeText };
          }
        }
      });
      
      return data;
    });
    
    if (Object.keys(prices).length > 0) {
      latestPrices = prices;
      console.log('✅ Fiyatlar güncellendi:', Object.keys(prices).join(', '));
    } else {
      console.log('⚠️ Veri bulunamadı');
    }
    
  } catch (e) {
    console.log('❌ Hata:', e.message);
  }
}

// İlk çekim
fetchFromHaremAltin();
// Her 5 saniyede tekrar çek (çok daha hızlı!)
setInterval(fetchFromHaremAltin, 5000);

// ============================================
// GİRİŞ KONTROLÜ (TOKEN)
// ============================================
function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Giriş yapmalısın' });
  
  try {
    const decoded = jwt.verify(token, 'GIZLI_ANAHTAR_123');
    req.userId = decoded.userId;
    next();
  } catch {
    res.status(403).json({ error: 'Geçersiz token' });
  }
}

// ============================================
// KAYIT OL
// ============================================
app.post('/api/register', (req, res) => {
  const { email, password } = req.body;
  const hash = bcrypt.hashSync(password, 10);
  
  db.run('INSERT INTO users (email, password) VALUES (?, ?)', [email, hash], function(err) {
    if (err) return res.status(400).json({ error: 'Bu e-posta zaten var' });
    res.json({ id: this.lastID, email });
  });
});

// ============================================
// GİRİŞ YAP
// ============================================
app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  
  db.get('SELECT * FROM users WHERE email = ?', [email], (err, user) => {
    if (!user || !bcrypt.compareSync(password, user.password)) {
      return res.status(401).json({ error: 'E-posta veya şifre hatalı' });
    }
    const token = jwt.sign({ userId: user.id }, 'GIZLI_ANAHTAR_123');
    res.json({ token, email: user.email });
  });
});

// ============================================
// YATIRIM EKLE
// ============================================
app.post('/api/investments', auth, (req, res) => {
  const { goldType, tradeType, amount, price } = req.body;
  
  db.run(
    'INSERT INTO investments (user_id, gold_type, trade_type, amount, buy_price) VALUES (?, ?, ?, ?, ?)',
    [req.userId, goldType, tradeType, amount, price],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: this.lastID });
    }
  );
});

// ============================================
// PORTFÖYÜ GETİR
// ============================================
app.get('/api/portfolio', auth, (req, res) => {
  db.all('SELECT * FROM investments WHERE user_id = ?', [req.userId], (err, rows) => {
    let totalInvested = 0;
    let totalCurrent = 0;
    
    const list = rows.map(inv => {
      // Key'i normalize et (frontend'deki ile aynı)
      let key = inv.gold_type.toLowerCase()
        .replace(/ı/g, 'i').replace(/ğ/g, 'g').replace(/ü/g, 'u')
        .replace(/ş/g, 's').replace(/ö/g, 'o').replace(/ç/g, 'c')
        .replace(/[^a-z0-9]/g, '');
      
      const p = latestPrices[key] || { sell: 0 };
      const currentPrice = p.sell;
      const invested = inv.amount * inv.buy_price;
      const current = inv.amount * currentPrice;
      
      let pnl, pnlPercent;
      if (inv.trade_type === 'buy') {
        pnl = current - invested;
        pnlPercent = inv.buy_price > 0 ? ((currentPrice - inv.buy_price) / inv.buy_price) * 100 : 0;
      } else {
        pnl = invested - current;
        pnlPercent = inv.buy_price > 0 ? ((inv.buy_price - currentPrice) / inv.buy_price) * 100 : 0;
      }
      
      totalInvested += invested;
      totalCurrent += current;
      
      return { ...inv, currentPrice, invested, current, pnl, pnlPercent };
    });
    
    res.json({
      investments: list,
      summary: { totalInvested, totalCurrent, totalPnL: totalCurrent - totalInvested }
    });
  });
});

// ============================================
// YATIRIM SİL
// ============================================
app.delete('/api/investments/:id', auth, (req, res) => {
  db.run('DELETE FROM investments WHERE id = ? AND user_id = ?', [req.params.id, req.userId]);
  res.json({ ok: true });
});

// ============================================
// CANLI FİYATLARI VER
// ============================================
app.get('/api/prices', (req, res) => {
  res.json(latestPrices);
});

// ============================================
// SUNUCUYU BAŞLAT
// ============================================
app.listen(3001, () => {
  console.log('🚀 Sunucu http://localhost:3001 adresinde çalışıyor');
  console.log('⏳ Harem Altın verileri her 5 saniyede güncellenecek...');
});