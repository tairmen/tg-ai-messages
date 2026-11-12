import { test } from "node:test";
import assert from "node:assert/strict";
import { createOAuthProvider } from "./mcp-oauth.js";
import { hash, previewCampaign } from "./mcp-utils.js";
function memoryStore() {
  const rows = new Map();
  return {
    async get(k, id) {
      return rows.get(k + id);
    },
    async put(k, id, v) {
      rows.set(k + id, v);
    },
    async take(k, id) {
      const v = rows.get(k + id);
      rows.delete(k + id);
      return v;
    },
    async revokeGrant(id) {
      for (const [k, v] of rows) if (v.grantId === id) rows.delete(k);
    },
  };
}
async function grant() {
  const store = memoryStore();
  const provider = createOAuthProvider({
    store,
    origin: "https://relay.example",
  });
  const client = await provider.clientsStore.registerClient({
    client_name: "Unit test",
    redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
    token_endpoint_auth_method: "none",
  });
  const verifier = "unit-test-pkce-verifier-which-is-long-enough-for-oauth";
  const challenge = Buffer.from(hash(verifier), "hex").toString("base64url");
  const result = {};
  const res = {
    locals: { relayAdmin: true },
    cookie(n, v) {
      result.cookie = v;
      result.cookieName = n;
    },
    set(headers) {
      result.headers = headers;
    },
    type() {
      return this;
    },
    send(html) {
      result.html = html;
    },
    status(s) {
      result.status = s;
      return this;
    },
    clearCookie() {},
    redirect(url) {
      result.redirect = url;
    },
  };
  await provider.authorize(
    client,
    {
      redirectUri: client.redirect_uris[0],
      codeChallenge: challenge,
      state: "test-state",
      scopes: ["relay:read", "relay:write", "relay:send", "offline_access"],
      resource: new URL("https://relay.example/mcp"),
    },
    res,
  );
  const request_id = result.html.match(/name="request_id" value="([^"]+)"/)[1];
  const csrf = result.html.match(/name="csrf" value="([^"]+)"/)[1];
  await provider.decide(
    {
      body: { request_id, csrf, decision: "approve" },
      headers: { cookie: result.cookieName + "=" + result.cookie },
    },
    res,
  );
  const code = new URL(result.redirect).searchParams.get("code");
  assert.equal(
    new URL(result.redirect).searchParams.get("state"),
    "test-state",
  );
  return {
    provider,
    store,
    client,
    verifier,
    code,
    res,
    consent: { request_id, csrf },
    result,
  };
}
test("OAuth requires consent, validates PKCE/client/redirect/resource, and prevents code replay", async () => {
  const { provider, client, verifier, code } = await grant();
  assert.equal(
    await provider.challengeForAuthorizationCode(client, code),
    Buffer.from(hash(verifier), "hex").toString("base64url"),
  );
  await assert.rejects(
    provider.exchangeAuthorizationCode(
      client,
      code,
      "wrong",
      client.redirect_uris[0],
    ),
    /PKCE/,
  );
  await assert.rejects(
    provider.exchangeAuthorizationCode(
      client,
      code,
      verifier,
      "https://evil.example",
    ),
    /Redirect/,
  );
  await assert.rejects(
    provider.exchangeAuthorizationCode(
      client,
      code,
      verifier,
      client.redirect_uris[0],
      new URL("https://evil.example/mcp"),
    ),
    /restricted/,
  );
  const tokens = await provider.exchangeAuthorizationCode(
    client,
    code,
    verifier,
    client.redirect_uris[0],
  );
  const info = await provider.verifyAccessToken(tokens.access_token);
  assert.equal(info.resource.toString(), "https://relay.example/mcp");
  await assert.rejects(
    provider.exchangeAuthorizationCode(
      client,
      code,
      verifier,
      client.redirect_uris[0],
    ),
    /expired|used/,
  );
  await assert.rejects(
    provider.exchangeRefreshToken(
      { ...client, client_id: "wrong" },
      tokens.refresh_token,
    ),
    /Invalid/,
  );
  const next = await provider.exchangeRefreshToken(
    client,
    tokens.refresh_token,
    ["relay:read"],
  );
  await assert.rejects(
    provider.exchangeRefreshToken(client, tokens.refresh_token),
    /Invalid/,
  );
  await assert.rejects(
    provider.exchangeRefreshToken(client, next.refresh_token, ["relay:send"]),
    /expand/,
  );
  await provider.revokeToken(client, { token: next.refresh_token });
  await assert.rejects(
    provider.verifyAccessToken(next.access_token),
    /Invalid/,
  );
  await assert.rejects(
    provider.verifyAccessToken(tokens.access_token),
    /Invalid/,
  );
});
test("authorization does not grant access without an authenticated admin", async () => {
  const p = createOAuthProvider({
    store: memoryStore(),
    origin: "https://relay.example",
  });
  let code;
  await p.authorize(
    {},
    {},
    {
      locals: {},
      status(s) {
        code = s;
        return this;
      },
      send() {},
    },
  );
  assert.equal(code, 403);
});
test("campaign preview hash changes with text, recipient identity, and opt-out state", () => {
  const campaign = {
    id: 1,
    name: "Hello",
    body: "Hi {{name}}",
    status: "draft",
    recipient_ids: [1],
  };
  const c = { id: 1, name: "Alex", phone: "+380631234567", opted_out: false };
  const initial = previewCampaign(campaign, [c]);
  assert.equal(initial.recipients[0].message, "Hi Alex");
  for (const changed of [
    { ...c, name: "Dana" },
    { ...c, phone: "+380671234567" },
    { ...c, opted_out: true },
  ])
    assert.notEqual(
      previewCampaign(campaign, [changed]).preview_hash,
      initial.preview_hash,
    );
  assert.notEqual(
    previewCampaign({ ...campaign, body: "New message" }, [c]).preview_hash,
    initial.preview_hash,
  );
  assert.throws(() => previewCampaign(campaign, []), /no longer exists/);
});

