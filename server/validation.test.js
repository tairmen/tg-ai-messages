import { test } from "node:test";
import assert from "node:assert/strict";
import { contactSchema, campaignSchema } from "./validation.js";
import { Api } from "teleproto";
test("normalizes international phone numbers and rejects local/invalid numbers", () => {
  assert.equal(
    contactSchema.parse({ name: " Alex ", phone: "+380 (67) 123-45-67" }).phone,
    "+380671234567",
  );
  for (const phone of ["0671234567", "+0000000000", "+380abc", ""])
    assert.equal(
      contactSchema.safeParse({ name: "Alex", phone }).success,
      false,
    );
});
test("campaigns reject empty, duplicate, and more than ten recipients", () => {
  const base = { name: "Test", body: "Hi {{name}}" };
  for (const ids of [[], [1, 1], Array.from({ length: 11 }, (_, i) => i + 1)])
    assert.equal(
      campaignSchema.safeParse({ ...base, recipient_ids: ids }).success,
      false,
    );
  assert.equal(
    campaignSchema.parse({ ...base, recipient_ids: [1, 2] }).recipient_ids
      .length,
    2,
  );
});
test("Telegram peers and imported contacts serialize 64-bit IDs", () => {
  const peer = new Api.InputPeerUser({
    userId: BigInt("1234567890123"),
    accessHash: BigInt("9876543210123"),
  });
  assert.ok(peer.getBytes().length > 0);
  const c = new Api.InputPhoneContact({
    clientId: BigInt(1),
    phone: "+380671234567",
    firstName: "Test",
    lastName: "",
  });
  assert.ok(c.getBytes().length > 0);
});
