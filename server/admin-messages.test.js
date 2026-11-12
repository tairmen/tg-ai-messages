import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import express from "express";
import { installAdminAuth, verifyHtpasswd } from "./admin-auth.js";
import { sendOnce } from "./direct-messages.js";
function store() {
  const data = new Map();
  return {
    async get(k, id) {
      return data.get(k + id);
    },
    async put(k, id, v) {
      data.set(k + id, v);
    },
    async take(k, id) {
      const row = data.get(k + id);
      data.delete(k + id);
      return row;
    },
  };
}
test("admin login uses an HttpOnly session, protects APIs, redirects OAuth, and logout invalidates cookie", async () => {
  const app = express();
  app.use(express.json());
  const sessions = store();
  installAdminAuth(app, {
    store: sessions,
    origin: "https://relay.example",
    internalKey: "private-bridge",
    verify: async (u, p) => u === "admin" && p === "test-pass",
  });
  app.get("/api/protected", (req, res) => res.json({ ok: true }));
  app.get("/authorize", (req, res) =>
    res.json({ admin: res.locals.relayAdmin }),
  );
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = "http://127.0.0.1:" + server.address().port;
  try {
    assert.equal((await fetch(base + "/api/protected")).status, 401);
    const authRedirect = await fetch(base + "/authorize?client_id=test", {
      redirect: "manual",
    });
    assert.equal(authRedirect.status, 302);
    assert.match(authRedirect.headers.get("location"), /\/login\?next=/);
    assert.equal(
      (
        await fetch(base + "/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: "admin", password: "wrong" }),
        })
      ).status,
      401,
    );
    const login = await fetch(base + "/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "test-pass" }),
    });
    assert.equal(login.status, 200);
    const setCookie = login.headers.get("set-cookie");
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /Secure/);
    assert.match(setCookie, /SameSite=Lax/);
    const cookie = setCookie.split(";")[0];
    assert.equal(
      (await fetch(base + "/api/protected", { headers: { Cookie: cookie } }))
        .status,
      200,
    );
    assert.equal(
      (
        await (
          await fetch(base + "/authorize", { headers: { Cookie: cookie } })
        ).json()
      ).admin,
      true,
    );
    await fetch(base + "/api/auth/logout", {
      method: "POST",
      headers: { Cookie: cookie },
    });
    assert.equal(
      (await fetch(base + "/api/protected", { headers: { Cookie: cookie } }))
        .status,
      401,
    );
    assert.equal(
      (
        await fetch(base + "/api/protected", {
          headers: { "X-Relay-Internal": "private-bridge" },
        })
      ).status,
      200,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
test("existing admin credentials remain compatible with the new login page", () => {
  const line =
    "admin:{SHA}" +
    crypto.createHash("sha1").update("existing-password").digest("base64") +
    "\n";
  assert.equal(verifyHtpasswd(line, "admin", "existing-password"), true);
  assert.equal(verifyHtpasswd(line, "admin", "incorrect"), false);
});
test("duplicate direct-message requests never send twice; payload conflicts are rejected", async () => {
  const rows = new Map();
  let sends = 0;
  const options = {
    claim: async (id, fingerprint) => {
      if (rows.has(id)) return rows.get(id);
      rows.set(id, { fingerprint, status: "sending" });
      return null;
    },
    finish: async (id, status, result) =>
      Object.assign(rows.get(id), { status, result }),
    loadContact: async () => ({ id: 1, phone: "+380631234567" }),
    send: async () => {
      sends++;
      return { message_id: "1" };
    },
  };
  const request = {
    request_id: "unit-message-1",
    contact_id: 1,
    body: "Hello",
  };
  const first = await sendOnce({ ...options, request });
  assert.equal(first.status, "sent");
  assert.deepEqual(await sendOnce({ ...options, request }), first);
  assert.equal(sends, 1);
  await assert.rejects(
    sendOnce({ ...options, request: { ...request, body: "Different" } }),
    /different message/,
  );
  assert.equal(sends, 1);
});
test("uncertain delivery is recorded and is not automatically retried", async () => {
  let row,
    sends = 0;
  const request = { request_id: "unit-uncertain", contact_id: 1, body: "Test" };
  const options = {
    request,
    claim: async (_, fingerprint) => {
      if (row) return row;
      row = { fingerprint, status: "sending" };
      return null;
    },
    finish: async (_, status, result) => Object.assign(row, { status, result }),
    loadContact: async () => ({ id: 1 }),
    send: async () => {
      sends++;
      throw new Error("network interrupted");
    },
  };
  assert.equal((await sendOnce(options)).status, "uncertain");
  assert.equal((await sendOnce(options)).status, "uncertain");
  assert.equal(sends, 1);
});
