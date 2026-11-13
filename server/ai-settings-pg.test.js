import { test } from "node:test";
import assert from "node:assert/strict";
import { aiSettingsUpdate } from "./ai-settings-sql.js";
// Opt-in PostgreSQL parsing check: EXPLAIN without ANALYZE never updates rows.
test(
  "PostgreSQL accepts actual AI preference queries for groups and contacts",
  { skip: process.env.RELAY_TEST_POSTGRES !== "true" },
  async () => {
    const { pool, names } = await import("./db.js");
    try {
      for (const kind of ["contact", "group"]) {
        for (const mode of ["immediate", "scheduled"]) {
          const query = aiSettingsUpdate(names, kind, {
            id: 1,
            ai_enabled: false,
            ai_instructions: "SQL validation only",
            ai_mode: mode,
            ai_interval_minutes: 1,
            opted_out: false,
          });
          const result = await pool.query({
            text: "EXPLAIN " + query.text,
            values: query.values,
          });
          assert.ok(result.rows.length);
        }
      }
    } finally {
      await pool.end();
    }
  },
);
