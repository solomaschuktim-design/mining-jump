// Майнинг Прыжок — простой сервер для Telegram Mini App.
// Отдаёт игру (index.html) и хранит общий рейтинг в players.json.
// Запуск:  BOT_TOKEN=123:ABC node server.js   (нужен Node 18+, без зависимостей)
// Порт по умолчанию 3000, меняется переменной PORT.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const DB_FILE = path.join(__dirname, 'players.json');
const INDEX = path.join(__dirname, 'index.html');
const PAY_FILE = path.join(__dirname, 'purchases.json');

// Наборы за звёзды. Цены задаются здесь, клиенту доверять нельзя.
const PACKS = {
  start:      { stars: 50,  title: { ru: 'Стартовый набор', uk: 'Стартовий набір', en: 'Starter pack' },
                desc: { ru: '$25 000 и 3 редких кейса', uk: '$25 000 і 3 рідкісні кейси', en: '$25,000 and 3 rare cases' } },
  premium:    { stars: 100, perks: ['premium'], title: { ru: 'Премиум-ферма', uk: 'Преміум-ферма', en: 'Premium farm' },
                desc: { ru: 'Навсегда ×1.5 к доходу майнинга', uk: 'Назавжди ×1.5 до доходу майнінгу', en: 'Permanent ×1.5 mining income' } },
  offline:    { stars: 150, perks: ['offline'], title: { ru: 'Ночная смена', uk: 'Нічна зміна', en: 'Night shift' },
                desc: { ru: 'Офлайн-доход копится 12 часов', uk: 'Офлайн-дохід накопичується 12 годин', en: 'Offline income builds up for 12 hours' } },
  legendpack: { stars: 250, perks: ['diamond'], title: { ru: 'Легендарный набор', uk: 'Легендарний набір', en: 'Legendary pack' },
                desc: { ru: '3 легендарных кейса и скин «Алмазные руки»', uk: '3 легендарні кейси та скін «Діамантові руки»', en: '3 legendary cases and the Diamond hands skin' } },
  whale:      { stars: 500, perks: ['vip', 'diamond'], title: { ru: 'Кит', uk: 'Кит', en: 'Whale' },
                desc: { ru: '$1 000 000, VIP ×2 монеты и скин «Алмазные руки»', uk: '$1 000 000, VIP ×2 монети та скін «Діамантові руки»', en: '$1,000,000, VIP ×2 coins and the Diamond hands skin' } },
};
const ERR = {
  tg: { ru: 'Откройте игру через Telegram', uk: 'Відкрийте гру через Telegram', en: 'Open the game in Telegram' },
  owned: { ru: 'Уже куплено', uk: 'Вже куплено', en: 'Already owned' },
};
const pick = (o, l) => o[l] || o.ru;

let players = {};
try { players = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) {}
let purchases = {};
try { purchases = JSON.parse(fs.readFileSync(PAY_FILE, 'utf8')); } catch (e) {}
let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(DB_FILE, JSON.stringify(players), () => {});
    fs.writeFile(PAY_FILE, JSON.stringify(purchases), () => {});
  }, 500);
}

// Проверка подписи Telegram (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app)
function verifyInitData(initData) {
  if (!BOT_TOKEN || !initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const dataCheck = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const check = crypto.createHmac('sha256', secret).update(dataCheck).digest('hex');
  if (check !== hash) return null;
  try { return JSON.parse(params.get('user')); } catch (e) { return null; }
}

function top() {
  return Object.entries(players)
    .map(([id, p]) => ({ id, ...p }))
    .sort((a, b) => b.record - a.record || b.earned - a.earned)
    .slice(0, 50);
}

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'content-type': type + '; charset=utf-8', 'cache-control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

// ---- Telegram Bot API ----
async function tg(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(method + ': ' + j.description);
  return j.result;
}

// Получаем обновления бота: подтверждаем оплату и записываем покупки.
// Используется long polling, поэтому у бота не должно быть webhook.
let offset = 0;
async function pollUpdates() {
  if (!BOT_TOKEN) return;
  try {
    const updates = await tg('getUpdates', { offset, timeout: 25, allowed_updates: ['pre_checkout_query', 'message'] });
    for (const u of updates) {
      offset = u.update_id + 1;
      if (u.pre_checkout_query) {
        const q = u.pre_checkout_query;
        let ok = false; try { ok = !!PACKS[JSON.parse(q.invoice_payload).p]; } catch (e) {}
        await tg('answerPreCheckoutQuery', ok ? { pre_checkout_query_id: q.id, ok: true }
          : { pre_checkout_query_id: q.id, ok: false, error_message: 'Набор не найден' });
      }
      const pay = u.message && u.message.successful_payment;
      if (pay) {
        try {
          const { p } = JSON.parse(pay.invoice_payload);
          const id = 'tg' + u.message.from.id;
          (purchases[id] = purchases[id] || []).push({ pack: p, charge: pay.telegram_payment_charge_id, stars: pay.total_amount, ts: Date.now(), claimed: false });
          persist();
        } catch (e) { console.error('payment parse', e); }
      }
      if (u.message && u.message.text === '/paysupport') {
        await tg('sendMessage', { chat_id: u.message.chat.id, text: 'Вопросы по оплате звёздами: напишите сюда, что купили и когда. / Питання щодо оплати зірками: напишіть сюди, що купили й коли. / Stars payment questions: reply here with what you bought and when.' });
      }
    }
  } catch (e) { console.error(e.message); await new Promise(r => setTimeout(r, 3000)); }
  setImmediate(pollUpdates);
}
pollUpdates();

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 1e4) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(raw)); } catch (e) { reject(e); } });
  });
}

