const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");

const {
  channelPermissions,
  configuredGuildIds,
  hasRequiredPermissions,
  isSupportedChannel,
  messageOutput,
  normalizeListArguments,
  registerDiscordTools,
} = require("../lib/mcp.js");

const GUILD_ID = "100000000000000001";
const ROLE_ID = "100000000000000002";
const MEMBER_ID = "100000000000000003";
const ADMINISTRATOR = 0x8n;
const VIEW_CHANNEL = 0x400n;
const READ_MESSAGE_HISTORY = 0x10000n;
const SEND_MESSAGES = 0x800n;
const SEND_MESSAGES_IN_THREADS = 0x4000000000n;
const CHANNEL_ID = "100000000000000004";
const THREAD_ID = "100000000000000005";
const OTHER_CHANNEL_ID = "100000000000000006";
const REPLY_TO_MESSAGE_ID = "100000000000000007";

test("configured guild IDs prefer, validate, and deduplicate the plural setting", () => {
  assert.deepEqual(configuredGuildIds({ DISCORD_GUILD_ID: GUILD_ID }), [GUILD_ID]);
  assert.deepEqual(configuredGuildIds({
    DISCORD_GUILD_ID: "invalid",
    DISCORD_GUILD_IDS: ` ${GUILD_ID},200000000000000001,${GUILD_ID} `,
  }), [GUILD_ID, "200000000000000001"]);
  for (const guildIds of ["", `${GUILD_ID},`, `,${GUILD_ID}`, "invalid"]) {
    assert.throws(
      () => configuredGuildIds({ DISCORD_GUILD_ID: GUILD_ID, DISCORD_GUILD_IDS: guildIds }),
      /DISCORD_GUILD_IDS/,
    );
  }
  assert.throws(() => configuredGuildIds({}), /DISCORD_GUILD_ID is required/);
  assert.throws(() => configuredGuildIds({ DISCORD_GUILD_ID: "invalid" }), /DISCORD_GUILD_ID/);
});

function registeredTools(permissions, {
  failChannelListing = false,
  channels = [{ id: CHANNEL_ID, type: 0 }],
  getHandler,
  postHandler,
  delay,
} = {}) {
  const tools = new Map();
  const calls = [];
  const discord = {
    get: async (url, config) => {
      calls.push({ method: "get", url, config });
      if (getHandler) {
        const result = await getHandler(url, config, calls);
        if (result !== undefined) return result;
      }
      if (url === `/guilds/${GUILD_ID}/channels`) {
        if (failChannelListing) {
          throw new Error("Unable to list channels");
        }
        return { data: channels };
      }
      if (url === `/guilds/${GUILD_ID}/roles`) {
        return {
          data: [
            { id: GUILD_ID, permissions: "0" },
            {
              id: ROLE_ID,
              permissions: (typeof permissions === "function" ? permissions() : permissions).toString(),
            },
          ],
        };
      }
      if (url === "/users/@me") {
        return { data: { id: MEMBER_ID } };
      }
      if (url === `/guilds/${GUILD_ID}/members/${MEMBER_ID}`) {
        return { data: { roles: [ROLE_ID], user: { id: MEMBER_ID } } };
      }
      if (url === `/channels/${CHANNEL_ID}`) {
        return { data: { ...(channels.find((channel) => channel.id === CHANNEL_ID) ?? {
          id: CHANNEL_ID,
          type: 0,
        }), guild_id: GUILD_ID } };
      }
      if (url === `/channels/${CHANNEL_ID}/messages`) {
        return { data: [] };
      }
      throw new Error(`Unexpected GET ${url}`);
    },
    post: async (url, data) => {
      calls.push({ method: "post", url, data });
      if (postHandler) return postHandler(url, data, calls);
      throw new Error(`Unexpected POST ${url}`);
    },
  };
  const server = {
    registerTool(name, config, handler) {
      tools.set(name, { config, handler });
    },
  };

  registerDiscordTools(server, discord, [GUILD_ID], { delay });
  return { calls, tools };
}

function resultJson(result) {
  return JSON.parse(result.content[0].text);
}

const GUILD_B_ID = "200000000000000001";
const GUILD_C_ID = "300000000000000001";
const CHANNEL_B_ID = "200000000000000004";
const THREAD_B_ID = "200000000000000005";
const ROLE_B_ID = "200000000000000002";

function multiGuildTools({ failGuildB = false, denyGuildB = false } = {}) {
  const tools = new Map();
  const calls = [];
  const guilds = new Map([
    [GUILD_ID, {
      roleId: ROLE_ID,
      channels: [{ id: CHANNEL_ID, type: 0, name: "a" }],
    }],
    [GUILD_B_ID, {
      roleId: ROLE_B_ID,
      channels: [{ id: CHANNEL_B_ID, type: 0, name: "b" }],
    }],
  ]);
  const direct = new Map([
    [CHANNEL_ID, { id: CHANNEL_ID, guild_id: GUILD_ID, type: 0 }],
    [CHANNEL_B_ID, { id: CHANNEL_B_ID, guild_id: GUILD_B_ID, type: 0 }],
    [THREAD_B_ID, { id: THREAD_B_ID, guild_id: GUILD_B_ID, parent_id: CHANNEL_B_ID, type: 11 }],
    [OTHER_CHANNEL_ID, { id: OTHER_CHANNEL_ID, guild_id: GUILD_C_ID, type: 0 }],
    ["300000000000000005", { id: "300000000000000005", guild_id: GUILD_C_ID, parent_id: OTHER_CHANNEL_ID, type: 11 }],
  ]);
  const discord = {
    get: async (url, config) => {
      calls.push({ method: "get", url, config });
      if (url === "/users/@me") return { data: { id: MEMBER_ID } };
      const match = url.match(/^\/guilds\/(\d+)\/(channels|roles)$/);
      if (match) {
        const guild = guilds.get(match[1]);
        if (!guild) throw new Error(`Unexpected GET ${url}`);
        if (match[1] === GUILD_B_ID && failGuildB && match[2] === "channels") throw new Error("Guild B unavailable");
        return { data: match[2] === "channels" ? guild.channels : [
          { id: match[1], permissions: "0" },
          {
            id: guild.roleId,
            permissions: (
              match[1] === GUILD_B_ID && denyGuildB
                ? VIEW_CHANNEL | READ_MESSAGE_HISTORY
                : VIEW_CHANNEL | READ_MESSAGE_HISTORY | SEND_MESSAGES | SEND_MESSAGES_IN_THREADS
            ).toString(),
          },
        ] };
      }
      const memberMatch = url.match(/^\/guilds\/(\d+)\/members\/(\d+)$/);
      if (memberMatch) {
        const guild = guilds.get(memberMatch[1]);
        if (!guild) throw new Error(`Unexpected GET ${url}`);
        return { data: { roles: [guild.roleId], user: { id: MEMBER_ID } } };
      }
      const channelMatch = url.match(/^\/channels\/(\d+)$/);
      if (channelMatch) return { data: direct.get(channelMatch[1]) };
      if ([CHANNEL_ID, CHANNEL_B_ID, THREAD_B_ID].some((channelId) => url === `/channels/${channelId}/messages`)) return { data: [] };
      throw new Error(`Unexpected GET ${url}`);
    },
    post: async (url, data) => {
      calls.push({ method: "post", url, data });
      return { data: message() };
    },
  };
  const server = { registerTool(name, config, handler) { tools.set(name, { config, handler }); } };
  registerDiscordTools(server, discord, [GUILD_ID, GUILD_B_ID]);
  return { calls, tools };
}

