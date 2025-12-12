/**
 * Telegram Card Game Bot - Node.js (Telegraf + pg)
 * See README.md for usage and deployment instructions.
 */

const { Telegraf, Markup } = require('telegraf');
const { Pool } = require('pg');

const BOT_TOKEN = process.env.BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(s=>s.trim()).filter(Boolean).map(Number);
const COOLDOWN_MINUTES = parseInt(process.env.COOLDOWN_MINUTES || '30', 10);

if (!BOT_TOKEN || !DATABASE_URL) {
  console.error('BOT_TOKEN and DATABASE_URL must be set as environment variables.');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

const RARITY_DEFAULTS = {
  common: { weight: 60, coins_per_hour: 1 },
  rare: { weight: 25, coins_per_hour: 3 },
  epic: { weight: 10, coins_per_hour: 8 },
  legendary: { weight: 5, coins_per_hour: 20 },
};

function getRaritiesAndWeights() {
  const rarities = Object.keys(RARITY_DEFAULTS);
  const weights = rarities.map(r => RARITY_DEFAULTS[r].weight);
  return { rarities, weights };
}

async function initDb() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS cards (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        rarity TEXT NOT NULL,
        image_file_id TEXT,
        coins_per_hour INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS users (
        tg_id BIGINT PRIMARY KEY,
        last_pack TIMESTAMP DEFAULT '1970-01-01'::timestamp,
        coins BIGINT DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS inventory (
        id SERIAL PRIMARY KEY,
        user_id BIGINT REFERENCES users(tg_id) ON DELETE CASCADE,
        card_id INTEGER REFERENCES cards(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS trades (
        id SERIAL PRIMARY KEY,
        from_user BIGINT REFERENCES users(tg_id) ON DELETE CASCADE,
        to_user BIGINT REFERENCES users(tg_id) ON DELETE CASCADE,
        offered_inventory_id INTEGER REFERENCES inventory(id) ON DELETE CASCADE,
        requested_inventory_id INTEGER REFERENCES inventory(id) ON DELETE CASCADE,
        status TEXT DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT now()
      );
    `);
  } finally {
    client.release();
  }
}

async function ensureUser(tg_id) {
  await pool.query('INSERT INTO users (tg_id) VALUES ($1) ON CONFLICT (tg_id) DO NOTHING', [tg_id]);
}

async function givePassiveIncomeAll() {
  const client = await pool.connect();
  try {
    const rows = await client.query(`
      SELECT u.tg_id, COALESCE(SUM(c.coins_per_hour),0) AS income
      FROM users u
      LEFT JOIN inventory i ON i.user_id = u.tg_id
      LEFT JOIN cards c ON c.id = i.card_id
      GROUP BY u.tg_id;
    `);
    for (const r of rows.rows) {
      const income = parseInt(r.income || 0, 10);
      if (income > 0) {
        await client.query('UPDATE users SET coins = coins + $1 WHERE tg_id = $2', [income, r.tg_id]);
      }
    }
  } finally {
    client.release();
  }
}

function weightedChoice(items, weights) {
  const sum = weights.reduce((a,b)=>a+b,0);
  let rnd = Math.random() * sum;
  for (let i=0;i<items.length;i++) {
    rnd -= weights[i];
    if (rnd <= 0) return items[i];
  }
  return items[items.length-1];
}

function mainMenu() {
  return Markup.inlineKeyboard([
    [ Markup.button.callback('🎁 Открыть бесплатный пак', 'free_pack') ],
    [ Markup.button.callback('📦 Магазин', 'shop') ],
    [ Markup.button.callback('🎒 Инвентарь', 'inv') ],
    [ Markup.button.callback('🔁 Торги', 'trades') ]
  ]);
}

bot.start(async (ctx) => {
  await ensureUser(ctx.from.id);
  await ctx.reply('Добро пожаловать! Открывайте паки и торгуйтесь.', mainMenu());
});

bot.command('admin', async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return ctx.reply('Доступ запрещён');
  await ctx.reply('Админ панель', Markup.inlineKeyboard([
    [ Markup.button.callback('Добавить карту', 'admin_add_card') ],
    [ Markup.button.callback('Список карт', 'admin_list_cards') ]
  ]));
});

bot.action('free_pack', async (ctx) => {
  const uid = ctx.from.id;
  await ensureUser(uid);
  const now = new Date();
  const { rows } = await pool.query('SELECT last_pack FROM users WHERE tg_id=$1', [uid]);
  const last = rows[0] && rows[0].last_pack ? new Date(rows[0].last_pack) : new Date(0);
  const diff = now - last;
  if (diff < COOLDOWN_MINUTES * 60 * 1000) {
    const wait = Math.ceil((COOLDOWN_MINUTES*60*1000 - diff)/60000);
    return ctx.answerCbQuery(`Пак доступен через ~${wait} мин.`, { show_alert: true });
  }
  await pool.query('UPDATE users SET last_pack=$1 WHERE tg_id=$2', [now.toISOString(), uid]);
  const { rarities, weights } = getRaritiesAndWeights();
  const cardsDb = (await pool.query('SELECT id, name, rarity, image_file_id FROM cards')).rows;
  const got = [];
  for (let i=0;i<5;i++) {
    if (cardsDb.length > 0) {
      const rarity = weightedChoice(rarities, weights);
      const bucket = cardsDb.filter(c => c.rarity === rarity);
      const choice = (bucket.length>0) ? bucket[Math.floor(Math.random()*bucket.length)] : cardsDb[Math.floor(Math.random()*cardsDb.length)];
      got.push(choice);
      await pool.query('INSERT INTO inventory (user_id, card_id) VALUES ($1,$2)', [uid, choice.id]);
    } else {
      const rarity = weightedChoice(rarities, weights);
      const name = `Card ${Math.floor(Math.random()*9000)+1000}`;
      const coins = RARITY_DEFAULTS[rarity].coins_per_hour;
      const res = await pool.query('INSERT INTO cards (name, rarity, coins_per_hour) VALUES ($1,$2,$3) RETURNING id, name, rarity, image_file_id', [name, rarity, coins]);
      const choice = res.rows[0];
      got.push(choice);
      await pool.query('INSERT INTO inventory (user_id, card_id) VALUES ($1,$2)', [uid, choice.id]);
    }
  }
  const text = 'Вы открыли пак:\\n' + got.map(c => `#${c.id} — ${c.name} (${c.rarity})`).join('\\n');
  await ctx.reply(text);
  await ctx.answerCbQuery();
});

bot.action('inv', async (ctx) => {
  const uid = ctx.from.id;
  await ensureUser(uid);
  const rows = (await pool.query(`
    SELECT i.id as inv_id, c.id as card_id, c.name, c.rarity, c.image_file_id
    FROM inventory i
    JOIN cards c ON c.id = i.card_id
    WHERE i.user_id = $1
    ORDER BY i.created_at DESC
  `, [uid])).rows;
  if (rows.length === 0) return ctx.reply('Инвентарь пуст');
  const text = 'Ваши карты:\\n' + rows.map(r => `inv#${r.inv_id} — ${r.name} (${r.rarity})`).join('\\n');
  await ctx.reply(text, Markup.inlineKeyboard([[Markup.button.callback('Отправить предложение обмена', 'trade_start')]]));
});

bot.action('shop', async (ctx) => {
  await ctx.reply('Магазин паков:', Markup.inlineKeyboard([
    [ Markup.button.callback('Пак x2 — 20 монет', 'buy_2') ],
    [ Markup.button.callback('Пак x3 — 25 монет', 'buy_3') ],
    [ Markup.button.callback('Пак x10 — 60 монет', 'buy_10') ]
  ]));
});

async function buyPack(uid, count, price) {
  const client = await pool.connect();
  try {
    const res = await client.query('SELECT coins FROM users WHERE tg_id=$1', [uid]);
    const coins = res.rows[0] ? parseInt(res.rows[0].coins || 0, 10) : 0;
    if (coins < price) return { ok:false, msg:'Недостаточно монет' };
    await client.query('UPDATE users SET coins = coins - $1 WHERE tg_id = $2', [price, uid]);
    const cardsDb = (await client.query('SELECT id, name, rarity, image_file_id FROM cards')).rows;
    const { rarities, weights } = getRaritiesAndWeights();
    const got = [];
    for (let i=0;i<count;i++) {
      if (cardsDb.length > 0) {
        const rarity = weightedChoice(rarities, weights);
        const bucket = cardsDb.filter(c => c.rarity === rarity);
        const choice = (bucket.length>0) ? bucket[Math.floor(Math.random()*bucket.length)] : cardsDb[Math.floor(Math.random()*cardsDb.length)];
        got.push(choice);
        await client.query('INSERT INTO inventory (user_id, card_id) VALUES ($1,$2)', [uid, choice.id]);
      } else {
        const rarity = weightedChoice(rarities, weights);
        const name = `Card ${Math.floor(Math.random()*9000)+1000}`;
        const coinsPerHour = RARITY_DEFAULTS[rarity].coins_per_hour;
        const r = await client.query('INSERT INTO cards (name, rarity, coins_per_hour) VALUES ($1,$2,$3) RETURNING id, name, rarity, image_file_id', [name, rarity, coinsPerHour]);
        got.push(r.rows[0]);
        await client.query('INSERT INTO inventory (user_id, card_id) VALUES ($1,$2)', [uid, r.rows[0].id]);
      }
    }
    return { ok:true, cards: got };
  } finally {
    client.release();
  }
}

bot.action(/buy_/, async (ctx) => {
  const uid = ctx.from.id;
  const map = { buy_2: [2,20], buy_3: [3,25], buy_10: [10,60] };
  const key = ctx.update.callback_query.data;
  const [count, price] = map[key];
  const res = await buyPack(uid, count, price);
  if (!res.ok) return ctx.answerCbQuery(res.msg, { show_alert: true });
  await ctx.reply('Вы купили пак:\\n' + res.cards.map(c => `#${c.id} — ${c.name} (${c.rarity})`).join('\\n'));
});

bot.action('trade_start', async (ctx) => {
  await ctx.reply('Отправьте сообщение в формате: inv#<id> <tg_id получателя>\\nПример: inv#123 987654321');
  await ctx.answerCbQuery();
});

bot.on('text', async (ctx) => {
  const txt = (ctx.message && ctx.message.text) ? ctx.message.text.trim() : '';
  if (txt.startsWith('inv#')) {
    const parts = txt.split(/\\s+/);
    if (parts.length < 2) return ctx.reply('Нужно: inv#<id> <tg_id получателя>');
    const invId = parseInt(parts[0].replace('inv#',''),10);
    const toUser = parseInt(parts[1],10);
    if (!invId || !toUser) return ctx.reply('Неверный формат. Пример: inv#123 987654321');
    const uid = ctx.from.id;
    await ensureUser(toUser);
    const ownerRes = await pool.query('SELECT user_id FROM inventory WHERE id=$1', [invId]);
    if (ownerRes.rows.length === 0) return ctx.reply('Инвентарной записи не найдено');
    if (ownerRes.rows[0].user_id !== uid) return ctx.reply('Вы не владелец этой карточки');
    const tr = await pool.query('INSERT INTO trades (from_user, to_user, offered_inventory_id, status) VALUES ($1,$2,$3,$4) RETURNING id', [uid, toUser, invId, 'pending']);
    const trId = tr.rows[0].id;
    await ctx.reply(`Заявка отправлена пользователю ${toUser}. id заявки: ${trId}`);
    try {
      await bot.telegram.sendMessage(toUser, `Вам пришла заявка на обмен от ${uid}. id: ${trId}`, Markup.inlineKeyboard([
        Markup.button.callback('Принять', `trade_accept:${trId}`),
        Markup.button.callback('Отклонить', `trade_reject:${trId}`)
      ]));
    } catch (e) {
    }
    return;
  }
  if (txt.startsWith('/addcard_text') && ADMIN_IDS.includes(ctx.from.id)) {
    const payload = txt.replace('/addcard_text','').trim();
    const parts = payload.split('|').map(s=>s.trim());
    if (parts.length < 3) return ctx.reply('Формат: /addcard_text Name | rarity | coins_per_hour');
    const [name, rarity, coins] = parts;
    const res = await pool.query('INSERT INTO cards (name, rarity, coins_per_hour) VALUES ($1,$2,$3) RETURNING id', [name, rarity, parseInt(coins,10)||0]);
    return ctx.reply(`Карта добавлена id:${res.rows[0].id}`);
  }
});

bot.action(/trade_accept:/, async (ctx) => {
  const trId = parseInt(ctx.update.callback_query.data.split(':')[1],10);
  const uid = ctx.from.id;
  const tr = (await pool.query('SELECT * FROM trades WHERE id=$1', [trId])).rows[0];
  if (!tr) return ctx.answerCbQuery('Заявка не найдена', { show_alert:true });
  if (tr.to_user !== uid) return ctx.answerCbQuery('Вы не можете принять эту заявку', { show_alert:true });
  await pool.query('UPDATE inventory SET user_id = $1 WHERE id = $2', [tr.to_user, tr.offered_inventory_id]);
  await pool.query('UPDATE trades SET status=$1 WHERE id=$2', ['accepted', trId]);
  await ctx.reply('Заявка принята — карта передана');
  try { await bot.telegram.sendMessage(tr.from_user, `Ваша заявка #${trId} принята`); } catch(e){}
});
bot.action(/trade_reject:/, async (ctx) => {
  const trId = parseInt(ctx.update.callback_query.data.split(':')[1],10);
  await pool.query('UPDATE trades SET status=$1 WHERE id=$2', ['rejected', trId]);
  await ctx.reply('Заявка отклонена');
});

bot.action('admin_add_card', async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return ctx.answerCbQuery('Нет доступа', { show_alert:true });
  await ctx.reply('Отправьте фото карты с подписью: Name | rarity | coins_per_hour\\nПример: Flame Dragon | epic | 8');
  await ctx.answerCbQuery();
});

bot.on('photo', async (ctx) => {
  if (!ctx.message.caption) return;
  if (!ADMIN_IDS.includes(ctx.from.id)) return;
  const caption = ctx.message.caption;
  const parts = caption.split('|').map(s=>s.trim());
  if (parts.length < 3) return ctx.reply('Неверный формат подписи. Пример: Flame Dragon | epic | 8');
  const [name, rarity, coins] = parts;
  const photo = ctx.message.photo[ctx.message.photo.length-1];
  const file_id = photo.file_id;
  const res = await pool.query('INSERT INTO cards (name, rarity, image_file_id, coins_per_hour) VALUES ($1,$2,$3,$4) RETURNING id', [name, rarity, file_id, parseInt(coins,10)||0]);
  await ctx.reply(`Карта добавлена, id: ${res.rows[0].id}`);
});

bot.action('admin_list_cards', async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return ctx.answerCbQuery('Нет доступа', { show_alert:true });
  const rows = (await pool.query('SELECT id, name, rarity, image_file_id FROM cards ORDER BY id DESC LIMIT 200')).rows;
  if (rows.length === 0) return ctx.reply('Нет карт в базе');
  for (const r of rows) {
    const text = `#${r.id} — ${r.name} (${r.rarity})`;
    if (r.image_file_id) {
      try { await bot.telegram.sendPhoto(ctx.from.id, r.image_file_id, { caption: text }); }
      catch(e) { await ctx.reply(text); }
    } else {
      await ctx.reply(text);
    }
  }
  await ctx.answerCbQuery();
});

async function startBackgroundTasks() {
  setInterval(async () => {
    try { await givePassiveIncomeAll(); console.log('Passive income distributed'); } catch(e){ console.error('Income error', e); }
  }, 3600 * 1000);
}

(async () => {
  try {
    await initDb();
    await startBackgroundTasks();
    await bot.launch();
    console.log('Bot started (Telegraf)');
    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));
  } catch (e) {
    console.error('Startup error', e);
    process.exit(1);
  }
})();
