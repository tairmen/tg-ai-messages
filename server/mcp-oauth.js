import {
  InvalidGrantError,
  InvalidTokenError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidClientMetadataError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { hash, random, scopes, escapeHtml } from "./mcp-utils.js";
export function createOAuthProvider({ store, origin, legacyOrigin }) {
  const resource = origin + "/mcp";
  const allowedResources = new Set([
    resource,
    ...(legacyOrigin ? [legacyOrigin + "/mcp"] : []),
  ]);
  const checkResource = (r) => {
    if (r && !allowedResources.has(r.toString().replace(/\/$/, "")))
      throw new InvalidTargetError(
        "Token is restricted to this Relay MCP server",
      );
  };
  const getCode = async (client, code) => {
    const row = await store.get("code", hash(code));
    if (!row || row.clientId !== client.client_id)
      throw new InvalidGrantError("Invalid or expired authorization code");
    return row;
  };
  const provider = {
    clientsStore: {
      getClient: (id) => store.get("client", id),
      async registerClient(client) {
        if (client.redirect_uris.length > 10)
          throw new InvalidClientMetadataError("Too many redirect URLs");
        for (const s of client.redirect_uris) {
          const u = new URL(s);
          if (
            u.protocol !== "https:" &&
            !(
              u.protocol === "http:" &&
              ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)
            )
          )
            throw new InvalidClientMetadataError("Use HTTPS redirect URLs");
          if (u.hash || u.username || u.password)
            throw new InvalidClientMetadataError(
              "Redirect URL must not contain credentials or fragments",
            );
        }
        const c = {
          ...client,
          client_id: client.client_id || random(),
          client_id_issued_at: Math.floor(Date.now() / 1000),
        };
        await store.put("client", c.client_id, c, 365 * 86400);
        return c;
      },
    },
    async authorize(client, params, res) {
      if (!res.locals.relayAdmin) {
        res
          .status(403)
          .send("Sign in with your Relay dashboard admin account.");
        return;
      }
      checkResource(params.resource);
      const requested = params.scopes?.length ? params.scopes : scopes;
      if (requested.some((s) => !scopes.includes(s)))
        throw new InvalidScopeError("Unsupported scope");
      const id = random(),
        csrf = random();
      await store.put(
        "consent",
        hash(id),
        {
          clientId: client.client_id,
          redirectUri: params.redirectUri,
          codeChallenge: params.codeChallenge,
          state: params.state,
          scopes: requested,
          resource: params.resource?.toString().replace(/\/$/, "") || resource,
          csrf: hash(csrf),
        },
        300,
      );
      res.cookie("relay_mcp_consent", csrf, {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        path: "/authorize",
        maxAge: 300000,
      });
      const callback = new URL(params.redirectUri);
      res.set({
        "Cache-Control": "no-store",
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      });
      res
        .type("html")
        .send(
          `<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect Relay</title><style>body{font:16px system-ui;background:#f3f7f3;color:#234332;padding:6vh 20px}main{max-width:540px;margin:auto;background:white;padding:32px;border:1px solid #dae5dc;border-radius:20px}h1{letter-spacing:-1px}li{margin:12px 0}button{padding:13px 20px;border:0;border-radius:9px;background:#137b5e;color:white;font:inherit;cursor:pointer}button[value=deny]{background:#edf2ec;color:#345}code{overflow-wrap:anywhere}p{line-height:1.7;color:#60796a}</style><main><h1>Connect Relay to your AI client</h1><p>Client: <strong>${escapeHtml(client.client_name || "MCP client")}</strong><br>Callback: <code>${escapeHtml(callback.origin + callback.pathname)}</code></p><p>Only approve a connection you started. This grants access to your Telegram workspace:</p><ul>${requested.map((s) => `<li>${escapeHtml({ "relay:read": "Read contacts, campaigns, conversations, and settings", "relay:write": "Save contacts, campaign drafts, and AI settings", "relay:send": "Send campaign messages from your Telegram account", offline_access: "Stay connected using refresh tokens" }[s])}</li>`).join("")}</ul><p>Campaign sends are separate from drafting and require an exact preview. You can revoke this connection through the Relay admin API.</p><form method="post" action="/authorize/decision"><input type="hidden" name="request_id" value="${id}"><input type="hidden" name="csrf" value="${csrf}"><button name="decision" value="approve">Approve connection</button> <button name="decision" value="deny">Cancel</button></form></main></html>`,
        );
    },
    async decide(req, res) {
      if (!res.locals.relayAdmin)
        return res.status(403).send("Admin login required");
      const id = req.body?.request_id,
        csrf = req.body?.csrf;
      const cookie = (req.headers.cookie || "")
        .split(";")
        .map((v) => v.trim())
        .find((v) => v.startsWith("relay_mcp_consent="))
        ?.slice("relay_mcp_consent=".length);
      if (typeof id !== "string" || typeof csrf !== "string" || cookie !== csrf)
        return res.status(403).send("Invalid consent request");
      const pending = await store.get("consent", hash(id));
      if (!pending || pending.csrf !== hash(csrf))
        return res.status(403).send("Consent expired or invalid");
      const data = await store.take("consent", hash(id));
      if (!data) return res.status(403).send("Consent already used");
      const target = new URL(data.redirectUri);
      if (data.state) target.searchParams.set("state", data.state);
      if (req.body.decision === "approve") {
        const code = random();
        delete data.csrf;
        await store.put("code", hash(code), data, 300);
        target.searchParams.set("code", code);
      } else target.searchParams.set("error", "access_denied");
      res.clearCookie("relay_mcp_consent", {
        secure: true,
        httpOnly: true,
        sameSite: "lax",
        path: "/authorize",
      });
      res.redirect(target.toString());
    },
    async challengeForAuthorizationCode(client, code) {
      return (await getCode(client, code)).codeChallenge;
    },
    async exchangeAuthorizationCode(client, code, verifier, redirectUri, r) {
      checkResource(r);
      const row = await getCode(client, code);
      if (redirectUri !== row.redirectUri)
        throw new InvalidGrantError("Redirect URL mismatch");
      // The SDK verifies PKCE itself and then omits the verifier.
      // If a caller supplies it directly, validate it here as well.
      if (
        verifier &&
        hash(verifier) !==
          Buffer.from(row.codeChallenge, "base64url").toString("hex")
      )
        throw new InvalidGrantError("PKCE verification failed");
      const consumed = await store.take("code", hash(code));
      if (!consumed) throw new InvalidGrantError("Code already used");
      return mint({
        clientId: client.client_id,
        scopes: row.scopes,
        grantId: random(),
        resource: row.resource || resource,
      });
    },
    async exchangeRefreshToken(client, token, requested, r) {
      checkResource(r);
      const row = await store.get("refresh", hash(token));
      if (!row || row.clientId !== client.client_id)
        throw new InvalidGrantError("Invalid refresh token");
      if (requested?.some((s) => !row.scopes.includes(s)))
        throw new InvalidScopeError("Cannot expand token scopes");
      if (!(await store.take("refresh", hash(token))))
        throw new InvalidGrantError("Refresh token already used");
      return mint({ ...row, scopes: requested || row.scopes });
    },
    async verifyAccessToken(token) {
      const data = await store.get("access", hash(token));
      if (!data || !allowedResources.has(data.resource?.replace(/\/$/, "")))
        throw new InvalidTokenError("Invalid or expired access token");
      return {
        token,
        clientId: data.clientId,
        scopes: data.scopes,
        expiresAt: data.expiresAt,
        resource: new URL(data.resource),
      };
    },
    async revokeToken(client, req) {
      const key = hash(req.token);
      const row =
        (await store.get("access", key)) || (await store.get("refresh", key));
      if (row?.clientId === client.client_id)
        await store.revokeGrant(row.grantId);
    },
  };
  async function mint(data) {
    const access = random(),
      refresh = random();
    const now = Math.floor(Date.now() / 1000);
    await store.put(
      "access",
      hash(access),
      { ...data, expiresAt: now + 3600 },
      3600,
    );
    await store.put("refresh", hash(refresh), data, 30 * 86400);
    return {
      access_token: access,
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: refresh,
      scope: data.scopes.join(" "),
    };
  }
  return provider;
}
