import { test } from "node:test";
import assert from "node:assert/strict";
import { importedUser, normalizeUsername } from "./recipients.js";
test("username normalization accepts handles but rejects URLs and unrelated target syntax", () => {
  assert.equal(
    normalizeUsername("@ParalysedButterflyy"),
    "paralysedbutterflyy",
  );
  assert.throws(() => normalizeUsername("https://t.me/example"), /username/);
  assert.throws(() => normalizeUsername("@bad-name"), /username/);
});
test("phone lookup selects only the exact imported contact mapping", () => {
  const user = { id: 123 };
  const unrelated = { id: 456 };
  assert.equal(
    importedUser(
      { imported: [{ clientId: 7, userId: 123 }], users: [unrelated, user] },
      7,
    ),
    user,
  );
  assert.equal(
    importedUser({ imported: [], users: [unrelated] }, 7),
    undefined,
  );
  assert.equal(
    importedUser(
      { imported: [{ clientId: 8, userId: 456 }], users: [unrelated] },
      7,
    ),
    undefined,
  );
});
test("Telegram lookup deferrals are distinct from numbers that could not be resolved", () => {
  assert.throws(
    () => importedUser({ retryContacts: [7], imported: [], users: [] }, 7),
    /server-side limit/,
  );
});
