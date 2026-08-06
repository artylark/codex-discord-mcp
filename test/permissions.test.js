const test = require("node:test");
const assert = require("node:assert/strict");

const {
  channelPermissions,
  hasRequiredPermissions,
  isSupportedChannel,
  messageOutput,
  registerDiscordTools,
} = require("../lib/mcp.js");

const GUILD_ID = "100000000000000001";
const ROLE_ID = "100000000000000002";
const MEMBER_ID = "100000000000000003";
const ADMINISTRATOR = 0x8n;
const VIEW_CHANNEL = 0x400n;
const READ_MESSAGE_HISTORY = 0x10000n;
const SEND_MESSAGES = 0x800n;
const CHANNEL_ID = "100000000000000004";

function registeredTools(permissions) {
  const tools = new Map();
  const calls = [];
  const discord = {
    get: async (url, config) => {
      calls.push({ method: "get", url, config });
      if (url === `/guilds/${GUILD_ID}/channels`) {
        return { data: [{ id: CHANNEL_ID, type: 0 }] };
      }
      if (url === `/guilds/${GUILD_ID}/roles`) {
        return {
          data: [
            { id: GUILD_ID, permissions: "0" },
            { id: ROLE_ID, permissions: permissions.toString() },
          ],
        };
      }
      if (url === "/users/@me") {
        return { data: { id: MEMBER_ID } };
      }
      if (url === `/guilds/${GUILD_ID}/members/${MEMBER_ID}`) {
        return { data: { roles: [ROLE_ID], user: { id: MEMBER_ID } } };
      }
      throw new Error(`Unexpected GET ${url}`);
    },
    post: async (url, data) => {
      calls.push({ method: "post", url, data });
      throw new Error(`Unexpected POST ${url}`);
    },
  };
  const server = {
    registerTool(name, config, handler) {
      tools.set(name, { config, handler });
    },
  };

  registerDiscordTools(server, discord, GUILD_ID);
  return { calls, tools };
}

function resultJson(result) {
  return JSON.parse(result.content[0].text);
}

function assertNoMessagesRequest(calls) {
  assert.equal(calls.some(({ url }) => url === `/channels/${CHANNEL_ID}/messages`), false);
}

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

test("required permissions must all be present", () => {
  const requiredPermissions = VIEW_CHANNEL | READ_MESSAGE_HISTORY;

  assert.equal(hasRequiredPermissions(VIEW_CHANNEL, requiredPermissions), false);
  assert.equal(hasRequiredPermissions(READ_MESSAGE_HISTORY, requiredPermissions), false);
  assert.equal(hasRequiredPermissions(requiredPermissions, requiredPermissions), true);
});

test("Administrator satisfies every required permission set", () => {
  assert.equal(hasRequiredPermissions(ADMINISTRATOR, VIEW_CHANNEL | SEND_MESSAGES), true);
});

test("read handler denies a channel without READ_MESSAGE_HISTORY before requesting messages", async () => {
  const { calls, tools } = registeredTools(VIEW_CHANNEL);

  const result = await tools.get("discord_read_messages").handler({
    channel_id: CHANNEL_ID,
    limit: 20,
  });

  assert.match(resultJson(result).error, /required permissions/);
  assertNoMessagesRequest(calls);
});

test("send handler denies a channel without SEND_MESSAGES before posting a message", async () => {
  const { calls, tools } = registeredTools(VIEW_CHANNEL);

  const result = await tools.get("discord_send_message").handler({
    channel_id: CHANNEL_ID,
    message: "Hello, Discord!",
  });

  assert.match(resultJson(result).error, /required permissions/);
  assertNoMessagesRequest(calls);
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