async function sdkListClient() {
  const calls = [];
  const discord = {
    get: async (url) => {
      calls.push(url);
      if (url === "/users/@me") return { data: { id: MEMBER_ID } };
      if (url === `/guilds/${GUILD_ID}/channels`) return { data: [{ id: CHANNEL_ID, type: 0 }] };
      if (url === `/guilds/${GUILD_ID}/roles`) return { data: [
        { id: GUILD_ID, permissions: "0" },
        { id: ROLE_ID, permissions: VIEW_CHANNEL.toString() },
      ] };
      if (url === `/guilds/${GUILD_ID}/members/${MEMBER_ID}`) {
        return { data: { roles: [ROLE_ID], user: { id: MEMBER_ID } } };
      }
      throw new Error(`Unexpected GET ${url}`);
    },
    post: async () => { throw new Error("Unexpected POST"); },
  };
  const server = new McpServer({ name: "test", version: "1.0.0" });
  registerDiscordTools(server, discord, [GUILD_ID]);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await server.connect(normalizeListArguments(serverTransport));
  await client.connect(clientTransport);
  return { calls, client, server };
}

function assertNoMessagesRequest(calls) {
  assert.equal(calls.some(({ url }) => /\/channels\/\d+\/messages$/.test(url)), false);
}

function rateLimitError({ retryAfter, headers } = {}) {
  const error = new Error("You are being rate limited.");
  error.isAxiosError = true;
  error.response = {
    status: 429,
    data: retryAfter === undefined ? {} : { retry_after: retryAfter },
    headers,
  };
  return error;
}

function discordApiError(status, message) {
  const error = new Error(message);
  error.isAxiosError = true;
  error.response = { status, data: { message } };
  return error;
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

function thread(type, overrides = {}) {
  return {
    id: THREAD_ID,
    guild_id: GUILD_ID,
    parent_id: CHANNEL_ID,
    type,
    ...overrides,
  };
}

function message(id = "100000000000000007", overrides = {}) {
  return {
    id,
    content: "message content",
    timestamp: "2026-08-06T00:00:00.000Z",
    author: { id: "100000000000000008", username: "username" },
    attachments: [],
    ...overrides,
  };
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
  assert.equal(hasRequiredPermissions(ADMINISTRATOR, VIEW_CHANNEL | SEND_MESSAGES_IN_THREADS), true);
});

test("read handler denies a channel without READ_MESSAGE_HISTORY before requesting messages", async () => {
  const { calls, tools } = registeredTools(VIEW_CHANNEL, {
    getHandler: async (url) => url === `/channels/${CHANNEL_ID}`
      ? { data: { id: CHANNEL_ID, guild_id: GUILD_ID, type: 0 } }
      : undefined,
  });

  const result = await tools.get("discord_read_messages").handler({
    channel_id: CHANNEL_ID,
    limit: 20,
  });

  assert.match(resultJson(result).error, /required permissions/);
  assert.equal(result.isError, true);
  assertNoMessagesRequest(calls);
});

test("send handler denies a channel without SEND_MESSAGES before posting a message", async () => {
  for (const permissions of [VIEW_CHANNEL, SEND_MESSAGES, VIEW_CHANNEL | SEND_MESSAGES_IN_THREADS]) {
    for (const replyToMessageId of [undefined, REPLY_TO_MESSAGE_ID]) {
      const { calls, tools } = registeredTools(permissions | (replyToMessageId ? READ_MESSAGE_HISTORY : 0n));

      const result = await tools.get("discord_send_message").handler({
        channel_id: CHANNEL_ID,
        message: "Hello, Discord!",
        ...(replyToMessageId ? { reply_to_message_id: replyToMessageId } : {}),
      });

      assert.match(resultJson(result).error, /required permissions/);
      assert.equal(result.isError, true);
      assertNoMessagesRequest(calls);
    }
  }
});

test("list handler marks Discord failures as errors", async () => {
  const { tools } = registeredTools(VIEW_CHANNEL, { failChannelListing: true });

  const result = await tools.get("discord_list_channels").handler({});

  assert.match(resultJson(result).error, /Unable to list channels/);
  assert.equal(result.isError, true);
});

test("list aggregates configured guilds, filters one guild, and rejects an unconfigured guild", async () => {
  const { calls, tools } = multiGuildTools();

  assert.equal(tools.get("discord_list_channels").config.inputSchema.guild_id.safeParse("invalid").success, false);
  assert.equal(tools.get("discord_list_channels").config.inputSchema.guild_id.safeParse(GUILD_ID).success, true);

  const all = await tools.get("discord_list_channels").handler({});
  assert.deepEqual(resultJson(all).channels.map(({ id, guild_id }) => ({ id, guild_id })), [
    { id: CHANNEL_ID, guild_id: GUILD_ID },
    { id: CHANNEL_B_ID, guild_id: GUILD_B_ID },
  ]);
  calls.length = 0;
  const filtered = await tools.get("discord_list_channels").handler({ guild_id: GUILD_ID });
  assert.deepEqual(resultJson(filtered).channels.map(({ id }) => id), [CHANNEL_ID]);
  assert.equal(calls.some(({ url }) => url.includes(GUILD_B_ID)), false);
  calls.length = 0;
  const denied = await tools.get("discord_list_channels").handler({ guild_id: GUILD_C_ID });
  assert.equal(denied.isError, true);
  assert.match(resultJson(denied).error, /required permissions/);
  assert.equal(calls.length, 0);
});

