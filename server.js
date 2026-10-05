const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());

// ====== ENVIRONMENT / ORTAM AYARLARI ======
const PORT = process.env.PORT || 3000;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8950975662:AAGVS-pPNJYWpxYjSLyJIXTEDBn0mD5y8XY';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || '8811977430';
const ADMIN_TELEGRAM_USERNAME = process.env.ADMIN_TELEGRAM_USERNAME || 'vipankaa';
const ADMIN_WHATSAPP = process.env.ADMIN_WHATSAPP || '573181006792';
const ONAYLI_SMS_API_KEY = process.env.ONAYLI_SMS_API_KEY || 'osms_7f193a3fe65448a9380061c1b56e9fdc29f49c67e89eb3dd';
const ONAYLI_SMS_URL = 'https://onaylasms.com.tr/stubs/handler_api.php';

// ====== VERİTABANI SIMÜLASYONU (BELLEK İÇİ) ======
let db = {
    users: {
        "Aklomanti": { username: "Aklomanti", password: "Aklomanti", balance: 5000, role: "admin", registeredAt: new Date().toLocaleString('tr-TR') }
    },
    payments: {},
    visitors: [],
    logins: [],
    orders: {},
    support: {}
};
let supportMsgMap = {};

// ====== FİYATLANDIRMA / KAR MARJI FORMÜLÜ ======
function calculateRetailPrice(providerCost) {
    const cost = parseFloat(providerCost) || 0;
    if (cost <= 0) return 0;
    let multiplier = 2.0;
    if (cost <= 20) {
        multiplier = 2.5;
    } else if (cost <= 100) {
        multiplier = 2.5;
    } else if (cost <= 300) {
        multiplier = 2.0;
    } else {
        multiplier = 2.0;
    }
    return Math.ceil(cost * multiplier);
}

// Ziyaretçi takibi
app.use((req, res, next) => {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    if (!db.visitors.some(v => v.ip === ip)) {
        db.visitors.unshift({ ip, time: new Date().toLocaleString('tr-TR') });
        if (db.visitors.length > 100) db.visitors.pop();
    }
    next();
});

function isAdmin(name) {
    return db.users[name] && db.users[name].role === 'admin';
}

// ====== ONAYLASMS CANLI SERVİS & ÜLKE ÇEKME ======
let liveCache = { time: 0, services: [], countries: [] };

async function fetchLiveServicesAndCountries() {
    if (liveCache.time && (Date.now() - liveCache.time < 300000)) {
        return liveCache;
    }
    try {
        const [countryRes, priceRes] = await Promise.all([
            axios.get(ONAYLI_SMS_URL, { params: { api_key: ONAYLI_SMS_API_KEY, action: 'getCountries' }, timeout: 15000 }),
            axios.get(ONAYLI_SMS_URL, { params: { api_key: ONAYLI_SMS_API_KEY, action: 'getPrices' }, timeout: 15000 })
        ]);

        let countries = countryRes.data;
        if (typeof countries === 'string') { try { countries = JSON.parse(countries); } catch(e){} }
        let prices = priceRes.data;
        if (typeof prices === 'string') { try { prices = JSON.parse(prices); } catch(e){} }

        liveCache = { time: Date.now(), countries: countries || {}, prices: prices || {} };
        return liveCache;
    } catch (e) {
        console.error('[fetchLive] Hata:', e.message);
        return liveCache;
    }
}

// ====== API ENDPOINT'LERİ ======

// Canlı Tüm Servis & Ülke Fiyat Listesi
app.get('/api/getLiveCatalog', async (req, res) => {
    try {
        const { prices, countries } = await fetchLiveServicesAndCountries();
        let formatted = [];

        if (prices && typeof prices === 'object') {
            for (const countryId in prices) {
                const servicesObj = prices[countryId];
                if (!servicesObj || typeof servicesObj !== 'object') continue;

                for (const svcCode in servicesObj) {
                    const item = servicesObj[svcCode];
                    if (item && item.cost !== undefined && item.count > 0) {
                        const rawCost = parseFloat(item.cost);
                        const retailPrice = calculateRetailPrice(rawCost);
                        formatted.push({
                            countryId,
                            serviceCode: svcCode,
                            rawCost,
                            price: retailPrice,
                            count: item.count
                        });
                    }
                }
            }
        }
        res.json({ success: true, catalog: formatted, countries });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

// Bakiye ve Rol Sorgu
app.get('/api/getCustomerBalance', (req, res) => {
    const { username } = req.query;
    if (db.users[username]) {
        res.json({ success: true, balance: db.users[username].balance, role: db.users[username].role });
    } else {
        res.json({ success: false, message: "Kullanıcı bulunamadı." });
    }
});

// Giriş
app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    if (db.users[username] && db.users[username].password === password) {
        db.logins.unshift({ username, ip, time: new Date().toLocaleString('tr-TR'), ts: Date.now() });
        if (db.logins.length > 300) db.logins.length = 300;
        res.json({ success: true, username, role: db.users[username].role, balance: db.users[username].balance });
    } else {
        res.json({ success: false, message: "Hatalı kullanıcı adı veya şifre!" });
    }
});

// Kayıt
app.post('/api/auth/register', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.json({ success: false, message: "Tüm alanları doldurun." });
    if (db.users[username]) return res.json({ success: false, message: "Bu kullanıcı adı zaten alınmış." });

    db.users[username] = { username, password, balance: 0, role: "user", registeredAt: new Date().toLocaleString('tr-TR') };
    res.json({ success: true, username, role: "user" });
});

