import { test } from "node:test";
import assert from "node:assert/strict";
import { publicAddress, joinedGroup } from "./groups-utils.js";
import { sendOnce } from "./direct-messages.js";
import { Api } from "teleproto";
test("image sources reject private, loopback, metadata, and mapped private addresses", () => {
  for (const ip of [
    "127.0.0.1",
    "10.1.2.3",
    "192.168.1.1",
    "169.254.169.254",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
  ])
    assert.equal(publicAddress(ip), false, ip);
  assert.equal(publicAddress("8.8.8.8"), true);
});
test("only joined basic groups and supergroups qualify; personal accounts and broadcast channels do not", () => {
  assert.equal(joinedGroup({ className: "Chat" }), true);
  assert.equal(joinedGroup({ className: "Channel", megagroup: true }), true);
  for (const group of [
    { className: "User" },
    { className: "Channel", broadcast: true },
    { className: "Chat", left: true },
    { className: "Channel", megagroup: true, kicked: true },
    { className: "ChatForbidden" },
  ])
    assert.equal(joinedGroup(group), false);
});
test("group message retry IDs are bound to both group and image content", async () => {
  let row,
    sends = 0;
  const common = {
    claim: async (_, fingerprint) => {
      if (row) return row;
      row = { fingerprint, status: "sending" };
      return null;
    },
    finish: async (_, status, result) => Object.assign(row, { status, result }),
    loadContact: async () => ({ id: 4, title: "Test group" }),
    send: async () => {
      sends++;
      return { message_id: "9" };
    },
  };
  const request = {
    group_id: 4,
    request_id: "unit-group-1",
    body: "Caption",
    image_url: "https://example.com/a.jpg",
  };
  const result = await sendOnce({ ...common, request });
  assert.equal(result.group_id, 4);
  await sendOnce({ ...common, request });
  assert.equal(sends, 1);
  for (const changed of [
    { ...request, group_id: 5 },
    { ...request, image_url: "https://example.com/b.jpg" },
  ])
    await assert.rejects(
      sendOnce({ ...common, request: changed }),
      /different message/,
    );
});
test("Telegram external-photo and group peers serialize without sending", () => {
  assert.ok(
    new Api.InputMediaPhotoExternal({
      url: "https://example.com/image.jpg",
    }).getBytes().length,
  );
  assert.ok(new Api.InputPeerChat({ chatId: BigInt(1) }).getBytes().length);
  assert.ok(
    new Api.InputPeerChannel({
      channelId: BigInt(1),
      accessHash: BigInt(2),
    }).getBytes().length,
  );
});

test("initial dialog discovery omits the date filter rather than filtering everything after epoch", async () => {
  const { dialogOptions } = await import("./groups-utils.js");
  assert.deepEqual(dialogOptions({ limit: 500 }), { limit: 500 });
  assert.equal("offsetDate" in dialogOptions({ limit: 500 }), false);
  assert.deepEqual(dialogOptions({ limit: 100, offset_date: 1700000000 }), {
    limit: 100,
    offsetDate: 1700000000,
    ignorePinned: true,
  });
});