test("SDK accepts omitted list arguments and exposes the optional guild filter", async () => {
  const { calls, client, server } = await sdkListClient();
  try {
    const listed = await client.listTools();
    const listTool = listed.tools.find(({ name }) => name === "discord_list_channels");
    const readTool = listed.tools.find(({ name }) => name === "discord_read_messages");
    const sendTool = listed.tools.find(({ name }) => name === "discord_send_message");
    assert.equal(listTool.inputSchema.properties.guild_id.type, "string");
    assert.equal(readTool.inputSchema.properties.guild_id, undefined);
    assert.equal(sendTool.inputSchema.properties.guild_id, undefined);

    const omitted = await client.callTool({ name: "discord_list_channels" });
    assert.equal(omitted.isError, undefined);
    assert.deepEqual(JSON.parse(omitted.content[0].text).channels.map(({ id }) => id), [CHANNEL_ID]);
    const empty = await client.callTool({ name: "discord_list_channels", arguments: {} });
    assert.deepEqual(JSON.parse(empty.content[0].text).channels.map(({ id }) => id), [CHANNEL_ID]);
    const filtered = await client.callTool({ name: "discord_list_channels", arguments: { guild_id: GUILD_ID } });
    assert.deepEqual(JSON.parse(filtered.content[0].text).channels.map(({ id }) => id), [CHANNEL_ID]);
    calls.length = 0;
    const invalidFilter = await client.callTool({ name: "discord_list_channels", arguments: { guild_id: null } });
    assert.equal(invalidFilter.isError, true);
    assert.match(invalidFilter.content[0].text, /Input validation error/);
    assert.deepEqual(calls, []);
    for (const argumentsValue of [null, [], "invalid"]) {
      calls.length = 0;
      await assert.rejects(
        () => client.callTool({ name: "discord_list_channels", arguments: argumentsValue }),
        /expected record/,
      );
      assert.deepEqual(calls, []);
    }
  } finally {
    await client.close();
    await server.close();
  }
});

test("read and send reject malformed target metadata before requesting messages or posting", async () => {
  for (const channel of [
    { id: "100000000000000099", guild_id: GUILD_ID, type: 0 },
    { id: CHANNEL_ID, type: 0 },
  ]) {
    const { calls, tools } = registeredTools(VIEW_CHANNEL | READ_MESSAGE_HISTORY | SEND_MESSAGES, {
      getHandler: async (url) => url === `/channels/${CHANNEL_ID}` ? { data: channel } : undefined,
    });
    const read = await tools.get("discord_read_messages").handler({ channel_id: CHANNEL_ID, limit: 20 });
    assert.equal(read.isError, true);
    assert.match(resultJson(read).error, /required permissions/);
    assertNoMessagesRequest(calls);
    const send = await tools.get("discord_send_message").handler({ channel_id: CHANNEL_ID, message: "Hello" });
    assert.equal(send.isError, true);
    assert.match(resultJson(send).error, /required permissions/);
    assert.equal(calls.some(({ method }) => method === "post"), false);
  }
});

test("read and send deny a supported direct target absent from its guild inventory", async () => {
  const { calls, tools } = registeredTools(VIEW_CHANNEL | READ_MESSAGE_HISTORY | SEND_MESSAGES, {
    channels: [],
  });
  const read = await tools.get("discord_read_messages").handler({ channel_id: CHANNEL_ID, limit: 20 });
  const send = await tools.get("discord_send_message").handler({ channel_id: CHANNEL_ID, message: "Hello" });
  assert.equal(read.isError, true);
  assert.equal(send.isError, true);
  assertNoMessagesRequest(calls);
  assert.equal(calls.some(({ method }) => method === "post"), false);
});

test("a configured guild failure makes an aggregate list fail without a partial result", async () => {
  const { tools } = multiGuildTools({ failGuildB: true });
  const result = await tools.get("discord_list_channels").handler({});

  assert.equal(result.isError, true);
  assert.match(resultJson(result).error, /Guild B unavailable/);
});

test("Guild B direct and thread reads and sends use only Guild B permissions", async () => {
  const { calls, tools } = multiGuildTools();
  for (const channelId of [CHANNEL_B_ID, THREAD_B_ID]) {
    calls.length = 0;
    const read = await tools.get("discord_read_messages").handler({ channel_id: channelId, limit: 20 });
    assert.deepEqual(resultJson(read), { channel_id: channelId, guild_id: GUILD_B_ID, messages: [] });
    assert.equal(calls.some(({ url }) => url.includes(`/guilds/${GUILD_ID}/`)), false);
    calls.length = 0;
    const sent = await tools.get("discord_send_message").handler({
      channel_id: channelId,
      message: "Hello",
      reply_to_message_id: REPLY_TO_MESSAGE_ID,
    });
    assert.equal(resultJson(sent).guild_id, GUILD_B_ID);
    assert.equal(calls.some(({ url }) => url.includes(`/guilds/${GUILD_ID}/`)), false);
    const post = calls.find(({ method }) => method === "post");
    assert.equal(post.url, `/channels/${channelId}/messages`);
    assert.deepEqual(post.data, {
      content: "Hello",
      allowed_mentions: { parse: [], replied_user: false },
      message_reference: {
        message_id: REPLY_TO_MESSAGE_ID,
        channel_id: channelId,
        fail_if_not_exists: true,
      },
    });
  }
});

test("unconfigured guild targets are rejected before a snapshot, message read, or post", async () => {
  const { calls, tools } = multiGuildTools();
  for (const channelId of [OTHER_CHANNEL_ID, "300000000000000005"]) {
    for (const tool of ["discord_read_messages", "discord_send_message"]) {
      calls.length = 0;
      const result = tool === "discord_read_messages"
        ? await tools.get(tool).handler({ channel_id: channelId, limit: 20 })
        : await tools.get(tool).handler({ channel_id: channelId, message: "Hello" });
      assert.equal(result.isError, true);
      assert.equal(
        resultJson(result).error,
        "This bot does not have the required permissions for this supported channel or thread.",
      );
      assert.equal(calls.some(({ url }) => url.startsWith("/guilds/")), false);
      assertNoMessagesRequest(calls);
      assert.equal(calls.some(({ method }) => method === "post"), false);
    }
  }
});

