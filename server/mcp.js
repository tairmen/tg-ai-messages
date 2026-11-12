import express from "express";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createOAuthProvider } from "./mcp-oauth.js";
import { createRelayMcp } from "./mcp-tools.js";
import { scopes } from "./mcp-utils.js";
export function createPgOAuthStore(pool, table) {
  return {
    async get(kind, key) {
      return (
        await pool.query(
          `SELECT value FROM ${table} WHERE kind=$1 AND key=$2 AND expires_at>now()`,
          [kind, key],
        )
      ).rows[0]?.value;
    },
    async put(kind, key, value, ttl) {
      await pool.query(`DELETE FROM ${table} WHERE expires_at<=now()`);
      await pool.query(
        `INSERT INTO ${table}(kind,key,value,expires_at) VALUES($1,$2,$3,now()+$4*interval '1 second') ON CONFLICT(kind,key) DO UPDATE SET value=EXCLUDED.value,expires_at=EXCLUDED.expires_at`,
        [kind, key, JSON.stringify(value), ttl],
      );
    },
    async take(kind, key) {
      return (
        await pool.query(
          `DELETE FROM ${table} WHERE kind=$1 AND key=$2 AND expires_at>now() RETURNING value`,
          [kind, key],
        )
      ).rows[0]?.value;
    },
    async revokeGrant(grant) {
      await pool.query(`DELETE FROM ${table} WHERE value->>'grantId'=$1`, [
        grant,
      ]);
    },
  };
}
export function installMcp(app, { pool, names, api, origin }) {
  if (!origin) return;
  const store = createPgOAuthStore(pool, names.oauth);
  const provider = createOAuthProvider({ store, origin });
  const resource = new URL(origin + "/mcp");
  app.use((req, res, next) => {
    res.locals.relayAdmin = req.headers["x-relay-admin"] === "admin";
    next();
  });
  app.post(
    "/authorize/decision",
    express.urlencoded({ extended: false, limit: "8kb" }),
    (req, res, next) => provider.decide(req, res).catch(next),
  );
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: new URL(origin),
      resourceServerUrl: resource,
      scopesSupported: scopes,
      resourceName: "Relay Telegram workspace",
      clientRegistrationOptions: { rateLimit: { max: 20, windowMs: 3600000 } },
    }),
  );
  const auth = requireBearerAuth({
    verifier: provider,
    expectedResource: resource,
    resourceMetadataUrl: origin + "/.well-known/oauth-protected-resource/mcp",
  });
  app.all("/mcp", auth, async (req, res) => {
    if (req.method !== "POST") {
      res
        .set("Allow", "POST")
        .status(405)
        .json({ error: "Use Streamable HTTP POST" });
      return;
    }
    const server = createRelayMcp({
      api,
      query: (...args) => pool.query(...args),
      names,
      auth: req.auth,
      audit: async (client, tool, outcome) => {
        await pool.query(
          `INSERT INTO ${names.audit}(client_id,tool,outcome) VALUES($1,$2,$3)`,
          [client, tool, outcome],
        );
      },
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent)
        res.status(500).json({ error: "MCP request failed" });
    }
  });
  // Dashboard-only connection management. These routes require the existing admin API token.
  return {
    async connections() {
      return (
        await pool.query(
          `SELECT DISTINCT value->>'grantId' AS grant_id,value->>'clientId' AS client_id,value->'scopes' AS scopes FROM ${names.oauth} WHERE kind='refresh' AND expires_at>now()`,
        )
      ).rows;
    },
    revoke: (grant) => store.revokeGrant(grant),
  };
}
