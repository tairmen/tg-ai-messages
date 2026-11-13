import { test } from "node:test";
import assert from "node:assert/strict";
import { telegramMessageContent } from "./message-content.js";
test("group context includes emoji/custom reaction counts and reply linkage", () => {
  const result = telegramMessageContent({
    message: "joke",
    replyTo: { replyToMsgId: 123 },
    reactions: {
      results: [
        { reaction: { emoticon: "😂" }, count: 3 },
        { reaction: { documentId: 9007199254740993n }, count: 1 },
      ],
    },
  });
  assert.equal(result.metadata.reply_to_message_id, "123");
  assert.deepEqual(result.metadata.reactions, [
    { reaction: "😂", count: 3 },
    { reaction: "custom:9007199254740993", count: 1 },
  ]);
  assert.doesNotThrow(() => JSON.stringify(result));
  assert.deepEqual(
    telegramMessageContent({ message: "no reactions" }).metadata,
    {},
  );
});
