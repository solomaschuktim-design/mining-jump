// Майнинг Прыжок — сервер для Telegram Mini App.
// Отдаёт игру (index.html), хранит рейтинг, покупки за звёзды и рефералов.
// Запуск:  BOT_TOKEN=123:ABC node server.js   (нужен Node 18+, без зависимостей)
// Переменные: BOT_TOKEN (обязательно), PORT, WEBAPP_URL (на Render не нужна),
//             UPSTASH_REDIS_REST_URL и UPSTASH_REDIS_REST_TOKEN — чтобы данные не пропадали.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const WEBAPP_URL = process.env.WEBAPP_URL || process.env.RENDER_EXTERNAL_URL || '';
const INDEX = path.join(__dirname, 'index.html');
const REF_REWARD = 200;             // $ за приглашённого друга (и другу тоже)
const REF_WINDOW = 15 * 60 * 1000;  // новичком считается игрок, впервые зашедший не раньше 15 минут назад
let BOT_USERNAME = process.env.BOT_USERNAME || '';

// Наборы за звёзды. Цены задаются здесь, клиенту доверять нельзя.
const PACKS = {
  start:      { stars: 25,  title: { ru: 'Стартовый набор', uk: 'Стартовий набір', en: 'Starter pack' },
                desc: { ru: '$25 000 и 3 редких кейса', uk: '$25 000 і 3 рідкісні кейси', en: '$25,000 and 3 rare cases' } },
  premium:    { stars: 50, perks: ['premium'], title: { ru: 'Премиум-ферма', uk: 'Преміум-ферма', en: 'Premium farm' },
                desc: { ru: 'Навсегда ×1.5 к доходу майнинга', uk: 'Назавжди ×1.5 до доходу майнінгу', en: 'Permanent ×1.5 mining income' } },
  offline:    { stars: 75, perks: ['offline'], title: { ru: 'Ночная смена', uk: 'Нічна зміна', en: 'Night shift' },
                desc: { ru: 'Офлайн-доход копится 12 часов', uk: 'Офлайн-дохід накопичується 12 годин', en: 'Offline income builds up for 12 hours' } },
  legendpack: { stars: 100, perks: ['diamond'], title: { ru: 'Легендарный набор', uk: 'Легендарний набір', en: 'Legendary pack' },
                desc: { ru: '3 легендарных кейса и скин «Алмазные руки»', uk: '3 легендарні кейси та скін «Діамантові руки»', en: '3 legendary cases and the Diamond hands skin' } },
  whale:      { stars: 150, perks: ['vip', 'diamond'], title: { ru: 'Кит', uk: 'Кит', en: 'Whale' },
                desc: { ru: '$1 000 000, VIP ×2 монеты и скин «Алмазные руки»', uk: '$1 000 000, VIP ×2 монети та скін «Діамантові руки»', en: '$1,000,000, VIP ×2 coins and the Diamond hands skin' } },
};
const ERR = {
  tg: { ru: 'Откройте игру через Telegram', uk: 'Відкрийте гру через Telegram', en: 'Open the game in Telegram' },
  owned: { ru: 'Уже куплено', uk: 'Вже куплено', en: 'Already owned' },
  nopack: { ru: 'Нет такого набора', uk: 'Немає такого набору', en: 'No such pack' },
  invoice: { ru: 'Не удалось создать счёт', uk: 'Не вдалося створити рахунок', en: 'Could not create the invoice' },
};
const pick = (o, l) => o[l] || o.ru;
const langOf = code => { const c = String(code || '').slice(0, 2); return c === 'uk' ? 'uk' : (c === 'ru' || c === 'be' || c === 'kk') ? 'ru' : 'en'; };

// ---- Хранилище: Upstash Redis, если задан, иначе файлы ----
const REDIS_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const useRedis = !!(REDIS_URL && REDIS_TOKEN);
const HASHES = ['players', 'purchases', 'refs', 'refpay'];
// players: id -> профиль в рейтинге; purchases: id -> [покупки]; refs: приглашённый -> пригласивший;
// refpay: id -> { pending: невыданные $, count: сколько друзей пригласил }
const db = Object.fromEntries(HASHES.map(h => [h, {}]));
const dirty = Object.fromEntries(HASHES.map(h => [h, new Set()]));

