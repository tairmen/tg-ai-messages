import { joinedGroup, validatePublicImageUrl } from "./groups-utils.js";
import { normalizeUsername, importedUser } from "./recipients.js";
import { telegramMessageContent } from "./message-content.js";
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
    requestRetries: 3,
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
    new NewMessage({}),
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
  const u = importedUser(result, contact.id);
  if (!u)
    throw Object.assign(
      new Error(
        "Telegram did not resolve this phone number. It may be hidden by privacy settings, not registered, or unavailable to this account. Use a username or ask the person to message this account first.",
      ),
      { httpStatus: 422 },
    );
  return (
    await pool.query(
      `UPDATE ${names.contacts} SET telegram_id=$1,access_hash=$2 WHERE id=$3 RETURNING *`,
      [u.id.toString(), u.accessHash?.toString(), contact.id],
    )
  ).rows[0];
}
export async function send(contact, text, source = "manual") {
  if (!account) throw new Error("Connect your Telegram account first");
  if (contact.opted_out)
    throw Object.assign(new Error("Contact has opted out"), {
      httpStatus: 409,
    });
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
  return { message_id: sent.id.toString() };
}
export async function draft(contactId) {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY missing");
  const s = await settings();
  const specific = (
    await pool.query(
      `SELECT ai_instructions FROM ${names.contacts} WHERE id=$1`,
      [contactId],
    )
  ).rows[0]?.ai_instructions;
  const history = (
    await pool.query(
      `SELECT direction,body FROM ${names.messages} WHERE contact_id=$1 ORDER BY created_at DESC,id DESC LIMIT 30`,
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
    instructions:
      s.instructions +
      (specific ? "\n\nConversation-specific instructions:\n" + specific : ""),
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
  const content = telegramMessageContent(m);
  if (!m.isPrivate || !content.body || !m.chatId) return;
  let c = (
    await pool.query(`SELECT * FROM ${names.contacts} WHERE telegram_id=$1`, [
      m.chatId.toString(),
    ])
  ).rows[0];
  if (!c) return;
  const inserted = await pool.query(
    `INSERT INTO ${names.messages}(contact_id,direction,body,source,telegram_message_id,metadata) VALUES($1,$4,$2,'telegram',$3,$5) ON CONFLICT DO NOTHING RETURNING id`,
    [
      c.id,
      content.body,
      m.id.toString(),
      m.out ? "out" : "in",
      JSON.stringify(content.metadata),
    ],
  );
  if (!inserted.rowCount || m.out || !m.message) return;
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

export async function syncConversation(
  contact,
  { limit = 100, before_message_id } = {},
) {
  if (!account)
    throw Object.assign(new Error("Connect Telegram first"), {
      httpStatus: 409,
    });
  if (!contact.telegram_id || !contact.access_hash)
    contact = await resolveContact(contact);
  const peer = new Api.InputPeerUser({
    userId: BigInt(contact.telegram_id),
    accessHash: BigInt(contact.access_hash),
  });
  const batch = await client.getMessages(peer, {
    limit,
    offsetId: before_message_id || 0,
  });
  const messages = [...batch]
    .filter((m) => telegramMessageContent(m).body)
    .reverse();
  let imported = 0;
  for (const m of messages) {
    const r = await pool.query(
      `INSERT INTO ${names.messages}(contact_id,direction,body,source,telegram_message_id,created_at,metadata) VALUES($1,$2,$3,'telegram',$4,$5,$6) ON CONFLICT DO NOTHING`,
      [
        contact.id,
        m.out ? "out" : "in",
        telegramMessageContent(m).body,
        m.id.toString(),
        new Date(m.date * 1000),
        JSON.stringify(telegramMessageContent(m).metadata),
      ],
    );
    imported += r.rowCount;
  }
  return {
    imported,
    fetched: batch.length,
    next_before_message_id: batch.length
      ? Math.min(...batch.map((m) => m.id))
      : null,
    may_have_more: batch.length === limit,
  };
}

export async function resolveUsername(value) {
  if (!account)
    throw Object.assign(new Error("Connect Telegram first"), {
      httpStatus: 409,
    });
  const username = normalizeUsername(value);
  const resolved = await client.invoke(
    new Api.contacts.ResolveUsername({ username }),
  );
  const user =
    resolved.peer instanceof Api.PeerUser
      ? resolved.users.find(
          (u) =>
            String(u.id) === String(resolved.peer.userId) &&
            !u.deleted &&
            !u.bot,
        )
      : null;
  if (!user || !user.accessHash)
    throw Object.assign(
      new Error(
        "This username does not resolve to a supported personal Telegram account.",
      ),
      { httpStatus: 422 },
    );
  const id = String(user.id),
    accessHash = String(user.accessHash);
  const visiblePhone = user.phone
    ? "+" + String(user.phone).replace(/^\+/, "")
    : null;
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      "relay-username:" + username,
    ]);
    await db.query(
      `UPDATE ${names.contacts} SET username=NULL WHERE lower(username)=$1 AND telegram_id IS DISTINCT FROM $2`,
      [username, id],
    );
    const existing = (
      await db.query(
        `SELECT * FROM ${names.contacts} WHERE telegram_id=$1 OR (phone=$2 AND telegram_id IS NULL) ORDER BY (telegram_id=$1) DESC NULLS LAST,id LIMIT 1 FOR UPDATE`,
        [id, visiblePhone],
      )
    ).rows[0];
    let contact;
    if (existing)
      contact = (
        await db.query(
          `UPDATE ${names.contacts} SET username=$1,telegram_id=$2,access_hash=$3 WHERE id=$4 RETURNING *`,
          [username, id, accessHash, existing.id],
        )
      ).rows[0];
    else
      contact = (
        await db.query(
          `INSERT INTO ${names.contacts}(name,phone,username,telegram_id,access_hash) VALUES($1,NULL,$2,$3,$4) RETURNING *`,
          [
            [user.firstName, user.lastName].filter(Boolean).join(" ") ||
              "@" + username,
            username,
            id,
            accessHash,
          ],
        )
      ).rows[0];
    await db.query("COMMIT");
    return contact;
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    db.release();
  }
}