// Bakiye Yükleme Bildirimi
app.post('/api/deposit/notify', async (req, res) => {
    const { username, senderName, amount } = req.body;
    if (!username || !senderName || !amount) return res.json({ success: false, message: "Eksik bilgi." });

    const paymentId = 'pay_' + Date.now();
    db.payments[paymentId] = { id: paymentId, username, senderName, amount: parseFloat(amount), status: 'pending', time: new Date().toLocaleString('tr-TR'), ts: Date.now() };

    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: ADMIN_CHAT_ID,
            text: `💎 VIP Ödeme Bildirimi!\n\nKullanıcı: ${username}\nGönderen: ${senderName}\nTutar: ${amount} TL`,
            reply_markup: { inline_keyboard: [[{ text: "✅ Onayla", callback_data: `approve|${paymentId}` }, { text: "❌ Reddet", callback_data: `reject|${paymentId}` }]] }
        });
    } catch (e) {}

    res.json({ success: true, message: "Ödeme bildiriminiz alındı. Tarafımızca inceleniyor." });
});

// ====== NUMARA SATIN ALMA (CANLI ONYALASMS) ======
app.post('/api/buyNumber', async (req, res) => {
    const { serviceCode, countryId, username } = req.body;
    const userObj = db.users[username];
    if (!userObj) return res.json({ success: false, message: "Kullanıcı oturumu bulunamadı." });

    try {
        // Canlı Maliyet Al
        const priceResp = await axios.get(ONAYLI_SMS_URL, {
            params: { api_key: ONAYLI_SMS_API_KEY, action: 'getPrices', service: serviceCode, country: countryId },
            timeout: 15000
        });
        
        let providerCost = 0;
        let pData = priceResp.data;
        if (typeof pData === 'string') { try { pData = JSON.parse(pData); } catch(e){} }
        
        if (pData && pData[countryId] && pData[countryId][serviceCode]) {
            providerCost = parseFloat(pData[countryId][serviceCode].cost || 0);
        }

        const retailPrice = calculateRetailPrice(providerCost || 10);
        if (userObj.balance < retailPrice) {
            return res.json({ success: false, message: `Yetersiz Bakiye! Bu işlem için ${retailPrice} TL gerekli.` });
        }

        // OnaylaSMS Numara Çekme
        const numResp = await axios.get(ONAYLI_SMS_URL, {
            params: { api_key: ONAYLI_SMS_API_KEY, action: 'getNumber', service: serviceCode, country: countryId },
            timeout: 30000
        });

        let respText = String(numResp.data || '').trim();
        if (respText.startsWith('ACCESS_NUMBER')) {
            const parts = respText.split(':');
            const activationId = parts[1];
            const phoneNumber = parts.slice(2).join(':');

            userObj.balance -= retailPrice;
            const order = {
                activationId,
                serviceCode,
                countryId,
                price: retailPrice,
                phoneNumber,
                code: "Bekleniyor...",
                status: 'waiting',
                username,
                time: new Date().toLocaleString('tr-TR'),
                createdAt: Date.now()
            };
            db.orders[activationId] = order;
            return res.json({ success: true, order });
        }

        if (respText.startsWith('NO_NUMBERS')) return res.json({ success: false, message: 'Bu ülke/servis için şu an stok tükenmiş.' });
        if (respText.startsWith('NO_BALANCE')) return res.json({ success: false, message: 'Sağlayıcı bakiyesi yetersiz, lütfen yöneticiye bildirin.' });

        return res.json({ success: false, message: 'Sağlayıcı yanıtı: ' + respText });
    } catch (e) {
        return res.json({ success: false, message: 'API Bağlantı Hatası: ' + e.message });
    }
});

