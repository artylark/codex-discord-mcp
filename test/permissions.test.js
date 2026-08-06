const test = require("node:test");
const assert = require("node:assert/strict");

const { channelPermissions, isSupportedChannel, messageOutput } = require("../lib/mcp.js");

const GUILD_ID = "100000000000000001";
const ROLE_ID = "100000000000000002";
const MEMBER_ID = "100000000000000003";
const VIEW_CHANNEL = 0x400n;

function permissionsFor(overwrites) {
  return channelPermissions(
    GUILD_ID,
    { id: "100000000000000004", type: 0, permission_overwrites: overwrites },
    { roles: [ROLE_ID], user: { id: MEMBER_ID } },
    new Map([
      [GUILD_ID, { id: GUILD_ID, permissions: "0" }],
      [ROLE_ID, { id: ROLE_ID, permissions: "0" }],
    ]),
  );
}

test("a member role deny overrides an @everyone allow", () => {
  const permissions = permissionsFor([
    { id: GUILD_ID, type: 0, allow: VIEW_CHANNEL.toString(), deny: "0" },
    { id: ROLE_ID, type: 0, allow: "0", deny: VIEW_CHANNEL.toString() },
  ]);

  assert.equal(permissions & VIEW_CHANNEL, 0n);
});

test("a member role allow overrides an @everyone deny", () => {
  const permissions = permissionsFor([
    { id: GUILD_ID, type: 0, allow: "0", deny: VIEW_CHANNEL.toString() },
    { id: ROLE_ID, type: 0, allow: VIEW_CHANNEL.toString(), deny: "0" },
  ]);

  assert.equal(permissions & VIEW_CHANNEL, VIEW_CHANNEL);
});

test("only Guild Text and Announcement channels are supported", () => {
  for (const type of [0, 5]) {
    assert.equal(isSupportedChannel({ type }), true);
  }

  for (const type of [10, 11, 12, 15, 16]) {
    assert.equal(isSupportedChannel({ type }), false);
  }
});

test("message output omits thread identifiers", () => {
  const output = messageOutput({
    id: "100000000000000005",
    content: "message content",
    timestamp: "2026-08-06T00:00:00.000Z",
    author: {
      id: "100000000000000006",
      username: "username",
      global_name: "Display name",
    },
    attachments: [{ id: "100000000000000007", filename: "file.txt", url: "https://cdn.discordapp.com/file.txt" }],
    thread: { id: "100000000000000008" },
  });

  assert.deepEqual(output, {
    id: "100000000000000005",
    content: "message content",
    timestamp: "2026-08-06T00:00:00.000Z",
    author: {
      id: "100000000000000006",
      name: "Display name",
      username: "username",
      bot: false,
    },
    attachments: [{ id: "100000000000000007", filename: "file.txt", url: "https://cdn.discordapp.com/file.txt" }],
  });
  assert.equal("thread_id" in output, false);
});