// Exercise the real SDK token endpoint, not just the provider methods.
test("SDK token endpoint verifies PKCE before calling provider without a verifier", async () => {
  const { default: express } = await import("express");
  const { mcpAuthRouter } =
    await import("@modelcontextprotocol/sdk/server/auth/router.js");
  const { provider, client, verifier, code } = await grant();
  const app = express();
  app.use(
    mcpAuthRouter({ provider, issuerUrl: new URL("https://relay.example") }),
  );
  const http = await new Promise((resolve) => {
    const h = app.listen(0, "127.0.0.1", () => resolve(h));
  });
  try {
    const request = (v) =>
      fetch("http://127.0.0.1:" + http.address().port + "/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: client.client_id,
          redirect_uri: client.redirect_uris[0],
          code,
          code_verifier: v,
          resource: "https://relay.example/mcp",
        }),
      });
    assert.equal((await request("incorrect-pkce-verifier")).status, 400);
    const response = await request(verifier);
    const tokens = await response.json();
    assert.equal(response.status, 200, JSON.stringify(tokens));
    assert.ok(
      (await provider.verifyAccessToken(tokens.access_token)).scopes.includes(
        "relay:read",
      ),
    );
  } finally {
    await new Promise((resolve) => http.close(resolve));
  }
});

test("OAuth discovery works at both root and resource-specific URLs on the canonical HTTPS origin", async () => {
  const { default: express } = await import("express");
  const { installMcp } = await import("./mcp.js");
  const app = express();
  app.use(express.json());
  installMcp(app, {
    pool: { query: async () => ({ rows: [] }) },
    names: { oauth: "unused" },
    api: async () => ({}),
    origin: "https://relay.example",
    legacyOrigin: "https://relay.example:8443",
  });
  const http = await new Promise((resolve) => {
    const h = app.listen(0, "127.0.0.1", () => resolve(h));
  });
  const base = "http://127.0.0.1:" + http.address().port;
  try {
    const a = await fetch(base + "/.well-known/oauth-protected-resource");
    const b = await fetch(base + "/.well-known/oauth-protected-resource/mcp");
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    const root = await a.json();
    const specific = await b.json();
    assert.equal(root.resource, specific.resource);
    const metadata = await (
      await fetch(base + "/.well-known/oauth-authorization-server")
    ).json();
    assert.equal(root.authorization_servers[0], metadata.issuer);
    assert.equal(metadata.token_endpoint, "https://relay.example/token");
    assert.ok(metadata.code_challenge_methods_supported.includes("S256"));
    const denied = await fetch(base + "/mcp");
    assert.equal(denied.status, 401);
    assert.match(
      denied.headers.get("www-authenticate"),
      /https:\/\/relay.example\//,
    );
  } finally {
    await new Promise((resolve) => http.close(resolve));
  }
});
test("canonical and legacy MCP resource tokens remain bound to this service", async () => {
  const store = memoryStore();
  const p = createOAuthProvider({
    store,
    origin: "https://relay.example",
    legacyOrigin: "https://relay.example:8443",
  });
  for (const resource of [
    "https://relay.example/mcp",
    "https://relay.example:8443/mcp",
  ]) {
    await store.put(
      "access",
      hash(resource),
      { clientId: "test", scopes: ["relay:read"], resource },
      100,
    );
    assert.equal((await p.verifyAccessToken(resource)).resource.href, resource);
  }
  await store.put(
    "access",
    hash("foreign"),
    { clientId: "test", scopes: [], resource: "https://foreign.example/mcp" },
    100,
  );
  await assert.rejects(p.verifyAccessToken("foreign"), /Invalid/);
});

test("consent allows only the registered callback origin and safely handles a repeated submission", async () => {
  const { provider, consent, result, res, code, store } = await grant();
  assert.match(
    result.headers["Content-Security-Policy"],
    /form-action 'self' https:\/\/chatgpt.com;/,
  );
  assert.match(result.cookieName, /^relay_mcp_consent_[A-Za-z0-9_-]+$/);
  assert.doesNotMatch(
    result.headers["Content-Security-Policy"],
    /form-action[^;]*\*/,
  );
  await provider.decide(
    { body: { ...consent, decision: "approve" }, headers: {} },
    res,
  );
  assert.equal(result.status, 200);
  assert.match(result.html, /already submitted/);
  assert.equal((await store.get("code", hash(code))) !== undefined, true);
  const oldCode = new URL(result.redirect).searchParams.get("code");
  assert.equal(oldCode, code);
});
