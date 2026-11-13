import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createRelayMcp } from "./mcp-tools.js";
test("official MCP client discovers tools; scope checks and send schema prevent unintended sends", async () => {
  let sends = 0;
  const app = express();
  app.use(express.json());
  app.post("/mcp", async (req, res) => {
    const server = createRelayMcp({
      api: async (path) => {
        if (path.includes("/send")) sends++;
        return path === "/health"
          ? {
              database: true,
              telegram: { connected: true },
              openai: true,
              token: "must-not-leak",
            }
          : { ok: true };
      },
      query: async () => ({ rows: [] }),
      names: {},
      auth: { clientId: "test", scopes: ["relay:read"] },
      audit: async () => {},
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => server.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  const http = await new Promise((resolve) => {
    const h = app.listen(0, "127.0.0.1", () => resolve(h));
  });
  const client = new Client({ name: "relay-test", version: "1.0" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL("http://127.0.0.1:" + http.address().port + "/mcp"),
      ),
    );
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 21);
    assert.equal(
      tools.tools.find((t) => t.name === "send_campaign").annotations
        .destructiveHint,
      true,
    );
    const status = await client.callTool({ name: "get_status", arguments: {} });
    assert.doesNotMatch(JSON.stringify(status), /must-not-leak/);
    const denied = await client.callTool({
      name: "send_campaign",
      arguments: {
        campaign_id: 1,
        preview_hash: "a".repeat(64),
        confirm_send: true,
      },
    });
    assert.equal(denied.isError, true);
    assert.equal(sends, 0);
    const invalid = await client.callTool({
      name: "send_campaign",
      arguments: { campaign_id: 1 },
    });
    assert.equal(invalid.isError, true);
    assert.equal(sends, 0);
  } finally {
    await client.close();
    await new Promise((resolve) => http.close(resolve));
  }
});
