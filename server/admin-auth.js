import crypto from "node:crypto";
import fs from "node:fs/promises";
import { hash, random } from "./mcp-utils.js";
export function verifyHtpasswd(text, username, password) {
  const row = text
    .split(/\r?\n/)
    .find((line) => line.startsWith(username + ":"));
  if (!row || username !== "admin") return false;
  const expected = row.slice(username.length + 1);
  if (!expected.startsWith("{SHA}")) return false;
  const actual =
    "{SHA}" + crypto.createHash("sha1").update(password).digest("base64");
  return (
    actual.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
  );
}
export function installAdminAuth(
  app,
  { store, internalKey, origin, verify, enabled = Boolean(origin) },
) {
  const cookieOptions = {
    httpOnly: true,
    secure: Boolean(origin?.startsWith("https:")),
    sameSite: "lax",
    path: "/",
  };
  const failures = new Map();
  app.use(async (req, res, next) => {
    try {
      const session = (req.headers.cookie || "")
        .split(";")
        .map((x) => x.trim())
        .find((x) => x.startsWith("relay_admin="))
        ?.slice(12);
      const user = session
        ? await store.get("adminsession", hash(session))
        : null;
      req.relayAdmin =
        !enabled ||
        Boolean(user) ||
        req.headers["x-relay-internal"] === internalKey;
      res.locals.relayAdmin = req.relayAdmin;
      req.adminSession = session;
      next();
    } catch (e) {
      next(e);
    }
  });
  app.get("/api/auth/session", (req, res) =>
    res.json({
      authenticated: req.relayAdmin,
      username: req.relayAdmin ? "admin" : null,
    }),
  );
  app.post("/api/auth/login", async (req, res) => {
    const ip = req.headers["x-real-ip"] || req.ip;
    const now = Date.now();
    for (const [key, v] of failures) if (v.until < now) failures.delete(key);
    const failed = failures.get(ip);
    if (failed?.count >= 8)
      return res
        .status(429)
        .json({ error: "Too many attempts. Try again in 15 minutes." });
    const { username, password } = req.body || {};
    if (
      typeof username !== "string" ||
      typeof password !== "string" ||
      username.length > 100 ||
      password.length > 500
    )
      return res
        .status(400)
        .json({ error: "Enter your username and password." });
    let valid = false;
    try {
      valid = await verify(username, password);
    } catch {}
    if (!valid) {
      if (failures.size > 1000) failures.clear();
      failures.set(ip, {
        count: (failed?.count || 0) + 1,
        until: failed?.until || now + 900000,
      });
      return res.status(401).json({ error: "Incorrect username or password." });
    }
    failures.delete(ip);
    const session = random();
    await store.put("adminsession", hash(session), { username }, 86400);
    res.cookie("relay_admin", session, { ...cookieOptions, maxAge: 86400000 });
    res.json({ authenticated: true, username });
  });
  app.post("/api/auth/logout", async (req, res) => {
    if (req.adminSession)
      await store.take("adminsession", hash(req.adminSession));
    res.clearCookie("relay_admin", cookieOptions);
    res.json({ authenticated: false });
  });
  app.use((req, res, next) => {
    if (req.path.startsWith("/api/") && !req.relayAdmin)
      return res
        .status(401)
        .json({ error: "Sign in to your Relay workspace." });
    if (req.path.startsWith("/authorize") && !req.relayAdmin) {
      if (req.method !== "GET")
        return res.status(401).send("Sign in again and restart authorization.");
      return res.redirect(
        (origin || "") + "/login?next=" + encodeURIComponent(req.originalUrl),
      );
    }
    next();
  });
}
export async function verifyAdminPassword(username, password) {
  return verifyHtpasswd(
    await fs.readFile(
      new URL("../.data/admin.htpasswd", import.meta.url),
      "utf8",
    ),
    username,
    password,
  );
}
