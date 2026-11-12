import express from "express";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { contactSchema, campaignSchema } from "./validation.js";
import { migrate, pool, names, settings } from "./db.js";
import { connect, status, send, draft } from "./telegram.js";
const app = express();
const token = crypto.randomBytes(32).toString("hex");
let dbReady = false,
  dbError = null;
app.use(express.json({ limit: "256kb" }));
app.use((req, res, next) => {
  const host = req.headers.host?.split(":")[0];
  if (!["localhost", "127.0.0.1"].includes(host))
    return res.status(403).json({ error: "Local access only" });
  const origin = req.headers.origin;
  if (
    origin &&
    origin !== process.env.PUBLIC_ORIGIN &&
    !/^http:\/\/(localhost|127\.0\.0\.1):(3001|5173)$/.test(origin)
  )
    return res.status(403).json({ error: "Origin rejected" });
  res.setHeader("Cache-Control", "no-store");
  next();
});
app.get("/api/health", (req, res) =>
  res.json({
    database: dbReady,
    databaseError: dbError,
    telegram: status(),
    openai: Boolean(process.env.OPENAI_API_KEY),
    token,
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
app.get("/api/contacts", async (req, res) =>
  res.json(
    (
      await pool.query(
        `SELECT c.*, (SELECT body FROM ${names.messages} m WHERE m.contact_id=c.id ORDER BY m.id DESC LIMIT 1) last_message, (SELECT created_at FROM ${names.messages} m WHERE m.contact_id=c.id ORDER BY m.id DESC LIMIT 1) last_activity FROM ${names.contacts} c ORDER BY last_activity DESC NULLS LAST,c.id DESC`,
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
    .object({ ai_enabled: z.boolean(), opted_out: z.boolean() })
    .parse(req.body);
  const r = await pool.query(
    `UPDATE ${names.contacts} SET ai_enabled=$1,opted_out=$2 WHERE id=$3 RETURNING *`,
    [v.opted_out ? false : v.ai_enabled, v.opted_out, id(req.params.id)],
  );
  if (!r.rowCount) return res.status(404).json({ error: "Contact not found" });
  res.json(r.rows[0]);
});
app.get("/api/contacts/:id/messages", async (req, res) =>
  res.json(
    (
      await pool.query(
        `SELECT * FROM (SELECT * FROM ${names.messages} WHERE contact_id=$1 ORDER BY id DESC LIMIT 200) recent ORDER BY id`,
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
  const r = await pool.query(
    `UPDATE ${names.campaigns} SET status='sending' WHERE id=$1 AND status='draft' RETURNING *`,
    [id(req.params.id)],
  );
  if (!r.rowCount)
    return res
      .status(409)
      .json({ error: "Campaign is already sent, sending, or unavailable" });
  const campaign = r.rows[0],
    results = [];
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