test("Guild A operations do not depend on an unavailable configured Guild B", async () => {
  const { calls, tools } = multiGuildTools({ failGuildB: true });
  const list = await tools.get("discord_list_channels").handler({ guild_id: GUILD_ID });
  assert.deepEqual(resultJson(list).channels.map(({ id }) => id), [CHANNEL_ID]);
  const read = await tools.get("discord_read_messages").handler({ channel_id: CHANNEL_ID, limit: 20 });
  assert.equal(read.isError, undefined);
  const sent = await tools.get("discord_send_message").handler({ channel_id: CHANNEL_ID, message: "Hello" });
  assert.equal(sent.isError, undefined);
  assert.equal(calls.some(({ url }) => url.includes(`/guilds/${GUILD_B_ID}/`)), false);
});

test("guild-specific permission snapshots do not use another guild's role permissions", async () => {
  const { calls, tools } = multiGuildTools({ denyGuildB: true });
  const denied = await tools.get("discord_send_message").handler({ channel_id: CHANNEL_B_ID, message: "Hello" });
  assert.equal(denied.isError, true);
  assert.match(resultJson(denied).error, /required permissions/);
  const allowed = await tools.get("discord_send_message").handler({ channel_id: CHANNEL_ID, message: "Hello" });
  assert.equal(allowed.isError, undefined);
  assert.equal(calls.some(({ url }) => url === `/guilds/${GUILD_B_ID}/roles`), true);
  assert.equal(calls.some(({ url }) => url === `/guilds/${GUILD_ID}/roles`), true);
});

test("preflight GET requests retry once after Discord's retry_after delay", async () => {
  const attempts = new Set();
  const delays = [];
  const preflightUrls = new Set([
    `/guilds/${GUILD_ID}/channels`,
    `/guilds/${GUILD_ID}/roles`,
    "/users/@me",
    `/guilds/${GUILD_ID}/members/${MEMBER_ID}`,
  ]);
  const { calls, tools } = registeredTools(VIEW_CHANNEL, {
    getHandler: async (url) => {
      if (preflightUrls.has(url) && !attempts.has(url)) {
        attempts.add(url);
        throw rateLimitError({ retryAfter: 0.25 });
      }
    },
    delay: async (milliseconds) => { delays.push(milliseconds); },
  });

  const result = await tools.get("discord_list_channels").handler({});

  assert.deepEqual(resultJson(result).channels.map(({ id }) => id), [CHANNEL_ID]);
  assert.deepEqual(delays, [250, 250, 250, 250]);
  for (const url of preflightUrls) {
    assert.equal(calls.filter((call) => call.url === url).length, 2);
  }
});

test("rate-limit retry uses Retry-After when the body is malformed and preserves an unparseable 429", async () => {
  let channelRequests = 0;
  const delays = [];
  const { calls, tools } = registeredTools(VIEW_CHANNEL, {
    getHandler: async (url) => {
      if (url !== `/guilds/${GUILD_ID}/channels`) return undefined;
      channelRequests += 1;
      if (channelRequests === 1) {
        throw rateLimitError({ retryAfter: "invalid", headers: { "retry-after": "0.5" } });
      }
      if (channelRequests === 2) return undefined;
      throw rateLimitError({ retryAfter: " ", headers: { "retry-after": "invalid" } });
    },
    delay: async (milliseconds) => { delays.push(milliseconds); },
  });

  const first = await tools.get("discord_list_channels").handler({});
  const second = await tools.get("discord_list_channels").handler({});

  assert.deepEqual(resultJson(first).channels.map(({ id }) => id), [CHANNEL_ID]);
  assert.equal(second.isError, true);
  assert.deepEqual(delays, [500]);
  assert.equal(calls.filter((call) => call.url === `/guilds/${GUILD_ID}/channels`).length, 3);
});

test("rate-limit retry preserves a 429 whose delay exceeds Node's timer range", async () => {
  const delays = [];
  const { calls, tools } = registeredTools(VIEW_CHANNEL, {
    getHandler: async (url) => {
      if (url === `/guilds/${GUILD_ID}/channels`) {
        throw rateLimitError({ retryAfter: 2_147_483.648 });
      }
    },
    delay: async (milliseconds) => { delays.push(milliseconds); },
  });

  const result = await tools.get("discord_list_channels").handler({});

  assert.equal(result.isError, true);
  assert.deepEqual(delays, []);
  assert.equal(calls.filter((call) => call.url === `/guilds/${GUILD_ID}/channels`).length, 1);
});

test("message GET retries once and returns an error after a second 429", async () => {
  let attempts = 0;
  const delays = [];
  const { calls, tools } = registeredTools(VIEW_CHANNEL | READ_MESSAGE_HISTORY, {
    getHandler: async (url) => {
      if (url !== `/channels/${CHANNEL_ID}/messages`) return undefined;
      attempts += 1;
      if (attempts === 1 || attempts >= 3) throw rateLimitError({ retryAfter: 0 });
      return undefined;
    },
    delay: async (milliseconds) => { delays.push(milliseconds); },
  });

  const first = await tools.get("discord_read_messages").handler({ channel_id: CHANNEL_ID, limit: 20 });
  const second = await tools.get("discord_read_messages").handler({ channel_id: CHANNEL_ID, limit: 20 });

  assert.deepEqual(resultJson(first).messages, []);
  assert.equal(second.isError, true);
  assert.equal(calls.filter((call) => call.url === `/channels/${CHANNEL_ID}/messages`).length, 4);
  assert.equal(calls.filter((call) => call.url === `/channels/${CHANNEL_ID}`).length, 2);
  assert.deepEqual(delays, [0, 0]);
});

test("concurrent calls authorize against separate preflight snapshots", async () => {
  let releaseChannels;
  const channelsStarted = new Promise((resolve) => { releaseChannels = resolve; });
  const { calls, tools } = registeredTools(VIEW_CHANNEL, {
    getHandler: async (url) => {
      if (url === `/guilds/${GUILD_ID}/channels`) await channelsStarted;
    },
  });

  const list = tools.get("discord_list_channels").handler({});
  const send = tools.get("discord_send_message").handler({ channel_id: CHANNEL_ID, message: "Hello" });
  releaseChannels();
  const [listResult, sendResult] = await Promise.all([list, send]);

  assert.deepEqual(resultJson(listResult).channels.map(({ id }) => id), [CHANNEL_ID]);
  assert.equal(sendResult.isError, true);
  assert.equal(calls.filter((call) => call.method === "get").length, 9);
  assert.equal(calls.filter((call) => call.method === "post").length, 0);
});

