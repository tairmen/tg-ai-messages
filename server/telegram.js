import "dotenv/config";
import fs from "node:fs/promises";
import { TelegramClient, Api } from "teleproto";
import { StringSession } from "teleproto/sessions/index.js";
import { NewMessage } from "teleproto/events/index.js";
import { pool, names, settings } from "./db.js";
import OpenAI from "openai";
export const sessionPath = new URL(
  "../.data/telegram.session",
  import.meta.url,
);
export function credentials() {
  const id = Number(process.env.TELEGRAM_API_ID || process.env.api_id);
  const hash = process.env.TELEGRAM_API_HASH || process.env.api_hash;
  if (!id || !hash) throw new Error("Telegram API credentials missing");
  return { id, hash };
}
export function makeClient(session = "") {
  const { id, hash } = credentials();
  return new TelegramClient(new StringSession(session), id, hash, {
    connectionRetries: 3,
    requestRetries: 0,
    floodSleepThreshold: 0,
  });
}
let client, account, lastError;
const busy = new Set(),
  waiting = new Set();
export function status() {
  return {
    connected: Boolean(account),
    account: account
      ? { name: account.firstName, username: account.username }
      : null,
    error: lastError,
  };
}
export async function connect() {
  if (account) return status();
  let session;
  try {
    session = await fs.readFile(sessionPath, "utf8");
  } catch {
    return status();
  }
  client = makeClient(session);
  await client.connect();
  if (!(await client.isUserAuthorized())) {
    await client.disconnect();
    throw new Error("Run npm run telegram:login");
  }
  const me = await client.getMe();
  account = me;
  lastError = null;
  client.addEventHandler(
    (e) =>
      incoming(e).catch(() => {
        lastError =
          "Incoming message processing failed. Check database and API configuration.";
      }),
    new NewMessage({ incoming: true }),
  );
  return status();
}
export async function resolveContact(contact) {
  if (!account) throw new Error("Connect your Telegram account first");
  const result = await client.invoke(
    new Api.contacts.ImportContacts({
      contacts: [
        new Api.InputPhoneContact({
          clientId: BigInt(contact.id),
          phone: contact.phone,
          firstName: contact.name,
          lastName: "",
        }),
      ],
    }),
  );
  const u = result.users.find((u) => !u.bot && !u.deleted);
  if (!u) throw new Error("Number not discoverable on Telegram");
  return (
    await pool.query(
      `UPDATE ${names.contacts} SET telegram_id=$1,access_hash=$2 WHERE id=$3 RETURNING *`,
      [u.id.toString(), u.accessHash?.toString(), contact.id],
    )
  ).rows[0];
}
export async function send(contact, text, source = "manual") {
  if (!account) throw new Error("Connect your Telegram account first");
  if (contact.opted_out) throw new Error("Contact has opted out");
  if (!contact.telegram_id || !contact.access_hash)
    contact = await resolveContact(contact);
  const peer = new Api.InputPeerUser({
    userId: BigInt(contact.telegram_id),
    accessHash: BigInt(contact.access_hash),
  });
  const sent = await client.sendMessage(peer, {
    message: text,
    parseMode: false,
  });
  await pool.query(
    `INSERT INTO ${names.messages}(contact_id,direction,body,source,telegram_message_id) VALUES($1,'out',$2,$3,$4) ON CONFLICT DO NOTHING`,
    [contact.id, text, source, sent.id.toString()],
  );
}
export async function draft(contactId) {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY missing");
  const s = await settings();
  const history = (
    await pool.query(
      `SELECT direction,body FROM ${names.messages} WHERE contact_id=$1 ORDER BY id DESC LIMIT 30`,
      [contactId],
    )
  ).rows.reverse();
  if (!history.length) throw new Error("No conversation history yet");
  const ai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    timeout: 30000,
    maxRetries: 1,
  });
  const response = await ai.responses.create({
    model: s.model,
    instructions: s.instructions,
    input: history.map((m) => ({
      role: m.direction === "in" ? "user" : "assistant",
      content: m.body,
    })),
    max_output_tokens: 500,
    store: false,
  });
  if (!response.output_text?.trim()) throw new Error("AI returned no text");
  return response.output_text.trim();
}
async function incoming(event) {
  const m = event.message;
  if (!m.isPrivate || !m.message || !m.senderId) return;
  let c = (
    await pool.query(`SELECT * FROM ${names.contacts} WHERE telegram_id=$1`, [
      m.senderId.toString(),
    ])
  ).rows[0];
  if (!c) return;
  const inserted = await pool.query(
    `INSERT INTO ${names.messages}(contact_id,direction,body,source,telegram_message_id) VALUES($1,'in',$2,'telegram',$3) ON CONFLICT DO NOTHING RETURNING id`,
    [c.id, m.message, m.id.toString()],
  );
  if (!inserted.rowCount) return;
  if (/^(stop|unsubscribe|відписатися|стоп)$/i.test(m.message.trim())) {
    await pool.query(
      `UPDATE ${names.contacts} SET opted_out=true,ai_enabled=false WHERE id=$1`,
      [c.id],
    );
    return;
  }
  const s = await settings();
  if (!s.enabled || !c.ai_enabled || c.opted_out) return;
  if (busy.has(c.id)) {
    waiting.add(c.id);
    return;
  }
  busy.add(c.id);
  try {
    do {
      waiting.delete(c.id);
      const text = await draft(c.id);
      if (waiting.has(c.id)) continue;
      c = (
        await pool.query(`SELECT * FROM ${names.contacts} WHERE id=$1`, [c.id])
      ).rows[0];
      if ((await settings()).enabled && c.ai_enabled && !c.opted_out)
        await send(c, text, "ai");
    } while (waiting.has(c.id));
  } finally {
    busy.delete(c.id);
    waiting.delete(c.id);
  }
}
