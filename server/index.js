import { normalizeUsername } from "./recipients.js";
import { sendOnce } from "./direct-messages.js";
import express from "express";
import { installAdminAuth, verifyAdminPassword } from "./admin-auth.js";
import { createPgOAuthStore } from "./mcp.js";
import { installMcp } from "./mcp.js";
import { previewCampaign } from "./mcp-utils.js";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { contactSchema, campaignSchema } from "./validation.js";
import { migrate, pool, names, settings } from "./db.js";
import {
  connect,
  status,
  send,
  draft,
  syncConversation,
  resolveUsername,
  resolveContact,
  listGroups,
  sendGroup,
  groupHistory,
} from "./telegram.js";
const app = express();
const token = crypto.randomBytes(32).toString("hex");
const internalKey = crypto.randomBytes(32).toString("hex");
let dbReady = false,
  dbError = null;
app.use(express.json({ limit: "256kb" }));
app.use((req, res, next) => {
  const host = req.headers.host?.split(":")[0];
  if (!["localhost", "127.0.0.1"].includes(host))
    return res.status(403).json({ error: "Local access only" });
  const origin = req.headers.origin;
  const publicOAuth = /^\/(?:\.well-known\/|register$|token$|revoke$)/.test(
    req.path,
  );
  const chatMcp =
    req.path.replace(/\/$/, "") === "/mcp" &&
    [
      "https://chatgpt.com",
      "https://chat.openai.com",
      "https://claude.ai",
    ].includes(origin);
  if (
    origin &&
    !publicOAuth &&
    !chatMcp &&
    origin !== process.env.PUBLIC_ORIGIN &&
    !(origin === process.env.MCP_ORIGIN && req.path.startsWith("/authorize")) &&
    !/^http:\/\/(localhost|127\.0\.0\.1):(3001|5173)$/.test(origin)
  )
    return res.status(403).json({ error: "Origin rejected" });
  res.setHeader("Cache-Control", "no-store");
  next();
});
installAdminAuth(app, {
  store: createPgOAuthStore(pool, names.oauth),
  internalKey,
  origin: process.env.PUBLIC_ORIGIN,
  verify: verifyAdminPassword,
});
const mcp = installMcp(app, {
  pool,
  names,
  origin: process.env.MCP_ORIGIN || process.env.PUBLIC_ORIGIN,
  legacyOrigin: process.env.PUBLIC_ORIGIN,
  api: async (route, method = "GET", body) => {
    const response = await fetch("http://127.0.0.1:3001/api" + route, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Admin-Token": token,
        "X-Relay-Internal": internalKey,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await response.json();
    if (!response.ok)
      throw Object.assign(new Error("Admin API request failed"), {
        publicMessage: data.error,
      });
    return data;
  },
});
app.get("/api/health", (req, res) =>
  res.json({
    database: dbReady,
    databaseError: dbError,
    telegram: status(),
    openai: Boolean(process.env.OPENAI_API_KEY),
    token,
    mcp_url:
      process.env.MCP_ORIGIN || process.env.PUBLIC_ORIGIN
        ? (process.env.MCP_ORIGIN || process.env.PUBLIC_ORIGIN) + "/mcp"
        : null,
  }),
);
app.use("/api", (req, res, next) => {
  if (req.headers["x-admin-token"] !== token)
    return res
      .status(403)
      .json({ error: "Refresh the dashboard to establish a session" });
  if (!dbReady)
    return res.status(503).json({ error: dbError || "Database unavailable" });
  next();
});
app.get("/api/mcp/connections", async (req, res) =>
  res.json((await mcp?.connections()) || []),
);
app.delete("/api/mcp/connections/:grant", async (req, res) => {
  await mcp?.revoke(req.params.grant);
  res.json({ revoked: true });
});
app.get("/api/contacts", async (req, res) =>
  res.json(
    (
      await pool.query(
        `SELECT c.*, (SELECT body FROM ${names.messages} m WHERE m.contact_id=c.id ORDER BY m.created_at DESC,m.id DESC LIMIT 1) last_message, (SELECT created_at FROM ${names.messages} m WHERE m.contact_id=c.id ORDER BY m.id DESC LIMIT 1) last_activity FROM ${names.contacts} c ORDER BY last_activity DESC NULLS LAST,c.id DESC`,
      )
    ).rows,
  ),
);
app.post("/api/contacts", async (req, res) => {
  const c = contactSchema.parse(req.body);
  res
    .status(201)
    .json(
      (
        await pool.query(
          `INSERT INTO ${names.contacts}(name,phone) VALUES($1,$2) ON CONFLICT(phone) DO UPDATE SET name=EXCLUDED.name RETURNING *`,
          [c.name, c.phone],
        )
      ).rows[0],
    );
});
app.post("/api/contacts/import", async (req, res) => {
  const rows = z.array(contactSchema).min(1).max(500).parse(req.body.contacts);
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    for (const row of rows)
      await c.query(
        `INSERT INTO ${names.contacts}(name,phone) VALUES($1,$2) ON CONFLICT(phone) DO UPDATE SET name=EXCLUDED.name`,
        [row.name, row.phone],
      );
    await c.query("COMMIT");
    res.json({ imported: rows.length });
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
});
app.patch("/api/contacts/:id", async (req, res) => {
  const v = z
    .object({
      ai_enabled: z.boolean().optional(),
      opted_out: z.boolean().optional(),
      ai_instructions: z.string().max(12000).optional(),
    })
    .refine((v) => Object.keys(v).length > 0)
    .parse(req.body);
  const c = await contact(req.params.id);
  const next = { ...c, ...v };
  if (next.opted_out) next.ai_enabled = false;
  const row = (
    await pool.query(
      `UPDATE ${names.contacts} SET ai_enabled=$1,opted_out=$2,ai_instructions=$3 WHERE id=$4 RETURNING *`,
      [next.ai_enabled, next.opted_out, next.ai_instructions, c.id],
    )
  ).rows[0];
  res.json(row);
});
app.post("/api/recipients/resolve", async (req, res) => {
  const target = z
    .object({ username: z.string().optional(), phone: z.string().optional() })
    .refine(
      (v) => Boolean(v.username) !== Boolean(v.phone),
      "Provide username or phone",
    )
    .parse(req.body);
  let c;
  if (target.username) c = await resolveUsername(target.username);
  else {
    const p = contactSchema.parse({
      name: target.phone,
      phone: target.phone,
    }).phone;
    c = (
      await pool.query(`SELECT * FROM ${names.contacts} WHERE phone=$1`, [p])
    ).rows[0];
    if (!c)
      c = (
        await pool.query(
          `INSERT INTO ${names.contacts}(name,phone) VALUES($1,$1) ON CONFLICT(phone) DO UPDATE SET phone=EXCLUDED.phone RETURNING *`,
          [p],
        )
      ).rows[0];
    c = await resolveContact(c);
  }
  res.json({
    contact_id: c.id,
    name: c.name,
    username: c.username,
    phone: c.phone,
    matched_by: target.username ? "username" : "phone",
  });
});
app.post("/api/messages/send", async (req, res) => {
  const request = z
    .object({
      request_id: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/),
      contact_id: z.number().int().positive().optional(),
      phone: z.string().optional(),
      username: z.string().optional(),
      name: z.string().trim().max(120).optional(),
      body: z.string().trim().min(1).max(4000),
    })
    .refine(
      (v) => [v.contact_id, v.phone, v.username].filter(Boolean).length === 1,
      "Provide exactly one of contact_id, phone, or username",
    )
    .parse(req.body);
  if (request.username) request.username = normalizeUsername(request.username);
  if (request.phone)
    request.phone = contactSchema.parse({
      name: request.name || request.phone,
      phone: request.phone,
    }).phone;
  if (!status().connected)
    return res.status(409).json({ error: "Connect Telegram first" });
  const result = await sendOnce({
    request,
    send,
    claim: async (id, fingerprint) => {
      const r = await pool.query(
        `INSERT INTO ${names.deliveries}(request_id,fingerprint,status) VALUES($1,$2,'sending') ON CONFLICT DO NOTHING RETURNING request_id`,
        [id, fingerprint],
      );
      if (r.rowCount) return null;
      return (
        await pool.query(
          `SELECT * FROM ${names.deliveries} WHERE request_id=$1`,
          [id],
        )
      ).rows[0];
    },
    finish: async (id, state, result) => {
      await pool.query(
        `UPDATE ${names.deliveries} SET status=$1,result=$2 WHERE request_id=$3`,
        [state, JSON.stringify(result), id],
      );
    },
    loadContact: async (r) => {
      if (r.contact_id) return contact(r.contact_id);
      if (r.username) return resolveUsername(r.username);
      const c = (
        await pool.query(`SELECT * FROM ${names.contacts} WHERE phone=$1`, [
          r.phone,
        ])
      ).rows[0];
      if (c) return c;
      return (
        await pool.query(
          `INSERT INTO ${names.contacts}(name,phone) VALUES($1,$2) ON CONFLICT(phone) DO UPDATE SET phone=EXCLUDED.phone RETURNING *`,
          [r.name || r.phone, r.phone],
        )
      ).rows[0];
    },
  });
  res.json(result);
});
app.get("/api/groups", async (req, res) => {
  const options = z
    .object({
      limit: z.coerce.number().int().min(1).max(500).default(100),
      offset_date: z.coerce.number().int().positive().optional(),
      search: z.string().max(200).optional(),
    })
    .parse(req.query);
  res.json(await listGroups(options));
});
async function groupById(value) {
  const g = (
    await pool.query(`SELECT * FROM ${names.groups} WHERE id=$1`, [id(value)])
  ).rows[0];
  if (!g)
    throw Object.assign(
      new Error("Group not found. Find its group_id using list_groups first."),
      { httpStatus: 404 },
    );
  return g;
}
app.get("/api/groups/:id/messages", async (req, res) =>
  res.json(
    await groupHistory(
      await groupById(req.params.id),
      z
        .object({
          limit: z.coerce.number().int().min(1).max(100).default(50),
          before_message_id: z.coerce.number().int().positive().optional(),
        })
        .parse(req.query),
    ),
  ),
);
app.post("/api/groups/send", async (req, res) => {
  const request = z
    .object({
      group_id: z.number().int().positive(),
      request_id: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/),
      body: z.string().trim().max(4000).default(""),
      image_url: z.url().optional(),
    })
    .refine(
      (r) => r.body.length > 0 || r.image_url,
      "Provide text or an image URL",
    )
    .refine(
      (r) => !r.image_url || r.body.length <= 1024,
      "Photo captions must be at most 1024 characters",
    )
    .parse(req.body);
  const result = await sendOnce({
    request,
    loadContact: () => groupById(request.group_id),
    send: (g, text) => sendGroup(g, text, request.image_url),
    claim: async (key, fingerprint) => {
      const r = await pool.query(
        `INSERT INTO ${names.deliveries}(request_id,fingerprint,status) VALUES($1,$2,'sending') ON CONFLICT DO NOTHING RETURNING request_id`,
        [key, fingerprint],
      );
      return r.rowCount
        ? null
        : (
            await pool.query(
              `SELECT * FROM ${names.deliveries} WHERE request_id=$1`,
              [key],
            )
          ).rows[0];
    },
    finish: async (key, state, result) => {
      await pool.query(
        `UPDATE ${names.deliveries} SET status=$1,result=$2 WHERE request_id=$3`,
        [state, JSON.stringify(result), key],
      );
    },
  });
  res.json(result);
});
app.get("/api/conversations", async (req, res) => {
  const { limit, offset } = z
    .object({
      limit: z.coerce.number().int().min(1).max(100).default(30),
      offset: z.coerce.number().int().min(0).default(0),
    })
    .parse(req.query);
  const rows = (
    await pool.query(
      `SELECT c.id,c.name,c.phone,c.ai_enabled,c.ai_instructions,c.opted_out,(SELECT count(*)::int FROM ${names.messages} m WHERE m.contact_id=c.id) AS message_count,(SELECT body FROM ${names.messages} m WHERE m.contact_id=c.id ORDER BY created_at DESC,id DESC LIMIT 1) AS last_message,(SELECT created_at FROM ${names.messages} m WHERE m.contact_id=c.id ORDER BY created_at DESC,id DESC LIMIT 1) AS last_activity FROM ${names.contacts} c ORDER BY last_activity DESC NULLS LAST,c.id LIMIT $1 OFFSET $2`,
      [limit, offset],
    )
  ).rows;
  res.json({
    conversations: rows,
    global_ai_enabled: (await settings()).enabled,
  });
});
app.get("/api/conversations/:id", async (req, res) => {
  const c = await contact(req.params.id);
  const { limit, before_id } = z
    .object({
      limit: z.coerce.number().int().min(1).max(200).default(100),
      before_id: z.string().regex(/^\d+$/).optional(),
    })
    .parse(req.query);
  const rows = (
    await pool.query(
      `SELECT * FROM ${names.messages} WHERE contact_id=$1 AND ($2::bigint IS NULL OR (created_at,id)<(SELECT created_at,id FROM ${names.messages} WHERE id=$2 AND contact_id=$1)) ORDER BY created_at DESC,id DESC LIMIT $3`,
      [c.id, before_id || null, limit + 1],
    )
  ).rows;
  const has_more = rows.length > limit;
  const messages = rows.slice(0, limit).reverse();
  const master = (await settings()).enabled;
  const { access_hash, ...safe } = c;
  res.json({
    contact: safe,
    global_ai_enabled: master,
    effective_ai_enabled: master && c.ai_enabled && !c.opted_out,
    messages,
    has_more,
    next_before_id: has_more ? messages[0]?.id : null,
  });
});
app.post("/api/conversations/:id/sync", async (req, res) => {
  const options = z
    .object({
      limit: z.number().int().min(1).max(100).default(100),
      before_message_id: z.number().int().positive().optional(),
    })
    .parse(req.body || {});
  res.json(await syncConversation(await contact(req.params.id), options));
});
app.get("/api/contacts/:id/messages", async (req, res) =>
  res.json(
    (
      await pool.query(
        `SELECT * FROM (SELECT * FROM ${names.messages} WHERE contact_id=$1 ORDER BY created_at DESC,id DESC LIMIT 200) recent ORDER BY created_at,id`,
        [id(req.params.id)],
      )
    ).rows,
  ),
);
app.post("/api/contacts/:id/send", async (req, res) => {
  const { body } = z
    .object({ body: z.string().trim().min(1).max(4000) })
    .parse(req.body);
  const c = await contact(req.params.id);
  await send(c, body);
  res.json({ sent: true });
});
app.post("/api/contacts/:id/draft", async (req, res) => {
  await contact(req.params.id);
  res.json({ text: await draft(id(req.params.id)) });
});
app.get("/api/settings", async (req, res) => res.json(await settings()));
app.put("/api/settings", async (req, res) => {
  const s = z
    .object({
      instructions: z.string().trim().min(1).max(20000),
      model: z.string().trim().min(1).max(100),
      enabled: z.boolean(),
    })
    .parse(req.body);
  res.json(
    (
      await pool.query(
        `UPDATE ${names.settings} SET instructions=$1,model=$2,enabled=$3 WHERE id=1 RETURNING *`,
        [s.instructions, s.model, s.enabled],
      )
    ).rows[0],
  );
});
app.post("/api/telegram/connect", async (req, res) =>
  res.json(await connect()),
);
app.get("/api/campaigns", async (req, res) =>
  res.json(
    (
      await pool.query(
        `SELECT * FROM ${names.campaigns} ORDER BY id DESC LIMIT 100`,
      )
    ).rows,
  ),
);
app.post("/api/campaigns", async (req, res) => {
  const c = campaignSchema.parse(req.body);
  res
    .status(201)
    .json(
      (
        await pool.query(
          `INSERT INTO ${names.campaigns}(name,body,recipient_ids) VALUES($1,$2,$3) RETURNING *`,
          [c.name, c.body, JSON.stringify(c.recipient_ids)],
        )
      ).rows[0],
    );
});
app.post("/api/campaigns/:id/send", async (req, res) => {
  if (!status().connected)
    return res.status(409).json({ error: "Connect Telegram first" });
  const db = await pool.connect();
  let campaign, snapshot;
  try {
    await db.query("BEGIN");
    campaign = (
      await db.query(
        `SELECT * FROM ${names.campaigns} WHERE id=$1 FOR UPDATE`,
        [id(req.params.id)],
      )
    ).rows[0];
    if (!campaign || campaign.status !== "draft") {
      await db.query("ROLLBACK");
      return res
        .status(409)
        .json({ error: "Campaign is already sent, sending, or unavailable" });
    }
    snapshot = (
      await db.query(
        `SELECT * FROM ${names.contacts} WHERE id=ANY($1::int[]) ORDER BY id FOR SHARE`,
        [campaign.recipient_ids],
      )
    ).rows;
    const preview = previewCampaign(campaign, snapshot);
    if (
      req.body?.preview_hash &&
      req.body.preview_hash !== preview.preview_hash
    ) {
      await db.query("ROLLBACK");
      return res.status(409).json({
        error:
          "Campaign preview changed. Preview it again and ask the user before sending.",
      });
    }
    if (preview.recipients.some((c) => c.opted_out)) {
      await db.query("ROLLBACK");
      return res.status(409).json({
        error:
          "A selected contact has opted out. Create a draft with active contacts.",
      });
    }
    await db.query(
      `UPDATE ${names.campaigns} SET status='sending' WHERE id=$1`,
      [campaign.id],
    );
    await db.query("COMMIT");
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    db.release();
  }
  const results = [];
  let halted = false;
  for (const contactId of campaign.recipient_ids) {
    if (halted) {
      results.push({
        contact_id: contactId,
        status: "skipped",
        error: "Stopped after Telegram rejected a request",
      });
      continue;
    }
    try {
      const c = await contact(contactId);
      const original = snapshot.find((row) => row.id === contactId);
      c.name = original.name;
      await send(c, campaign.body.replaceAll("{{name}}", c.name), "campaign");
      results.push({ contact_id: contactId, status: "sent" });
    } catch (e) {
      const code = e.errorMessage || "";
      results.push({
        contact_id: contactId,
        status: "failed",
        error: code || e.message,
      });
      if (/FLOOD|PEER_FLOOD|USER_RESTRICTED|AUTH_KEY|SESSION/i.test(code))
        halted = true;
    }
    await pool.query(`UPDATE ${names.campaigns} SET results=$1 WHERE id=$2`, [
      JSON.stringify(results),
      campaign.id,
    ]);
  }
  const final = results.every((r) => r.status === "sent")
    ? "completed"
    : "partial";
  await pool.query(
    `UPDATE ${names.campaigns} SET status=$1,results=$2 WHERE id=$3`,
    [final, JSON.stringify(results), campaign.id],
  );
  res.json({ status: final, results });
});
function id(v) {
  return z.coerce.number().int().positive().parse(v);
}
async function contact(v) {
  const c = (
    await pool.query(`SELECT * FROM ${names.contacts} WHERE id=$1`, [id(v)])
  ).rows[0];
  if (!c)
    throw Object.assign(new Error("Contact not found"), { httpStatus: 404 });
  return c;
}
app.use(
  express.static(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../dist"),
  ),
);
app.get("/login", (req, res) =>
  res.sendFile(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../dist/index.html",
    ),
  ),
);
app.use((err, req, res, next) => {
  const validation = err instanceof z.ZodError;
  const safe = validation
    ? err.issues.map((i) => i.message).join("; ")
    : err.errorMessage ||
      {
        23505: "This record already exists",
        ECONNREFUSED: "Database connection refused",
      }[err.code] ||
      (err.httpStatus
        ? err.message
        : "Request failed. Check configuration, Telegram connection, and server terminal.");
  console.error("Request failed:", err.code || err.name);
  res.status(validation ? 400 : err.httpStatus || 500).json({ error: safe });
});
try {
  await migrate();
  dbReady = true;
  await pool.query(
    `UPDATE ${names.deliveries} SET status='uncertain' WHERE status='sending'`,
  );
  await pool.query(
    `UPDATE ${names.campaigns} SET status='interrupted' WHERE status='sending'`,
  );
} catch (e) {
  dbError = `Database setup failed (${e.code || "configuration"}). Check .env and restart.`;
  console.error(dbError);
}
if (dbReady)
  await connect().catch(() =>
    console.error("Telegram not connected. Run npm run telegram:login."),
  );
app.listen(3001, "127.0.0.1", () =>
  console.log("Relay API: http://127.0.0.1:3001"),
);