async function redis(p, body) {
  const r = await fetch(REDIS_URL + p, { method: 'POST', headers: { Authorization: 'Bearer ' + REDIS_TOKEN }, body: JSON.stringify(body) });
  const j = await r.json();
  if (j.error) throw new Error('redis: ' + j.error);
  return j;
}
async function loadStore() {
  for (const h of HASHES) {
    if (useRedis) {
      const { result } = await redis('', ['HGETALL', h]);
      for (let i = 0; i < (result || []).length; i += 2) { try { db[h][result[i]] = JSON.parse(result[i + 1]); } catch (e) {} }
    } else {
      try { db[h] = JSON.parse(fs.readFileSync(path.join(__dirname, h + '.json'), 'utf8')); } catch (e) {}
    }
  }
  console.log((useRedis ? 'База Upstash' : 'Хранение в файлах (на бесплатном Render данные пропадут при перезапуске)') + ': игроков ' + Object.keys(db.players).length);
}
let saveTimer = null;
function persist(h, id) { dirty[h].add(id); clearTimeout(saveTimer); saveTimer = setTimeout(flush, 400); }
async function flush() {
  if (!useRedis) {
    for (const h of HASHES) if (dirty[h].size) { dirty[h].clear(); fs.writeFile(path.join(__dirname, h + '.json'), JSON.stringify(db[h]), () => {}); }
    return;
  }
  const cmds = [];
  for (const h of HASHES) { for (const id of dirty[h]) cmds.push(db[h][id] === undefined ? ['HDEL', h, id] : ['HSET', h, id, JSON.stringify(db[h][id])]); dirty[h].clear(); }
  if (cmds.length) { try { await redis('/pipeline', cmds); } catch (e) { console.error(e.message); } }
}

// ---- Проверка подписи Telegram ----
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
  try { return { user: JSON.parse(params.get('user')), startParam: params.get('start_param') || '' }; } catch (e) { return null; }
}

// ---- Рефералы ----
function ensurePlayer(id, name) {
  if (!db.players[id]) {
    db.players[id] = { avatar: 'h:satoshi', name: String(name || 'Игрок').replace(/[<>]/g, '').slice(0, 18), record: 0, earned: 0, cards: 0, ach: 0, skin: 'satoshi', created: Date.now(), ts: Date.now() };
    persist('players', id);
    return true;
  }
  return false;
}
function isNewcomer(id) { const p = db.players[id]; return !p || (p.created && Date.now() - p.created < REF_WINDOW); }
// Начисляет обоим по $200. Возвращает true, если реферал засчитан.
function applyReferral(inviteeId, param) {
  const m = /^ref_?(tg\d+|\d+)$/.exec(String(param || ''));
  if (!m) return false;
  const inviterId = m[1].startsWith('tg') ? m[1] : 'tg' + m[1];
  if (inviterId === inviteeId || db.refs[inviteeId] || !db.players[inviterId] || !isNewcomer(inviteeId)) return false;
  db.refs[inviteeId] = inviterId; persist('refs', inviteeId);
  const a = db.refpay[inviterId] || { pending: 0, count: 0 };
  a.pending += REF_REWARD; a.count += 1; db.refpay[inviterId] = a; persist('refpay', inviterId);
  const b = db.refpay[inviteeId] || { pending: 0, count: 0 };
  b.pending += REF_REWARD; b.boost = (b.boost || 0) + 1; db.refpay[inviteeId] = b; persist('refpay', inviteeId);
  console.log('Реферал: ' + inviterId + ' пригласил ' + inviteeId);
  notifyInviter(inviterId, inviteeId);
  return true;
}
async function notifyInviter(inviterId, inviteeId) {
  try {
    const name = (db.players[inviteeId] && db.players[inviteeId].name) || '';
    const lang = (db.players[inviterId] && db.players[inviterId].lang) || 'ru';
    const text = { ru: `🎉 ${name} пришёл по вашей ссылке! +$${REF_REWARD} ждут вас в игре.`,
                   uk: `🎉 ${name} прийшов за вашим посиланням! +$${REF_REWARD} чекають на вас у грі.`,
                   en: `🎉 ${name} joined with your link! +$${REF_REWARD} is waiting for you in the game.` }[lang];
    await tg('sendMessage', { chat_id: Number(inviterId.slice(2)), text });
  } catch (e) {}
}

