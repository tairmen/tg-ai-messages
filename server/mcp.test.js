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
    },
    set() {},
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
      headers: { cookie: "relay_mcp_consent=" + result.cookie },
    },
    res,
  );
  const code = new URL(result.redirect).searchParams.get("code");
  assert.equal(
    new URL(result.redirect).searchParams.get("state"),
    "test-state",
  );
  return { provider, store, client, verifier, code, res };
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