test("a settled preflight snapshot is not cached across calls", async () => {
  let currentPermissions = VIEW_CHANNEL;
  const { calls, tools } = registeredTools(() => currentPermissions);

  const first = await tools.get("discord_list_channels").handler({});
  currentPermissions = 0n;
  const second = await tools.get("discord_list_channels").handler({});

  assert.deepEqual(resultJson(first).channels.map(({ id }) => id), [CHANNEL_ID]);
  assert.deepEqual(resultJson(second).channels, []);
  assert.equal(calls.filter((call) => call.method === "get").length, 8);
});

test("send does not retry a rate-limited POST", async () => {
  const delays = [];
  const { calls, tools } = registeredTools(VIEW_CHANNEL | SEND_MESSAGES, {
    postHandler: async () => { throw rateLimitError({ retryAfter: 0 }); },
    delay: async (milliseconds) => { delays.push(milliseconds); },
  });

  const result = await tools.get("discord_send_message").handler({
    channel_id: CHANNEL_ID,
    message: "Hello, Discord!",
  });

  assert.equal(result.isError, true);
  assert.equal(calls.filter((call) => call.method === "post").length, 1);
  assert.deepEqual(delays, []);
});

test("send handler sends to Guild Text and Announcement channels with SEND_MESSAGES", async () => {
  for (const type of [0, 5]) {
    const { calls, tools } = registeredTools(VIEW_CHANNEL | SEND_MESSAGES, {
      channels: [{ id: CHANNEL_ID, type }],
      postHandler: async () => ({ data: message() }),
    });

    const result = await tools.get("discord_send_message").handler({
      channel_id: CHANNEL_ID,
      message: "Hello, Discord!",
    });

    assert.deepEqual(resultJson(result), {
      channel_id: CHANNEL_ID,
      guild_id: GUILD_ID,
      message_id: "100000000000000007",
      timestamp: "2026-08-06T00:00:00.000Z",
      author: "username",
    });
    assert.deepEqual(calls.find(({ method }) => method === "post").data, {
      content: "Hello, Discord!",
      allowed_mentions: { parse: [], replied_user: false },
    });
    assert.equal(calls.find(({ method }) => method === "post").url, `/channels/${CHANNEL_ID}/messages`);
  }
});

test("send handler sends to every thread type with SEND_MESSAGES_IN_THREADS", async () => {
  for (const type of [10, 11, 12]) {
    const { calls, tools } = registeredTools(VIEW_CHANNEL | SEND_MESSAGES_IN_THREADS, {
      channels: [{ id: CHANNEL_ID, type: type === 10 ? 5 : 0 }],
      getHandler: async (url) => url === `/channels/${THREAD_ID}` ? {
        data: thread(type, { thread_metadata: { archived: true, locked: false } }),
      } : undefined,
      postHandler: async () => ({ data: message() }),
    });

    const result = await tools.get("discord_send_message").handler({
      channel_id: THREAD_ID,
      message: "Hello, thread!",
    });

    assert.deepEqual(resultJson(result), {
      channel_id: THREAD_ID,
      guild_id: GUILD_ID,
      message_id: "100000000000000007",
      timestamp: "2026-08-06T00:00:00.000Z",
      author: "username",
    });
    const posts = calls.filter(({ method }) => method === "post");
    assert.equal(posts.length, 1);
    assert.equal(posts[0].url, `/channels/${THREAD_ID}/messages`);
    assert.deepEqual(posts[0].data, {
      content: "Hello, thread!",
      allowed_mentions: { parse: [], replied_user: false },
    });
    assert.equal(calls.some(({ url }) => url === `/channels/${THREAD_ID}`), true);
  }
});

test("send handler replies in Guild Text, Announcement, and thread channels without notifying the author", async () => {
  for (const [channelId, type, channels, permissions, getHandler] of [
    [CHANNEL_ID, 0, [{ id: CHANNEL_ID, type: 0 }], VIEW_CHANNEL | SEND_MESSAGES | READ_MESSAGE_HISTORY, undefined],
    [CHANNEL_ID, 5, [{ id: CHANNEL_ID, type: 5 }], VIEW_CHANNEL | SEND_MESSAGES | READ_MESSAGE_HISTORY, undefined],
    [THREAD_ID, 10, [{ id: CHANNEL_ID, type: 5 }], VIEW_CHANNEL | SEND_MESSAGES_IN_THREADS | READ_MESSAGE_HISTORY,
      async (url) => url === `/channels/${THREAD_ID}` ? { data: thread(10) } : undefined],
    [THREAD_ID, 11, [{ id: CHANNEL_ID, type: 0 }], VIEW_CHANNEL | SEND_MESSAGES_IN_THREADS | READ_MESSAGE_HISTORY,
      async (url) => url === `/channels/${THREAD_ID}` ? { data: thread(11) } : undefined],
    [THREAD_ID, 12, [{ id: CHANNEL_ID, type: 0 }], VIEW_CHANNEL | SEND_MESSAGES_IN_THREADS | READ_MESSAGE_HISTORY,
      async (url) => url === `/channels/${THREAD_ID}` ? { data: thread(12) } : undefined],
  ]) {
    const { calls, tools } = registeredTools(permissions, {
      channels,
      getHandler,
      postHandler: async () => ({ data: message() }),
    });

    const result = await tools.get("discord_send_message").handler({
      channel_id: channelId,
      message: `Reply in type ${type}`,
      reply_to_message_id: REPLY_TO_MESSAGE_ID,
    });

    assert.equal(result.isError, undefined);
    const post = calls.find(({ method }) => method === "post");
    assert.equal(post.url, `/channels/${channelId}/messages`);
    assert.deepEqual(post.data, {
      content: `Reply in type ${type}`,
      allowed_mentions: { parse: [], replied_user: false },
      message_reference: {
        message_id: REPLY_TO_MESSAGE_ID,
        channel_id: channelId,
        fail_if_not_exists: true,
      },
    });
  }
});