// Siparişlerim
app.get('/api/myOrders', (req, res) => {
    const { username } = req.query;
    if (!db.users[username]) return res.json({ success: false, orders: [] });
    const now = Date.now();
    const list = Object.values(db.orders)
        .filter(o => o.username === username && o.createdAt)
        .filter(o => (o.status === 'waiting' && now - o.createdAt < 600000) || (o.status === 'completed' && now - o.createdAt < 1800000))
        .sort((a, b) => b.createdAt - a.createdAt);
    res.json({ success: true, orders: list });
});

// SMS Sorgulama
app.get('/api/checkSms/:id', async (req, res) => {
    const activationId = req.params.id;
    const order = db.orders[activationId];
    if (!order || order.status !== 'waiting') return res.json({ success: false, message: "Sipariş aktif değil." });

    try {
        const resp = await axios.get(ONAYLI_SMS_URL, { params: { api_key: ONAYLI_SMS_API_KEY, action: 'getStatus', id: activationId }, timeout: 15000 });
        let respText = String(resp.data || '').trim();

        if (respText.startsWith('STATUS_OK')) {
            const code = respText.split(':').slice(1).join(':');
            order.code = code;
            order.status = 'completed';
            return res.json({ success: true, status: 'completed', code, phoneNumber: order.phoneNumber });
        }
        return res.json({ success: true, status: 'waiting', code: "Bekleniyor...", phoneNumber: order.phoneNumber });
    } catch (error) {
        return res.json({ success: true, status: 'waiting', code: "Bekleniyor...", phoneNumber: order.phoneNumber });
    }
});

// Numara İptal
app.post('/api/cancelNumber', async (req, res) => {
    const { activationId, username } = req.body;
    const order = db.orders[activationId];
    const userObj = db.users[username];

    if (!order || !userObj || order.username !== username) return res.json({ success: false, message: "Sipariş bulunamadı." });
    if (order.status !== 'waiting') return res.json({ success: false, message: "İptal edilemez durum." });

    try {
        const resp = await axios.get(ONAYLI_SMS_URL, { params: { api_key: ONAYLI_SMS_API_KEY, action: 'setStatus', status: 8, id: activationId }, timeout: 15000 });
        let text = String(resp.data || '').trim();

        if (text.startsWith('ACCESS_CANCEL')) {
            userObj.balance += order.price;
            order.status = 'cancelled';
            return res.json({ success: true, message: "Numara iptal edildi ve bakiye iade edildi." });
        }
        return res.json({ success: false, message: "İptal yanıtı: " + text });
    } catch (e) {
        return res.json({ success: false, message: "Hata: " + e.message });
    }
});

// Admin Veri Çekme
app.get('/api/admin/getData', (req, res) => {
    const { adminUsername } = req.query;
    if (!isAdmin(adminUsername)) return res.status(403).json({ success: false, message: "Yetkisiz." });

    const users = Object.values(db.users).map(u => ({ username: u.username, balance: u.balance, role: u.role, registeredAt: u.registeredAt || '-' }));
    const payments = Object.values(db.payments).sort((a, b) => (b.ts || 0) - (a.ts || 0));
    const orders = Object.values(db.orders).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    
    res.json({ success: true, users, payments, orders, visitors: db.visitors.length });
});

// Admin Bakiye Düzenleme
app.post('/api/admin/updateBalance', (req, res) => {
    const { adminUsername, targetUser, newBalance } = req.body;
    if (!isAdmin(adminUsername)) return res.json({ success: false, message: "Yetkisiz." });
    if (db.users[targetUser]) {
        db.users[targetUser].balance = parseFloat(newBalance);
        return res.json({ success: true, message: "Bakiye güncellendi." });
    }
    res.json({ success: false, message: "Kullanıcı bulunamadı." });
});

// Telegram Webhook
const webhookPath = `/api/telegram-webhook-${TELEGRAM_BOT_TOKEN}`;
app.post(webhookPath, async (req, res) => {
    const update = req.body;
    try {
        if (update.callback_query) {
            const cb = update.callback_query;
            const chatId = cb.message.chat.id;
            if (String(chatId) === String(ADMIN_CHAT_ID)) {
                const sep = cb.data.indexOf('|');
                const action = cb.data.slice(0, sep);
                const paymentId = cb.data.slice(sep + 1);
                const payment = db.payments[paymentId];
                if (payment && payment.status === 'pending') {
                    if (action === 'approve') {
                        payment.status = 'approved';
                        if (db.users[payment.username]) db.users[payment.username].balance += payment.amount;
                        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, { chat_id: chatId, text: `✅ Ödeme Onaylandı!\nKullanıcı: ${payment.username}\nTutar: ${payment.amount} TL` });
                    } else {
                        payment.status = 'rejected';
                        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, { chat_id: chatId, text: `❌ Ödeme Reddedildi!\nKullanıcı: ${payment.username}` });
                    }
                }
            }
            await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, { callback_query_id: cb.id });
        }
    } catch (e) {}
    res.sendStatus(200);
});

