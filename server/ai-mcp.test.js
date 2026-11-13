import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createRelayMcp } from "./mcp-tools.js";

test("MCP configures group and private scheduled checks and enforces schema/scope", async () => {
  for (const scopes of [["relay:read"], ["relay:read", "relay:write"]]) {
    const calls = [];
    const server = createRelayMcp({
      api: async (...args) => {
        calls.push(args);
        return { ok: true };
      },
      query: async () => ({ rows: [] }),
      names: {},
      auth: { clientId: "test", scopes },
      audit: async () => {},
    });
    const client = new Client({ name: "config-test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await client.connect(b);
    try {
      const tools = (await client.listTools()).tools;
      assert.equal(
        tools.find((t) => t.name === "set_group_preferences").annotations
          .destructiveHint,
        true,
      );
      const fields = {
        ai_enabled: true,
        ai_mode: "scheduled",
        ai_interval_minutes: 1,
        ai_instructions: "Only help with unanswered questions",
      };
      for (const [name, idField] of [
        ["set_group_preferences", "group_id"],
        ["set_contact_preferences", "contact_id"],
      ]) {
        const result = await client.callTool({
          name,
          arguments: { [idField]: 12, ...fields },
        });
        if (scopes.includes("relay:write")) {
          assert.equal(result.isError, undefined);
          assert.deepEqual(calls.at(-1), [
            name === "set_group_preferences" ? "/groups/12" : "/contacts/12",
            "PATCH",
            fields,
          ]);
        } else assert.equal(result.isError, true);
        const count = calls.length;
        for (const invalid of [0, 0.5, 10081]) {
          const bad = await client.callTool({
            name,
            arguments: { [idField]: 12, ai_interval_minutes: invalid },
          });
          assert.equal(bad.isError, true);
          assert.equal(calls.length, count);
        }
      }
      const result = await client.callTool({
        name: "get_group_ai_settings",
        arguments: { group_id: 12 },
      });
      assert.equal(result.isError, undefined);
      assert.deepEqual(calls.at(-1), ["/groups/12/ai"]);
    } finally {
      await client.close();
      await server.close();
    }
  }
});
