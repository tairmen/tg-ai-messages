import "dotenv/config";
import pg from "pg";
export const table = process.env.POSTGRES_TABLE || "telegram_contacts";
if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table) || table.length > 40)
  throw new Error(
    "POSTGRES_TABLE must be a simple SQL identifier, at most 40 characters",
  );
export const names = Object.fromEntries(
  ["contacts", "messages", "campaigns", "settings"].map((k) => [
    k,
    `"${k === "contacts" ? table : table + "_" + k}"`,
  ]),
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
