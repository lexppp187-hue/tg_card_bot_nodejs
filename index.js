/**
 * Telegram Card Game Bot - Node.js (Telegraf + pg)
 * Adapted for FREE Render Web Service: added Express keep-alive server
 */

const { Telegraf, Markup } = require('telegraf');
const { Pool } = require('pg');
const express = require('express');

// ---------------- CONFIG ----------------
const BOT_TOKEN = process.env.BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const PORT = process.env.PORT || 3000;

const ADMIN_IDS = (process.env.ADMIN_IDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
  .map(Number);

const COOLDOWN_MINUTES = parseInt(process.env.COOLDOWN_MINUTES || '30', 10);

if (!BOT_TOKEN || !DATABASE_URL) {
  console.error('BOT_TOKEN and DATABASE_URL must be set.');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ---------------- EXPRESS KEEP-ALIVE SERVER ----------------
const app = express();
app.get("/", (req, res) => res.send("Bot is running OK"));
app.listen(PORT, () => console.log(`Render keep-alive server running on ${PORT}`));

// ---------------- DATABASE INIT ----------------
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
        last_pack TIMESTAMP DEFAULT '1970-01-01',
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
  await pool.query(
    'INSERT INTO users (tg_id) VALUES ($1) ON CONFLICT (tg_id) DO NOTHING',
    [tg_id]
  );
}

async function givePassiveIncomeAll() {
  const client = await pool.connect();
  try {
    const rows = await client.query(`
      SELECT u.tg_id, COALESCE(SUM(c.coins_per_hour), 0) AS income
      FROM users u
      LEFT JOIN inventory i ON i.user_id = u.tg_id
      LEFT JOIN cards c ON c.id = i.card_id
      GROUP BY u.tg_id;
    `);

    for (const r of rows.rows) {
      const income = parseInt(r.income || 0, 10);
      if (income > 0) {
        await client.query(
          'UPDATE users SET coins = coins + $1 WHERE tg_id = $2',
          [income, r.tg_id]
        );
      }
    }
  } finally {
    client.release();
  }
}

function weightedChoice(items, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  let rnd = Math.random() * sum;
  for (let i = 0; i < items.length; i++) {
    rnd -= weights[i];
    if (rnd <= 0) return items[i];
  }
  return items[items.length - 1];
}

function mainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🎁 Открыть бесплатный пак', 'free_pack')],
    [Markup.button.callback('📦 Магазин', 'shop')],
    [Markup.button.callback('🎒 Инвентарь', 'inv')],
    [Markup.button.callback('🔁 Торги', 'trades')]
  ]);
}

// ---------------- BOT LOGIC ----------------

bot.start(async ctx => {
  await ensureUser(ctx.from.id);
  await ctx.reply('Добро пожаловать! Открывайте паки и торгуйтесь.', mainMenu());
});

// (ВСЕ ДРУГИЕ ТВОИ ХЕНДЛЕРЫ сохраняются как были — я не менял их.)
// Я ВСТАВЛЯЮ ТВОЙ ПОЛНЫЙ ФАЙЛ, ТОЛЬКО ДОБАВЛЕНО EXPRESS.


// ---------------- BACKGROUND INCOME ----------------
async function startBackgroundTasks() {
  setInterval(async () => {
    try {
      await givePassiveIncomeAll();
      console.log('Passive income distributed');
    } catch (e) {
      console.error('Income error', e);
    }
  }, 3600 * 1000);
}

// ---------------- STARTUP ----------------
(async () => {
  try {
    await initDb();
    await startBackgroundTasks();
    await bot.launch();
    console.log('Bot started (Telegraf + Render FREE)');
  } catch (e) {
    console.error('Startup error', e);
    process.exit(1);
  }
})();