test("reply sends require READ_MESSAGE_HISTORY while ordinary sends do not", async () => {
  for (const [channelId, permissions, getHandler] of [
    [CHANNEL_ID, VIEW_CHANNEL | SEND_MESSAGES, undefined],
    [THREAD_ID, VIEW_CHANNEL | SEND_MESSAGES_IN_THREADS,
      async (url) => url === `/channels/${THREAD_ID}` ? { data: thread(11) } : undefined],
  ]) {
    const { calls, tools } = registeredTools(permissions, {
      getHandler,
      postHandler: async () => ({ data: message() }),
    });

    const ordinary = await tools.get("discord_send_message").handler({ channel_id: channelId, message: "Ordinary" });
    const reply = await tools.get("discord_send_message").handler({
      channel_id: channelId,
      message: "Reply",
      reply_to_message_id: REPLY_TO_MESSAGE_ID,
    });

    assert.equal(ordinary.isError, undefined);
    assert.equal(reply.isError, true);
    assert.match(resultJson(reply).error, /required permissions/);
    assert.equal(calls.filter(({ method }) => method === "post").length, 1);
  }
});

test("reply sends honor READ_MESSAGE_HISTORY direct and parent overwrites and Administrator", async () => {
  const cases = [
    [
      CHANNEL_ID,
      VIEW_CHANNEL | SEND_MESSAGES | READ_MESSAGE_HISTORY,
      [{ id: ROLE_ID, type: 0, allow: "0", deny: READ_MESSAGE_HISTORY.toString() }],
      true,
    ],
    [
      CHANNEL_ID,
      VIEW_CHANNEL | SEND_MESSAGES,
      [{ id: ROLE_ID, type: 0, allow: READ_MESSAGE_HISTORY.toString(), deny: "0" }],
      false,
    ],
    [
      CHANNEL_ID,
      ADMINISTRATOR,
      [{ id: ROLE_ID, type: 0, allow: "0", deny: READ_MESSAGE_HISTORY.toString() }],
      false,
    ],
    [
      THREAD_ID,
      VIEW_CHANNEL | SEND_MESSAGES_IN_THREADS | READ_MESSAGE_HISTORY,
      [{ id: ROLE_ID, type: 0, allow: "0", deny: READ_MESSAGE_HISTORY.toString() }],
      true,
    ],
    [
      THREAD_ID,
      VIEW_CHANNEL | SEND_MESSAGES_IN_THREADS,
      [{ id: ROLE_ID, type: 0, allow: READ_MESSAGE_HISTORY.toString(), deny: "0" }],
      false,
    ],
    [
      THREAD_ID,
      ADMINISTRATOR,
      [{ id: ROLE_ID, type: 0, allow: "0", deny: READ_MESSAGE_HISTORY.toString() }],
      false,
    ],
  ];
  for (const [channelId, permissions, permission_overwrites, denied] of cases) {
    const { calls, tools } = registeredTools(permissions, {
      channels: [{ id: CHANNEL_ID, type: 0, permission_overwrites }],
      getHandler: async (url) => channelId === THREAD_ID && url === `/channels/${THREAD_ID}`
        ? { data: thread(11) }
        : undefined,
      postHandler: async () => ({ data: message() }),
    });

    const result = await tools.get("discord_send_message").handler({
      channel_id: channelId,
      message: "Reply",
      reply_to_message_id: REPLY_TO_MESSAGE_ID,
    });

    assert.equal(result.isError === true, denied);
    assert.equal(calls.filter(({ method }) => method === "post").length, denied ? 0 : 1);
  }
});

test("reply validation accepts a message snowflake and rejects invalid values", () => {
  const { tools } = registeredTools(VIEW_CHANNEL | SEND_MESSAGES);
  const replyId = tools.get("discord_send_message").config.inputSchema.reply_to_message_id;

  assert.equal(replyId.safeParse(REPLY_TO_MESSAGE_ID).success, true);
  for (const value of ["", "not-a-snowflake", "1000000000000000", 1, null]) {
    assert.equal(replyId.safeParse(value).success, false);
  }
  assert.equal(replyId.safeParse(undefined).success, true);
});

test("thread sends require VIEW_CHANNEL and SEND_MESSAGES_IN_THREADS, not SEND_MESSAGES", async () => {
  for (const permissions of [
    SEND_MESSAGES_IN_THREADS,
    VIEW_CHANNEL,
    VIEW_CHANNEL | SEND_MESSAGES,
  ]) {
    for (const replyToMessageId of [undefined, REPLY_TO_MESSAGE_ID]) {
      const { calls, tools } = registeredTools(permissions | (replyToMessageId ? READ_MESSAGE_HISTORY : 0n), {
        getHandler: async (url) => url === `/channels/${THREAD_ID}` ? { data: thread(11) } : undefined,
      });

      const result = await tools.get("discord_send_message").handler({
        channel_id: THREAD_ID,
        message: "Hello, thread!",
        ...(replyToMessageId ? { reply_to_message_id: replyToMessageId } : {}),
      });

      assert.equal(result.isError, true);
      assert.match(resultJson(result).error, /required permissions/);
      assertNoMessagesRequest(calls);
    }
  }
});

test("thread sends honor parent overwrites and Administrator", async () => {
  const cases = [
    [
      "deny",
      VIEW_CHANNEL | SEND_MESSAGES_IN_THREADS,
      [{ id: ROLE_ID, type: 0, allow: "0", deny: SEND_MESSAGES_IN_THREADS.toString() }],
      true,
    ],
    ["Administrator", ADMINISTRATOR, [{ id: ROLE_ID, type: 0, allow: "0", deny: VIEW_CHANNEL.toString() }], false],
  ];
  for (const [, permissions, permission_overwrites, denied] of cases) {
    const { calls, tools } = registeredTools(permissions, {
      channels: [{ id: CHANNEL_ID, type: 0, permission_overwrites }],
      getHandler: async (url) => url === `/channels/${THREAD_ID}` ? { data: thread(11) } : undefined,
      postHandler: async () => ({ data: message() }),
    });

    const result = await tools.get("discord_send_message").handler({
      channel_id: THREAD_ID,
      message: "Hello, thread!",
    });

    assert.equal(result.isError === true, denied);
    assert.equal(calls.filter(({ method }) => method === "post").length, denied ? 0 : 1);
  }
});