const num = (v, max) => Math.max(0, Math.min(Number(v) || 0, max));

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');

  if (req.method === 'GET' && url.pathname === '/api/top') return send(res, 200, { players: top() });

  // Создать счёт в звёздах
  if (req.method === 'POST' && url.pathname === '/api/invoice') {
    readBody(req).then(async b => {
      const lang = ['ru', 'uk', 'en'].includes(b.lang) ? b.lang : 'ru';
      const user = verifyInitData(b.initData);
      if (!user) return send(res, 403, { error: pick(ERR.tg, lang) });
      const pack = PACKS[b.pack];
      if (!pack) return send(res, 400, { error: 'Нет такого набора' });
      const owned = (purchases['tg' + user.id] || []).some(x => x.pack === b.pack);
      if (pack.perks && !['legendpack', 'whale'].includes(b.pack) && owned) return send(res, 400, { error: pick(ERR.owned, lang) });
      try {
        const link = await tg('createInvoiceLink', {
          title: pick(pack.title, lang), description: pick(pack.desc, lang),
          payload: JSON.stringify({ p: b.pack, u: user.id, n: Date.now() }),
          currency: 'XTR', prices: [{ label: pick(pack.title, lang), amount: pack.stars }],
        });
        send(res, 200, { link });
      } catch (e) { send(res, 500, { error: 'Не удалось создать счёт' }); }
    }).catch(() => send(res, 400, { error: 'bad json' }));
    return;
  }

  // Выдать оплаченные наборы (каждый один раз) и список постоянных бонусов
  if (req.method === 'POST' && url.pathname === '/api/claim') {
    readBody(req).then(b => {
      const user = verifyInitData(b.initData);
      if (!user) return send(res, 403, { error: 'Откройте игру через Telegram' });
      const list = purchases['tg' + user.id] || [];
      const packs = list.filter(x => !x.claimed).map(x => { x.claimed = true; return x.pack; });
      const perks = [...new Set(list.flatMap(x => (PACKS[x.pack] && PACKS[x.pack].perks) || []))];
      if (packs.length) persist();
      send(res, 200, { packs, perks });
    }).catch(() => send(res, 400, { error: 'bad json' }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/score') {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 1e4) req.destroy(); });
    req.on('end', () => {
      let b; try { b = JSON.parse(raw); } catch (e) { return send(res, 400, { error: 'bad json' }); }
      const tgUser = verifyInitData(b.initData);
      // С BOT_TOKEN принимаем только подписанные Telegram запросы; без него — режим отладки по pid.
      if (BOT_TOKEN && !tgUser) return send(res, 403, { error: 'Откройте игру через Telegram' });
      const id = tgUser ? 'tg' + tgUser.id : 'p' + String(b.pid || '').replace(/[^a-z0-9]/gi, '').slice(0, 12);
      if (id.length < 3) return send(res, 400, { error: 'no id' });
      const prev = players[id] || { record: 0, earned: 0 };
      const name = String(b.name || '').replace(/[<>]/g, '').trim().slice(0, 18) || 'Игрок';
      players[id] = {
        name,
        record: Math.max(prev.record, num(b.record, 1e6)),
        earned: Math.max(prev.earned, num(b.earned, 1e13)),
        cards: num(b.cards, 6),
        ach: num(b.ach, 50),
        skin: String(b.skin || 'satoshi').slice(0, 16),
        ts: Date.now(),
      };
      persist();
      send(res, 200, { me: id, players: top() });
    });
    return;
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    return fs.readFile(INDEX, (e, d) => e ? send(res, 500, 'index.html не найден', 'text/plain') : send(res, 200, d, 'text/html'));
  }
  send(res, 404, { error: 'not found' });
}).listen(PORT, () => console.log('Майнинг Прыжок: http://localhost:' + PORT));