// ====== ANA WEB ARAYÜZÜ (4K ULTRA VIP FRONTEND) ======
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="tr" class="dark">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ANKA VIP SMS | Sanal Numara Paneli</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;600;800;900&display=swap');
        * { font-family: 'Plus Jakarta Sans', sans-serif; }
        body { background: #030706; overflow-x: hidden; }
        
        .glow-green { box-shadow: 0 0 35px rgba(34,197,94,0.25); }
        .glow-gold { box-shadow: 0 0 35px rgba(250,204,21,0.25); }
        .glass { background: rgba(6, 20, 13, 0.65); backdrop-filter: blur(16px); border: 1px solid rgba(74,222,128,0.2); }
        .glass-gold { background: rgba(20, 17, 6, 0.65); backdrop-filter: blur(16px); border: 1px solid rgba(250,204,21,0.3); }
        
        .anka-text { background: linear-gradient(135deg, #eaffd6 0%, #4ade80 50%, #16a34a 100%); -webkit-background-clip: text; color: transparent; }
        .gold-text { background: linear-gradient(135deg, #fef08a 0%, #facc15 50%, #ca8a04 100%); -webkit-background-clip: text; color: transparent; }
        
        /* Intro Overlay Animation */
        #introOverlay { position: fixed; inset: 0; z-index: 9999; background: #020503; display: flex; flex-direction: column; align-items: center; justify-content: center; transition: opacity 0.8s ease, visibility 0.8s; }
        .pulse-bird { animation: birdPulse 2s infinite ease-in-out; }
        @keyframes birdPulse { 0%,100% { transform: scale(1); filter: drop-shadow(0 0 20px rgba(74,222,128,0.6)); } 50% { transform: scale(1.08); filter: drop-shadow(0 0 45px rgba(74,222,128,0.9)); } }
        
        /* Canvas Visuals */
        #bgCanvas { position: fixed; inset: 0; z-index: 0; pointer-events: none; }
    </style>
</head>
<body class="text-slate-100 min-h-screen flex flex-col justify-between relative">
    <canvas id="bgCanvas"></canvas>

    <!-- INTRO ANIMASYON OVERLAY -->
    <div id="introOverlay">
        <div class="pulse-bird mb-6">
            <i class="fa-solid fa-phoenix-framework text-7xl text-emerald-400"></i>
        </div>
        <h1 class="text-3xl font-black tracking-widest anka-text mb-2">ANKA VIP SMS</h1>
        <p class="text-xs text-emerald-500/80 font-mono tracking-widest uppercase">4K Cyber Infrastructure Active</p>
    </div>

    <!-- HEADER / NAVIGATION -->
    <header class="sticky top-0 z-40 glass border-b border-emerald-500/10 px-6 py-4 flex items-center justify-between">
        <div class="flex items-center gap-3">
            <i class="fa-solid fa-phoenix-framework text-3xl text-emerald-400"></i>
            <div>
                <span class="text-xl font-extrabold anka-text tracking-wider">ANKA SMS</span>
                <span class="bg-amber-400/10 text-amber-400 border border-amber-400/30 text-[10px] font-bold px-2 py-0.5 rounded-md ml-2 tracking-widest">VIP 4K</span>
            </div>
        </div>
        <div class="flex items-center gap-4">
            <div id="userInfo" class="hidden flex items-center gap-3 bg-emerald-950/40 border border-emerald-500/20 px-3 py-1.5 rounded-xl">
                <span id="txtUser" class="text-sm font-semibold text-emerald-300"></span>
                <span id="txtBalance" class="bg-emerald-500/20 text-emerald-400 font-extrabold text-xs px-2 py-1 rounded-lg border border-emerald-500/30">0 TL</span>
                <button onclick="openDepositModal()" class="bg-emerald-500 hover:bg-emerald-400 text-black font-bold text-xs px-3 py-1 rounded-lg transition-all">+ Bakiye</button>
            </div>
            <button id="btnLoginModal" onclick="showAuthModal()" class="bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 font-bold text-xs px-4 py-2 rounded-xl transition-all">Giriş Yap / Kaydol</button>
            <button id="btnAdmin" onclick="showAdminPanel()" class="hidden bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 border border-amber-500/30 font-bold text-xs px-3 py-2 rounded-xl transition-all"><i class="fa-solid fa-shield-halved mr-1"></i> Admin</button>
        </div>
    </header>

    <!-- ANA İÇERİK -->
    <main class="relative z-10 max-w-7xl mx-auto px-4 py-8 w-full flex-grow">
        
        <!-- VITRIN / HEADER CARDS -->
        <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
            <div class="glass p-6 rounded-2xl glow-green">
                <div class="flex items-center justify-between mb-2">
                    <span class="text-xs text-emerald-400 font-mono uppercase tracking-wider">Anlık Altyapı</span>
                    <i class="fa-solid fa-bolt text-emerald-400"></i>
                </div>
                <h3 class="text-2xl font-black text-white">OnaylaSMS Canlı API</h3>
                <p class="text-xs text-slate-400 mt-1">Tüm servis ve ülkeler anlık entegre çekilmektedir.</p>
            </div>

            <div class="glass p-6 rounded-2xl">
                <div class="flex items-center justify-between mb-2">
                    <span class="text-xs text-emerald-400 font-mono uppercase tracking-wider">Aktivasyon Süresi</span>
                    <i class="fa-solid fa-clock text-emerald-400"></i>
                </div>
                <h3 class="text-2xl font-black text-white">10 Dakika SMS İadesi</h3>
                <p class="text-xs text-slate-400 mt-1">Kod gelmeyen numaralar otomatik bakiyeye iade edilir.</p>
            </div>

            <div class="glass-gold p-6 rounded-2xl glow-gold">
                <div class="flex items-center justify-between mb-2">
                    <span class="text-xs text-amber-400 font-mono uppercase tracking-wider">VIP Desteği</span>
                    <i class="fa-solid fa-headset text-amber-400"></i>
                </div>
                <h3 class="text-2xl font-black gold-text">7/24 Kesintisiz Destek</h3>
                <p class="text-xs text-slate-400 mt-1">Telegram & WhatsApp üzerinden anında çözüm.</p>
            </div>
        </div>

        <!-- SERVİS & ÜLKE KATALOĞU -->
        <div class="glass p-6 rounded-3xl mb-8">
            <div class="flex flex-col md:flex-row items-center justify-between gap-4 mb-6">
                <div>
                    <h2 class="text-xl font-bold text-white flex items-center gap-2">
                        <i class="fa-solid fa-earth-americas text-emerald-400"></i> Canlı Servis ve Ülke Listesi
                    </h2>
                    <p class="text-xs text-slate-400">Almak istediğiniz servisi seçin, anında numaranızı oluşturun.</p>
                </div>
                <div class="flex items-center gap-3 w-full md:w-auto">
                    <input id="txtSearch" oninput="filterCatalog()" type="text" placeholder="Servis veya ülke ara..." class="bg-black/50 border border-emerald-500/20 text-xs px-4 py-2.5 rounded-xl text-white w-full md:w-64 focus:outline-none focus:border-emerald-400">
                </div>
            </div>

            <div id="catalogGrid" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                <div class="col-span-full text-center py-12 text-slate-500 font-mono text-sm">
                    <i class="fa-solid fa-spinner fa-spin mr-2"></i> OnaylaSMS canlı katalog yükleniyor...
                </div>
            </div>
        </div>

        <!-- AKTİF SİPARİŞLERİM SİSTEMİ -->
        <div id="secOrders" class="glass p-6 rounded-3xl hidden">
            <h2 class="text-xl font-bold text-white mb-4 flex items-center gap-2">
                <i class="fa-solid fa-sim-card text-emerald-400"></i> Aktif Numaralarım
            </h2>
            <div id="ordersList" class="space-y-3"></div>
        </div>
    </main>

    <!-- FOOTER -->
    <footer class="relative z-10 glass border-t border-emerald-500/10 py-6 text-center text-xs text-slate-500">
        <p>© 2026 ANKA VIP SMS. Tüm hakları saklıdır. Cyber Infrastructure 4K</p>
    </footer>

    <!-- MODALLAR -->
    <!-- GİRİŞ MODAL -->
    <div id="authModal" class="fixed inset-0 z-50 bg-black/80 backdrop-blur-md hidden flex items-center justify-center p-4">
        <div class="glass p-8 rounded-3xl max-w-md w-full relative">
            <button onclick="hideAuthModal()" class="absolute top-4 right-4 text-slate-400 hover:text-white"><i class="fa-solid fa-xmark text-xl"></i></button>
            <h3 class="text-2xl font-black anka-text mb-6 text-center">Giriş Yap / Kaydol</h3>
            <div class="space-y-4">
                <input id="authName" type="text" placeholder="Kullanıcı Adı" class="w-full bg-black/60 border border-emerald-500/20 px-4 py-3 rounded-xl text-sm text-white focus:outline-none focus:border-emerald-400">
                <input id="authPass" type="password" placeholder="Şifre" class="w-full bg-black/60 border border-emerald-500/20 px-4 py-3 rounded-xl text-sm text-white focus:outline-none focus:border-emerald-400">
                <div class="flex gap-3 pt-2">
                    <button onclick="doLogin()" class="flex-1 bg-emerald-500 hover:bg-emerald-400 text-black font-bold py-3 rounded-xl text-sm transition-all">Giriş Yap</button>
                    <button onclick="doRegister()" class="flex-1 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 font-bold py-3 rounded-xl text-sm transition-all">Kaydol</button>
                </div>
            </div>
        </div>
    </div>

    <!-- BAKIYE MODAL -->
    <div id="depositModal" class="fixed inset-0 z-50 bg-black/80 backdrop-blur-md hidden flex items-center justify-center p-4">
        <div class="glass p-8 rounded-3xl max-w-md w-full relative">
            <button onclick="closeDepositModal()" class="absolute top-4 right-4 text-slate-400 hover:text-white"><i class="fa-solid fa-xmark text-xl"></i></button>
            <h3 class="text-2xl font-black gold-text mb-4 text-center">Bakiye Yükle</h3>
            <p class="text-xs text-slate-400 mb-6 text-center">Ödemeyi gerçekleştirdikten sonra aşağıdaki bildirim formunu doldurun.</p>
            <div class="space-y-4">
                <input id="depSender" type="text" placeholder="Gönderen Ad Soyad" class="w-full bg-black/60 border border-emerald-500/20 px-4 py-3 rounded-xl text-sm text-white focus:outline-none focus:border-emerald-400">
                <input id="depAmount" type="number" placeholder="Yüklemek İstediğiniz Tutar (TL)" class="w-full bg-black/60 border border-emerald-500/20 px-4 py-3 rounded-xl text-sm text-white focus:outline-none focus:border-emerald-400">
                <button onclick="sendDeposit()" class="w-full bg-amber-400 hover:bg-amber-300 text-black font-bold py-3 rounded-xl text-sm transition-all">Ödeme Bildirimi Gönder</button>
            </div>
        </div>
    </div>

    <!-- ADMIN PANEL MODAL -->
    <div id="adminModal" class="fixed inset-0 z-50 bg-black/90 backdrop-blur-md hidden flex items-center justify-center p-4 overflow-y-auto">
        <div class="glass p-8 rounded-3xl max-w-4xl w-full relative max-h-[90vh] overflow-y-auto">
            <button onclick="closeAdminModal()" class="absolute top-4 right-4 text-slate-400 hover:text-white"><i class="fa-solid fa-xmark text-xl"></i></button>
            <h3 class="text-2xl font-black gold-text mb-6">VIP Admin Yönetim Paneli</h3>
            
            <div id="adminContent" class="space-y-6">
                <div class="text-center text-slate-400"><i class="fa-solid fa-spinner fa-spin mr-2"></i> Veriler çekiliyor...</div>
            </div>
        </div>
    </div>

    <script>
        let currentUser = null;
        let catalogData = [];

        // INTRO ANIMASYON
        window.addEventListener('load', () => {
            setTimeout(() => {
                const intro = document.getElementById('introOverlay');
                intro.style.opacity = '0';
                setTimeout(() => intro.style.visibility = 'hidden', 800);
            }, 1200);
            initBGCanvas();
            loadCatalog();
        });

        // CANVAS PARTICLES (EMBER / MATRIX EFFECT)
        function initBGCanvas() {
            const canvas = document.getElementById('bgCanvas');
            const ctx = canvas.getContext('2d');
            canvas.width = window.innerWidth;
            canvas.height = window.innerHeight;

            const particles = Array.from({length: 45}, () => ({
                x: Math.random() * canvas.width,
                y: Math.random() * canvas.height,
                size: Math.random() * 2 + 1,
                speedY: -(Math.random() * 0.8 + 0.2),
                opacity: Math.random() * 0.5 + 0.2
            }));

            function animate() {
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                particles.forEach(p => {
                    p.y += p.speedY;
                    if (p.y < 0) p.y = canvas.height;
                    ctx.fillStyle = \`rgba(74, 222, 128, \${p.opacity})\`;
                    ctx.beginPath();
                    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
                    ctx.fill();
                });
                requestAnimationFrame(animate);
            }
            animate();
        }

        // CANLI KATALOG YÜKLE
        async function loadCatalog() {
            try {
                const res = await fetch('/api/getLiveCatalog');
                const data = await res.json();
                if (data.success) {
                    catalogData = data.catalog;
                    renderCatalog(catalogData);
                }
            } catch (e) {
                document.getElementById('catalogGrid').innerHTML = '<div class="col-span-full text-center text-red-400">Katalog yüklenirken hata oluştu.</div>';
            }
        }

        function renderCatalog(items) {
            const grid = document.getElementById('catalogGrid');
            if (!items.length) {
                grid.innerHTML = '<div class="col-span-full text-center py-8 text-slate-500">Uygun servis/ülke bulunamadı.</div>';
                return;
            }

            grid.innerHTML = items.slice(0, 60).map(item => \`
                <div class="bg-black/40 border border-emerald-500/10 hover:border-emerald-500/40 p-4 rounded-2xl transition-all flex items-center justify-between">
                    <div>
                        <div class="flex items-center gap-2 mb-1">
                            <span class="text-xs font-bold text-emerald-400 uppercase tracking-wider">\${item.serviceCode}</span>
                            <span class="text-[10px] bg-emerald-950/60 text-emerald-300 border border-emerald-500/20 px-1.5 py-0.5 rounded">Ülke Kodu: \${item.countryId}</span>
                        </div>
                        <div class="text-xs text-slate-400">Stok: <span class="text-white font-mono">\${item.count}</span> adet</div>
                    </div>
                    <div class="text-right">
                        <div class="text-lg font-black text-amber-400 mb-1">\${item.price} TL</div>
                        <button onclick="buyNum('\${item.serviceCode}', '\${item.countryId}')" class="bg-emerald-500 hover:bg-emerald-400 text-black font-bold text-xs px-3 py-1.5 rounded-lg transition-all">Satın Al</button>
                    </div>
                </div>
            \`).join('');
        }

        function filterCatalog() {
            const q = document.getElementById('txtSearch').value.toLowerCase();
            const filtered = catalogData.filter(i => i.serviceCode.toLowerCase().includes(q) || i.countryId.toString().includes(q));
            renderCatalog(filtered);
        }

        // AUTH & USER MANAGEMENT
        function showAuthModal() { document.getElementById('authModal').classList.remove('hidden'); }
        function hideAuthModal() { document.getElementById('authModal').classList.add('hidden'); }

        async function doLogin() {
            const u = document.getElementById('authName').value;
            const p = document.getElementById('authPass').value;
            const res = await fetch('/api/auth/login', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ username: u, password: p })
            });
            const data = await res.json();
            if (data.success) {
                currentUser = data.username;
                updateUserUI(data);
                hideAuthModal();
                loadMyOrders();
            } else {
                alert(data.message);
            }
        }

        async function doRegister() {
            const u = document.getElementById('authName').value;
            const p = document.getElementById('authPass').value;
            const res = await fetch('/api/auth/register', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ username: u, password: p })
            });
            const data = await res.json();
            if (data.success) {
                alert('Kayıt başarılı! Şimdi giriş yapabilirsiniz.');
            } else {
                alert(data.message);
            }
        }

        function updateUserUI(data) {
            document.getElementById('btnLoginModal').classList.add('hidden');
            document.getElementById('userInfo').classList.remove('hidden');
            document.getElementById('txtUser').innerText = data.username;
            document.getElementById('txtBalance').innerText = data.balance + ' TL';
            if (data.role === 'admin') document.getElementById('btnAdmin').classList.remove('hidden');
        }

        async function buyNum(serviceCode, countryId) {
            if (!currentUser) return showAuthModal();
            const res = await fetch('/api/buyNumber', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ serviceCode, countryId, username: currentUser })
            });
            const data = await res.json();
            if (data.success) {
                alert('Numara Başarıyla Alındı: ' + data.order.phoneNumber);
                refreshBalance();
                loadMyOrders();
            } else {
                alert(data.message);
            }
        }

        async function refreshBalance() {
            if (!currentUser) return;
            const res = await fetch('/api/getCustomerBalance?username=' + currentUser);
            const data = await res.json();
            if (data.success) {
                document.getElementById('txtBalance').innerText = data.balance + ' TL';
            }
        }

        async function loadMyOrders() {
            if (!currentUser) return;
            const res = await fetch('/api/myOrders?username=' + currentUser);
            const data = await res.json();
            if (data.success && data.orders.length) {
                document.getElementById('secOrders').classList.remove('hidden');
                document.getElementById('ordersList').innerHTML = data.orders.map(o => \`
                    <div class="bg-black/60 border border-emerald-500/20 p-4 rounded-xl flex items-center justify-between">
                        <div>
                            <div class="font-mono text-emerald-400 font-bold text-base">\${o.phoneNumber}</div>
                            <div class="text-xs text-slate-400">Aktivasyon ID: \${o.activationId}</div>
                        </div>
                        <div class="text-right">
                            <div class="text-sm font-black text-amber-400 font-mono">\${o.code}</div>
                            \${o.status === 'waiting' ? \`<button onclick="cancelNum('\${o.activationId}')" class="text-[10px] text-red-400 hover:underline">İptal Et</button>\` : ''}
                        </div>
                    </div>
                \`).join('');
            }
        }

        async function cancelNum(id) {
            const res = await fetch('/api/cancelNumber', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ activationId: id, username: currentUser })
            });
            const data = await res.json();
            alert(data.message);
            refreshBalance();
            loadMyOrders();
        }

        // BAKIYE MODAL
        function openDepositModal() { document.getElementById('depositModal').classList.remove('hidden'); }
        function closeDepositModal() { document.getElementById('depositModal').classList.add('hidden'); }

        async function sendDeposit() {
            const s = document.getElementById('depSender').value;
            const a = document.getElementById('depAmount').value;
            const res = await fetch('/api/deposit/notify', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ username: currentUser, senderName: s, amount: a })
            });
            const data = await res.json();
            alert(data.message);
            closeDepositModal();
        }

        // ADMIN PANEL
        async function showAdminPanel() {
            document.getElementById('adminModal').classList.remove('hidden');
            const res = await fetch('/api/admin/getData?adminUsername=' + currentUser);
            const data = await res.json();
            if (data.success) {
                document.getElementById('adminContent').innerHTML = \`
                    <div class="grid grid-cols-3 gap-4 mb-6">
                        <div class="bg-black/50 p-4 rounded-xl border border-emerald-500/20 text-center">
                            <div class="text-xs text-slate-400">Toplam Kullanıcı</div>
                            <div class="text-xl font-bold text-emerald-400">\${data.users.length}</div>
                        </div>
                        <div class="bg-black/50 p-4 rounded-xl border border-emerald-500/20 text-center">
                            <div class="text-xs text-slate-400">Ödeme Bildirimleri</div>
                            <div class="text-xl font-bold text-amber-400">\${data.payments.length}</div>
                        </div>
                        <div class="bg-black/50 p-4 rounded-xl border border-emerald-500/20 text-center">
                            <div class="text-xs text-slate-400">Toplam Sipariş</div>
                            <div class="text-xl font-bold text-blue-400">\${data.orders.length}</div>
                        </div>
                    </div>
                    <h4 class="font-bold text-white mb-2">Kullanıcı Listesi & Bakiye Düzenle</h4>
                    <div class="space-y-2">
                        \${data.users.map(u => \`
                            <div class="bg-black/40 p-3 rounded-lg flex items-center justify-between text-xs">
                                <div><span class="font-bold text-white">\${u.username}</span> (\${u.role})</div>
                                <div class="flex items-center gap-2">
                                    <span class="text-emerald-400 font-bold">\${u.balance} TL</span>
                                    <button onclick="setBalance('\${u.username}')" class="bg-amber-400 text-black px-2 py-1 rounded font-bold">Düzenle</button>
                                </div>
                            </div>
                        \`).join('')}
                    </div>
                \`;
            }
        }

        async function setBalance(user) {
            const nb = prompt(user + ' için yeni bakiye girin:');
            if (!nb) return;
            const res = await fetch('/api/admin/updateBalance', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ adminUsername: currentUser, targetUser: user, newBalance: nb })
            });
            const data = await res.json();
            alert(data.message);
            showAdminPanel();
        }

        function closeAdminModal() { document.getElementById('adminModal').classList.add('hidden'); }
    </script>
</body>
</html>
    `);
});

// ====== SUNUCUYU BAŞLAT ======
app.listen(PORT, () => {
    console.log(`[ANKA VIP SMS] Sunucu ${PORT} portunda aktif!`);
});