test("thread sends reject invalid targets and unsupported parents before posting", async () => {
  const cases = [
    thread(0),
    thread(11, { id: OTHER_CHANNEL_ID }),
    thread(11, { guild_id: "100000000000000099" }),
    thread(11, { guild_id: undefined }),
    thread(11, { parent_id: undefined }),
    thread(11, { parent_id: null }),
    thread(11, { parent_id: OTHER_CHANNEL_ID }),
  ];
  for (const resolved of cases) {
    for (const replyToMessageId of [undefined, REPLY_TO_MESSAGE_ID]) {
      const { calls, tools } = registeredTools(VIEW_CHANNEL | SEND_MESSAGES_IN_THREADS | READ_MESSAGE_HISTORY, {
        getHandler: async (url) => url === `/channels/${THREAD_ID}` ? { data: resolved } : undefined,
      });

      const result = await tools.get("discord_send_message").handler({
        channel_id: THREAD_ID,
        message: "Hello, thread!",
        ...(replyToMessageId ? { reply_to_message_id: replyToMessageId } : {}),
      });

      assert.equal(result.isError, true);
      assert.match(resultJson(result).error, /required permissions/);
      assertNoMessagesRequest(calls);
    }
  }
});

test("thread sends reject Forum and Media parents before posting", async () => {
  for (const type of [15, 16]) {
    for (const replyToMessageId of [undefined, REPLY_TO_MESSAGE_ID]) {
      const { calls, tools } = registeredTools(VIEW_CHANNEL | SEND_MESSAGES_IN_THREADS | READ_MESSAGE_HISTORY, {
        channels: [{ id: CHANNEL_ID, type }],
        getHandler: async (url) => url === `/channels/${THREAD_ID}` ? { data: thread(11) } : undefined,
      });

      const result = await tools.get("discord_send_message").handler({
        channel_id: THREAD_ID,
        message: "Hello, thread!",
        ...(replyToMessageId ? { reply_to_message_id: replyToMessageId } : {}),
      });

      assert.equal(result.isError, true);
      assertNoMessagesRequest(calls);
    }
  }
});

test("thread send lookup retries once and reports Discord failures without posting", async () => {
  let attempts = 0;
  const delays = [];
  const { calls, tools } = registeredTools(VIEW_CHANNEL | SEND_MESSAGES_IN_THREADS, {
    getHandler: async (url) => {
      if (url !== `/channels/${THREAD_ID}`) return undefined;
      attempts += 1;
      if (attempts === 1) throw rateLimitError({ retryAfter: 0.25 });
      if (attempts === 2) return { data: thread(11) };
      throw discordApiError(403, "Missing Access");
    },
    postHandler: async () => ({ data: message() }),
    delay: async (milliseconds) => { delays.push(milliseconds); },
  });

  const first = await tools.get("discord_send_message").handler({ channel_id: THREAD_ID, message: "Hello" });
  const second = await tools.get("discord_send_message").handler({ channel_id: THREAD_ID, message: "Hello" });

  assert.equal(first.isError, undefined);
  assert.equal(second.isError, true);
  assert.equal(resultJson(second).error, "Discord API 403: Missing Access");
  assert.deepEqual(delays, [250]);
  assert.equal(calls.filter(({ method }) => method === "post").length, 1);
});

test("send reports Discord POST failures without retrying, and replies never fall back", async () => {
  const cases = [
    [undefined, discordApiError(403, "Missing Access"), "Discord API 403: Missing Access"],
    [undefined, discordApiError(404, "Unknown Channel"), "Discord API 404: Unknown Channel"],
    [undefined, rateLimitError({ retryAfter: 0.25 }), "Discord API 429: You are being rate limited."],
    [REPLY_TO_MESSAGE_ID, discordApiError(400, "Unknown Message"), "Discord API 400: Unknown Message"],
    [REPLY_TO_MESSAGE_ID, discordApiError(404, "Unknown Message"), "Discord API 404: Unknown Message"],
  ];
  for (const [replyToMessageId, failure, expectedError] of cases) {
    const delays = [];
    const { calls, tools } = registeredTools(VIEW_CHANNEL | SEND_MESSAGES_IN_THREADS | READ_MESSAGE_HISTORY, {
      getHandler: async (url) => url === `/channels/${THREAD_ID}` ? { data: thread(11) } : undefined,
      postHandler: async () => { throw failure; },
      delay: async (milliseconds) => { delays.push(milliseconds); },
    });

    const result = await tools.get("discord_send_message").handler({
      channel_id: THREAD_ID,
      message: "Hello, thread!",
      ...(replyToMessageId ? { reply_to_message_id: replyToMessageId } : {}),
    });

    assert.equal(result.isError, true);
    assert.equal(resultJson(result).error, expectedError);
    assert.equal(calls.filter(({ method }) => method === "post").length, 1);
    assert.deepEqual(calls.find(({ method }) => method === "post").data.message_reference,
      replyToMessageId ? {
        message_id: REPLY_TO_MESSAGE_ID,
        channel_id: THREAD_ID,
        fail_if_not_exists: true,
      } : undefined);
    assert.deepEqual(delays, []);
  }
});

test("send permissions are refreshed for each call", async () => {
  let currentPermissions = VIEW_CHANNEL | SEND_MESSAGES;
  const { calls, tools } = registeredTools(() => currentPermissions, {
    postHandler: async () => ({ data: message() }),
  });

  const first = await tools.get("discord_send_message").handler({ channel_id: CHANNEL_ID, message: "Hello" });
  currentPermissions = 0n;
  const second = await tools.get("discord_send_message").handler({ channel_id: CHANNEL_ID, message: "Hello" });

  assert.equal(first.isError, undefined);
  assert.equal(second.isError, true);
  assert.equal(calls.filter(({ method }) => method === "post").length, 1);
});

test("thread send permissions are refreshed for each call", async () => {
  let currentPermissions = VIEW_CHANNEL | SEND_MESSAGES_IN_THREADS;
  const { calls, tools } = registeredTools(() => currentPermissions, {
    getHandler: async (url) => url === `/channels/${THREAD_ID}` ? { data: thread(11) } : undefined,
    postHandler: async () => ({ data: message() }),
  });

  const first = await tools.get("discord_send_message").handler({ channel_id: THREAD_ID, message: "Hello" });
  currentPermissions = VIEW_CHANNEL;
  const second = await tools.get("discord_send_message").handler({ channel_id: THREAD_ID, message: "Hello" });

  assert.equal(first.isError, undefined);
  assert.equal(second.isError, true);
  assert.equal(calls.filter(({ method }) => method === "post").length, 1);
});

