import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePhone, loginError } from "./login-utils.js";
import { makeClient } from "./telegram.js";
test("Telegram client allows actual requests and data-center recovery", () => {
  const client = makeClient();
  assert.ok(
    client._requestRetries >= 2,
    "Zero attempts disables every Telegram API request; migration needs another attempt",
  );
  assert.equal(client.floodSleepThreshold, 0);
});
test("login accepts international format and rejects a local number before sending a code request", () => {
  assert.equal(normalizePhone("+380 (63) 281-69-08"), "+380632816908");
  assert.throws(() => normalizePhone("632816908"), /international/);
  assert.throws(() => normalizePhone("380632816908"), /international/);
});
test("login errors provide diagnostics without dumping credentials or raw error objects", () => {
  assert.match(
    loginError({ errorMessage: "API_ID_INVALID" }),
    /api_id and api_hash/,
  );
  assert.match(
    loginError({ name: "FloodWaitError", seconds: 42 }),
    /42 seconds/,
  );
  assert.doesNotMatch(
    loginError({ name: "Error", message: "secret-value" }),
    /secret-value/,
  );
});