function top() {
  return Object.entries(db.players)
    .map(([id, p]) => ({ id, avatar: p.avatar, name: p.name, record: p.record, earned: p.earned }))
    .sort((a, b) => b.record - a.record || b.earned - a.earned)
    .slice(0, 200);
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

const PLAY = { ru: '🎮 Играть', uk: '🎮 Грати', en: '🎮 Play' };
const START_TEXT = {
  ru: 'Майнинг Прыжок: собери дом-ферму из компьютеров от XRP до BTC и ставь рекорды в прыжках. Новичкам $1000!',
  uk: 'Майнінг Стрибок: збери дім-ферму з комп’ютерів від XRP до BTC і став рекорди у стрибках. Новачкам $1000!',
  en: 'Mining Jump: build a home farm of computers from XRP to BTC and set jump records. New players get $1000!',
};
const REF_TEXT = {
  ru: `Вы пришли по приглашению друга: +$${REF_REWARD} и ×2 майнинг на 30 минут уже ждут вас в игре!`,
  uk: `Ви прийшли за запрошенням друга: +$${REF_REWARD} і ×2 майнінг на 30 хвилин вже чекають на вас у грі!`,
  en: `You joined from a friend’s invite: +$${REF_REWARD} and ×2 mining for 30 minutes are waiting for you in the game!`,
};

async function setupBot() {
  if (!BOT_TOKEN) return console.log('Нет BOT_TOKEN: бот не настроен');
  try { const me = await tg('getMe'); BOT_USERNAME = me.username; console.log('Бот: @' + BOT_USERNAME); } catch (e) { console.error('getMe', e.message); }
  if (!WEBAPP_URL) return console.log('Нет адреса игры (WEBAPP_URL): кнопка меню не настроена');
  try {
    await tg('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Играть', web_app: { url: WEBAPP_URL } } });
    await tg('setMyCommands', { commands: [{ command: 'start', description: 'Играть' }, { command: 'paysupport', description: 'Вопросы по оплате' }] });
    await tg('setMyCommands', { commands: [{ command: 'start', description: 'Грати' }, { command: 'paysupport', description: 'Питання щодо оплати' }], language_code: 'uk' });
    await tg('setMyCommands', { commands: [{ command: 'start', description: 'Play' }, { command: 'paysupport', description: 'Payment support' }], language_code: 'en' });
    console.log('Кнопка меню настроена: ' + WEBAPP_URL);
  } catch (e) { console.error('setupBot', e.message); }
}

