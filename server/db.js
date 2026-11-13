import "dotenv/config";
import pg from "pg";
export const table = process.env.POSTGRES_TABLE || "telegram_contacts";
if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table) || table.length > 40)
  throw new Error(
    "POSTGRES_TABLE must be a simple SQL identifier, at most 40 characters",
  );
export const names = Object.fromEntries(
  [
    "contacts",
    "messages",
    "campaigns",
    "settings",
    "oauth",
    "audit",
    "deliveries",
    "groups",
    "group_messages",
  ].map((k) => [k, `"${k === "contacts" ? table : table + "_" + k}"`]),
);
export const configured = Boolean(
  process.env.POSTGRES_HOST &&
  process.env.POSTGRES_DB &&
  process.env.POSTGRES_USER,
);
export const pool = new pg.Pool({
  host: process.env.POSTGRES_HOST,
  port: Number(process.env.POSTGRES_PORT || 5432),
  database: process.env.POSTGRES_DB,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  connectionTimeoutMillis: 6000,
  ...(process.env.POSTGRES_SSL === "true"
    ? { ssl: { rejectUnauthorized: true } }
    : {}),
});
pool.on("error", () => console.error("PostgreSQL connection lost"));
export async function migrate() {
  if (!configured) throw new Error("Add PostgreSQL settings to .env");
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query(
      `CREATE TABLE IF NOT EXISTS ${names.contacts} (id SERIAL PRIMARY KEY, name TEXT NOT NULL, phone TEXT UNIQUE NOT NULL, telegram_id TEXT, access_hash TEXT, ai_enabled BOOLEAN NOT NULL DEFAULT false, opted_out BOOLEAN NOT NULL DEFAULT false, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
    );
    await c.query(
      `CREATE TABLE IF NOT EXISTS ${names.messages} (id BIGSERIAL PRIMARY KEY, contact_id INTEGER NOT NULL REFERENCES ${names.contacts}(id), direction TEXT NOT NULL CHECK(direction IN ('in','out')), body TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'manual', telegram_message_id TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(contact_id,telegram_message_id))`,
    );
    await c.query(
      `CREATE TABLE IF NOT EXISTS ${names.campaigns} (id SERIAL PRIMARY KEY, name TEXT NOT NULL, body TEXT NOT NULL, recipient_ids JSONB NOT NULL, results JSONB NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'draft', created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
    );
    await c.query(
      `CREATE TABLE IF NOT EXISTS ${names.settings} (id INTEGER PRIMARY KEY CHECK(id=1), instructions TEXT NOT NULL, model TEXT NOT NULL, enabled BOOLEAN NOT NULL DEFAULT false)`,
    );
    await c.query(
      `INSERT INTO ${names.settings}(id,instructions,model) VALUES(1,$1,$2) ON CONFLICT DO NOTHING`,
      [
        "You are a helpful customer support assistant. Reply in the customer’s language. Be concise. Never invent prices, policies, or promises. Ask a human to help when unsure.",
        "gpt-4.1-mini",
      ],
    );
    await c.query(
      `CREATE TABLE IF NOT EXISTS ${names.oauth} (kind TEXT NOT NULL,key TEXT NOT NULL,value JSONB NOT NULL,expires_at TIMESTAMPTZ NOT NULL,PRIMARY KEY(kind,key))`,
    );
    await c.query(
      `CREATE TABLE IF NOT EXISTS ${names.audit} (id BIGSERIAL PRIMARY KEY,client_id TEXT NOT NULL,tool TEXT NOT NULL,outcome TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
    );
    await c.query(
      `ALTER TABLE ${names.contacts} ADD COLUMN IF NOT EXISTS ai_instructions TEXT NOT NULL DEFAULT ''`,
    );
    await c.query(
      `CREATE TABLE IF NOT EXISTS ${names.deliveries} (request_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,status TEXT NOT NULL,result JSONB,created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
    );
    await c.query(
      `ALTER TABLE ${names.messages} ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'`,
    );
    await c.query(
      `ALTER TABLE ${names.contacts} ALTER COLUMN phone DROP NOT NULL`,
    );
    await c.query(
      `ALTER TABLE ${names.contacts} ADD COLUMN IF NOT EXISTS username TEXT`,
    );
    await c.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "${table}_username_idx" ON ${names.contacts}(lower(username)) WHERE username IS NOT NULL`,
    );
    await c.query(
      `CREATE TABLE IF NOT EXISTS ${names.groups} (id SERIAL PRIMARY KEY,telegram_id TEXT NOT NULL,peer_type TEXT NOT NULL CHECK(peer_type IN ('chat','channel')),access_hash TEXT,title TEXT NOT NULL,username TEXT,updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),UNIQUE(peer_type,telegram_id))`,
    );
    await c.query(
      `CREATE TABLE IF NOT EXISTS ${names.group_messages} (id BIGSERIAL PRIMARY KEY,group_id INTEGER REFERENCES ${names.groups}(id),body TEXT NOT NULL,telegram_message_id TEXT NOT NULL,image_url TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),UNIQUE(group_id,telegram_message_id))`,
    );
    await c.query(`ALTER TABLE ${names.group_messages}
      ADD COLUMN IF NOT EXISTS direction TEXT NOT NULL DEFAULT 'out',
      ADD COLUMN IF NOT EXISTS sender_id TEXT`);
    for (const target of [names.contacts, names.groups]) {
      await c.query(`ALTER TABLE ${target}
        ADD COLUMN IF NOT EXISTS ai_enabled BOOLEAN NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS ai_instructions TEXT NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS ai_mode TEXT NOT NULL DEFAULT 'immediate' CHECK (ai_mode IN ('immediate','scheduled')),
        ADD COLUMN IF NOT EXISTS ai_interval_minutes INTEGER NOT NULL DEFAULT 1 CHECK (ai_interval_minutes BETWEEN 1 AND 10080),
        ADD COLUMN IF NOT EXISTS ai_next_run_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS ai_last_run_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS ai_last_result JSONB,
        ADD COLUMN IF NOT EXISTS ai_revision INTEGER NOT NULL DEFAULT 0`);
    }
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
export async function settings() {
  return (await pool.query(`SELECT * FROM ${names.settings} WHERE id=1`))
    .rows[0];
}