test("read handler reads every thread type under an accessible parent and preserves pagination", async () => {
  for (const type of [10, 11, 12]) {
    const { calls, tools } = registeredTools(VIEW_CHANNEL | READ_MESSAGE_HISTORY, {
      channels: [{ id: CHANNEL_ID, type: type === 10 ? 5 : 0 }],
      getHandler: async (url) => {
        if (url === `/channels/${THREAD_ID}`) return { data: thread(type, {
          thread_metadata: { archived: true, locked: true },
        }) };
        if (url === `/channels/${THREAD_ID}/messages`) return { data: [message()] };
      },
    });

    const result = await tools.get("discord_read_messages").handler({
      channel_id: THREAD_ID,
      limit: 7,
      before: "100000000000000009",
    });

    assert.deepEqual(resultJson(result), {
      channel_id: THREAD_ID,
      guild_id: GUILD_ID,
      messages: [{
        id: "100000000000000007",
        content: "message content",
        timestamp: "2026-08-06T00:00:00.000Z",
        author: {
          id: "100000000000000008",
          name: "username",
          username: "username",
          bot: false,
        },
        attachments: [],
        thread_id: null,
      }],
    });
    assert.deepEqual(calls.find(({ url }) => url === `/channels/${THREAD_ID}/messages`).config, {
      params: { limit: 7, before: "100000000000000009" },
    });
  }
});

test("thread lookup retries a rate limit once", async () => {
  let attempts = 0;
  const delays = [];
  const { calls, tools } = registeredTools(VIEW_CHANNEL | READ_MESSAGE_HISTORY, {
    getHandler: async (url) => {
      if (url === `/channels/${THREAD_ID}/messages`) return { data: [] };
      if (url !== `/channels/${THREAD_ID}`) return undefined;
      attempts += 1;
      if (attempts === 1) throw rateLimitError({ retryAfter: 0.25 });
      return { data: thread(11) };
    },
    delay: async (milliseconds) => { delays.push(milliseconds); },
  });

  const result = await tools.get("discord_read_messages").handler({ channel_id: THREAD_ID, limit: 20 });

  assert.deepEqual(resultJson(result).messages, []);
  assert.deepEqual(delays, [250]);
  assert.equal(calls.filter(({ url }) => url === `/channels/${THREAD_ID}`).length, 2);
});

test("thread reads reject targets outside the configured guild or accessible parent before messages", async () => {
  const cases = [
    ["missing guild", thread(11, { guild_id: undefined })],
    ["other guild", thread(11, { guild_id: "100000000000000099" })],
    ["wrong channel type", thread(0)],
    ["resolved ID mismatch", thread(11, { id: OTHER_CHANNEL_ID })],
    ["missing parent", thread(11, { parent_id: undefined })],
    ["null parent", thread(11, { parent_id: null })],
    ["unknown parent", thread(11, { parent_id: OTHER_CHANNEL_ID })],
  ];
  for (const [, resolved] of cases) {
    const { calls, tools } = registeredTools(VIEW_CHANNEL | READ_MESSAGE_HISTORY, {
      getHandler: async (url) => url === `/channels/${THREAD_ID}` ? { data: resolved } : undefined,
    });
    const result = await tools.get("discord_read_messages").handler({ channel_id: THREAD_ID, limit: 20 });
    assert.equal(result.isError, true);
    assert.match(resultJson(result).error, /required permissions/);
    assertNoMessagesRequest(calls);
  }
});

test("thread reads reject inaccessible and Forum or Media parents before messages", async () => {
  const cases = [
    ["parent lacks view", 0n, [{ id: CHANNEL_ID, type: 0 }]],
    ["parent lacks history", VIEW_CHANNEL, [{ id: CHANNEL_ID, type: 0 }]],
    ["Forum parent", VIEW_CHANNEL | READ_MESSAGE_HISTORY, [{ id: CHANNEL_ID, type: 15 }]],
    ["Media parent", VIEW_CHANNEL | READ_MESSAGE_HISTORY, [{ id: CHANNEL_ID, type: 16 }]],
  ];
  for (const [, permissions, channels] of cases) {
    const { calls, tools } = registeredTools(permissions, {
      channels,
      getHandler: async (url) => url === `/channels/${THREAD_ID}` ? { data: thread(11) } : undefined,
    });
    const result = await tools.get("discord_read_messages").handler({ channel_id: THREAD_ID, limit: 20 });
    assert.equal(result.isError, true);
    assertNoMessagesRequest(calls);
  }
});

test("thread access failures from Discord are reported without a message request", async () => {
  const { calls, tools } = registeredTools(VIEW_CHANNEL | READ_MESSAGE_HISTORY, {
    getHandler: async (url) => {
      if (url === `/channels/${THREAD_ID}`) throw discordApiError(403, "Missing Access");
    },
  });

  const result = await tools.get("discord_read_messages").handler({ channel_id: THREAD_ID, limit: 20 });

  assert.equal(result.isError, true);
  assert.equal(resultJson(result).error, "Discord API 403: Missing Access");
  assertNoMessagesRequest(calls);
});

test("thread message access failures are reported without mutating Discord", async () => {
  const { calls, tools } = registeredTools(VIEW_CHANNEL | READ_MESSAGE_HISTORY, {
    getHandler: async (url) => {
      if (url === `/channels/${THREAD_ID}`) return { data: thread(12) };
      if (url === `/channels/${THREAD_ID}/messages`) throw discordApiError(404, "Unknown Channel");
    },
  });

  const result = await tools.get("discord_read_messages").handler({ channel_id: THREAD_ID, limit: 20 });

  assert.equal(result.isError, true);
  assert.equal(resultJson(result).error, "Discord API 404: Unknown Channel");
  assert.equal(calls.filter(({ method }) => method === "post").length, 0);
});

test("list keeps thread channels outside its contract", async () => {
  const { tools } = registeredTools(VIEW_CHANNEL | SEND_MESSAGES, {
    channels: [{ id: CHANNEL_ID, type: 0 }, thread(11)],
  });

  const listed = await tools.get("discord_list_channels").handler({});

  assert.deepEqual(resultJson(listed).channels.map(({ id }) => id), [CHANNEL_ID]);
});

test("only Guild Text and Announcement channels are supported", () => {
  for (const type of [0, 5]) {
    assert.equal(isSupportedChannel({ type }), true);
  }

  for (const type of [10, 11, 12, 15, 16]) {
    assert.equal(isSupportedChannel({ type }), false);
  }
});

test("message output includes an active thread identifier or null", () => {
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
    thread_id: "100000000000000008",
  });
  assert.equal(messageOutput(message()).thread_id, null);
});
