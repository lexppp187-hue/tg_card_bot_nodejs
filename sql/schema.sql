
-- SQL schema for Telegram Card Game Bot (Postgres)
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