// Обновления бота (long polling, webhook должен быть выключен)
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
      const msg = u.message;
      if (!msg) continue;
      if (msg.successful_payment) {
        try {
          const pay = msg.successful_payment;
          const { p } = JSON.parse(pay.invoice_payload);
          const id = 'tg' + msg.from.id;
          (db.purchases[id] = db.purchases[id] || []).push({ pack: p, charge: pay.telegram_payment_charge_id, stars: pay.total_amount, ts: Date.now(), claimed: false });
          persist('purchases', id);
        } catch (e) { console.error('payment parse', e); }
      }
      const text = msg.text || '';
      if (text.startsWith('/start')) {
        const f = msg.from, id = 'tg' + f.id, lang = langOf(f.language_code);
        ensurePlayer(id, f.username || f.first_name);
        if (db.players[id] && !db.players[id].lang) { db.players[id].lang = lang; persist('players', id); }
        const referred = applyReferral(id, text.split(' ')[1]);
        if (WEBAPP_URL) {
          await tg('sendMessage', {
            chat_id: msg.chat.id,
            text: (referred ? REF_TEXT[lang] + '\n\n' : '') + START_TEXT[lang],
            reply_markup: { inline_keyboard: [[{ text: PLAY[lang], web_app: { url: WEBAPP_URL } }]] },
          });
        }
      }
      if (text === '/paysupport') {
        await tg('sendMessage', { chat_id: msg.chat.id, text: 'Вопросы по оплате звёздами: напишите сюда, что купили и когда. / Питання щодо оплати зірками: напишіть сюди, що купили й коли. / Stars payment questions: reply here with what you bought and when.' });
      }
    }
  } catch (e) { console.error(e.message); await new Promise(r => setTimeout(r, 3000)); }
  setImmediate(pollUpdates);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 1e4) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch (e) { reject(e); } });
  });
}
const num = (v, max) => Math.max(0, Math.min(Number(v) || 0, max));
const cleanAvatar = v => { const s = String(v || ''); return /^h:[a-z]{1,12}$/.test(s) ? s : (s.replace(/[<>&"'\s]/g, '').slice(0, 8) || 'h:satoshi'); };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && url.pathname === '/api/top') return send(res, 200, { players: top(), bot: BOT_USERNAME });

    if (req.method === 'POST' && url.pathname === '/api/invoice') {
      const b = await readBody(req);
      const lang = ['ru', 'uk', 'en'].includes(b.lang) ? b.lang : 'ru';
      const v = verifyInitData(b.initData);
      if (!v) return send(res, 403, { error: pick(ERR.tg, lang) });
      const pack = PACKS[b.pack];
      if (!pack) return send(res, 400, { error: pick(ERR.nopack, lang) });
      const owned = (db.purchases['tg' + v.user.id] || []).some(x => x.pack === b.pack);
      if (pack.perks && !['legendpack', 'whale'].includes(b.pack) && owned) return send(res, 400, { error: pick(ERR.owned, lang) });
      try {
        const link = await tg('createInvoiceLink', {
          title: pick(pack.title, lang), description: pick(pack.desc, lang),
          payload: JSON.stringify({ p: b.pack, u: v.user.id, n: Date.now() }),
          currency: 'XTR', prices: [{ label: pick(pack.title, lang), amount: pack.stars }],
        });
        return send(res, 200, { link });
      } catch (e) { return send(res, 500, { error: pick(ERR.invoice, lang) }); }
    }

    // Выдать покупки и реферальные бонусы (каждый один раз), вернуть данные для профиля
    if (req.method === 'POST' && url.pathname === '/api/claim') {
      const b = await readBody(req);
      const v = verifyInitData(b.initData);
      if (!v) return send(res, 403, { error: 'Откройте игру через Telegram' });
      const id = 'tg' + v.user.id;
      const list = db.purchases[id] || [];
      const packs = list.filter(x => !x.claimed).map(x => { x.claimed = true; return x.pack; });
      if (packs.length) persist('purchases', id);
      const perks = [...new Set(list.flatMap(x => (PACKS[x.pack] && PACKS[x.pack].perks) || []))];
      const rp = db.refpay[id] || { pending: 0, count: 0 };
      const refBonus = rp.pending, refBoost = rp.boost || 0;
      if (refBonus || refBoost) { rp.pending = 0; rp.boost = 0; db.refpay[id] = rp; persist('refpay', id); }
      return send(res, 200, { packs, perks, refBonus, refBoost, refCount: rp.count, refId: id, bot: BOT_USERNAME });
    }

    // Профиль в рейтинге; заодно засчитывает реферала, если игра открыта по ссылке startapp=ref_...
    if (req.method === 'POST' && url.pathname === '/api/score') {
      const b = await readBody(req);
      const v = verifyInitData(b.initData);
      if (BOT_TOKEN && !v) return send(res, 403, { error: 'Откройте игру через Telegram' });
      const id = v ? 'tg' + v.user.id : 'p' + String(b.pid || '').replace(/[^a-z0-9]/gi, '').slice(0, 12);
      if (id.length < 3) return send(res, 400, { error: 'no id' });
      const isNew = !db.players[id];
      const prev = db.players[id] || { record: 0, earned: 0, created: Date.now() };
      db.players[id] = {
        avatar: cleanAvatar(b.avatar),
        name: String(b.name || '').replace(/[<>]/g, '').trim().slice(0, 18) || 'Игрок',
        record: Math.max(prev.record || 0, num(b.record, 1e6)),
        earned: Math.max(prev.earned || 0, num(b.earned, 1e13)),
        cards: num(b.cards, 6), ach: num(b.ach, 60),
        skin: String(b.skin || 'satoshi').slice(0, 16),
        lang: ['ru', 'uk', 'en'].includes(b.lang) ? b.lang : (prev.lang || 'ru'),
        created: prev.created || Date.now(), ts: Date.now(),
      };
      persist('players', id);
      if (v && (isNew || isNewcomer(id))) applyReferral(id, v.startParam);
      return send(res, 200, { me: id, players: top(), bot: BOT_USERNAME });
    }

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return fs.readFile(INDEX, (e, d) => e ? send(res, 500, 'index.html не найден', 'text/plain') : send(res, 200, d, 'text/html'));
    }
    send(res, 404, { error: 'not found' });
  } catch (e) { send(res, 400, { error: 'bad request' }); }
});

loadStore().catch(e => console.error('Не удалось загрузить базу:', e.message))
  .finally(() => {
    server.listen(PORT, () => console.log('Майнинг Прыжок: http://localhost:' + PORT));
    setupBot();
    pollUpdates();
  });