export async function listGroups({
  limit = 100,
  offset_date,
  search = "",
} = {}) {
  if (!account)
    throw Object.assign(new Error("Connect Telegram first"), {
      httpStatus: 409,
    });
  const dialogs = await client.getDialogs({
    limit,
    offsetDate: offset_date || 0,
    ignorePinned: Boolean(offset_date),
  });
  const groups = [];
  for (const dialog of dialogs) {
    const e = dialog.entity;
    if (!dialog.isGroup || !joinedGroup(e)) continue;
    const type = e instanceof Api.Chat ? "chat" : "channel";
    const row = (
      await pool.query(
        `INSERT INTO ${names.groups}(telegram_id,peer_type,access_hash,title,username) VALUES($1,$2,$3,$4,$5) ON CONFLICT(peer_type,telegram_id) DO UPDATE SET access_hash=EXCLUDED.access_hash,title=EXCLUDED.title,username=EXCLUDED.username,updated_at=now() RETURNING id,title,username,peer_type`,
        [
          String(e.id),
          type,
          e.accessHash ? String(e.accessHash) : null,
          e.title,
          e.username || null,
        ],
      )
    ).rows[0];
    if (
      !search ||
      row.title
        .normalize("NFKC")
        .toLowerCase()
        .includes(search.normalize("NFKC").toLowerCase())
    )
      groups.push(row);
  }
  return {
    groups,
    dialogs_scanned: dialogs.length,
    may_have_more: dialogs.length === limit,
    next_offset_date: dialogs.length ? dialogs[dialogs.length - 1].date : null,
  };
}
async function groupPeer(group) {
  if (!account)
    throw Object.assign(new Error("Connect Telegram first"), {
      httpStatus: 409,
    });
  const peer =
    group.peer_type === "chat"
      ? new Api.InputPeerChat({ chatId: BigInt(group.telegram_id) })
      : new Api.InputPeerChannel({
          channelId: BigInt(group.telegram_id),
          accessHash: BigInt(group.access_hash),
        });
  const entity = await client.getEntity(peer);
  if (!joinedGroup(entity))
    throw Object.assign(
      new Error("The account is not an active member of this group."),
      { httpStatus: 403 },
    );
  return peer;
}
export async function sendGroup(group, body, imageUrl) {
  const peer = await groupPeer(group);
  let sent;
  if (imageUrl) {
    const url = await validatePublicImageUrl(imageUrl);
    sent = await client.sendFile(peer, {
      file: new Api.InputMediaPhotoExternal({ url }),
      caption: body || "",
      parseMode: false,
    });
  } else
    sent = await client.sendMessage(peer, { message: body, parseMode: false });
  await pool.query(
    `INSERT INTO ${names.group_messages}(group_id,body,telegram_message_id,image_url) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
    [group.id, body || "", String(sent.id), imageUrl || null],
  );
  return { message_id: String(sent.id), media: imageUrl ? "photo" : "text" };
}
export async function groupHistory(
  group,
  { limit = 50, before_message_id } = {},
) {
  const peer = await groupPeer(group);
  const batch = await client.getMessages(peer, {
    limit,
    offsetId: before_message_id || 0,
  });
  return {
    group_id: group.id,
    title: group.title,
    messages: [...batch]
      .reverse()
      .map((m) => ({
        message_id: String(m.id),
        direction: m.out ? "out" : "in",
        sender_id: m.senderId ? String(m.senderId) : null,
        ...telegramMessageContent(m),
        created_at: new Date(m.date * 1000).toISOString(),
      })),
    next_before_message_id: batch.length
      ? Math.min(...batch.map((m) => m.id))
      : null,
    may_have_more: batch.length === limit,
  };
}
