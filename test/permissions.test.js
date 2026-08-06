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

function registeredTools(permissions, {
  failChannelListing = false,
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
        return { data: [{ id: CHANNEL_ID, type: 0 }] };
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

  registerDiscordTools(server, discord, GUILD_ID, { delay });
  return { calls, tools };
}

function resultJson(result) {
  return JSON.parse(result.content[0].text);
}

function assertNoMessagesRequest(calls) {
  assert.equal(calls.some(({ url }) => url === `/channels/${CHANNEL_ID}/messages`), false);
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
  assert.equal(result.isError, true);
  assertNoMessagesRequest(calls);
});

test("send handler denies a channel without SEND_MESSAGES before posting a message", async () => {
  const { calls, tools } = registeredTools(VIEW_CHANNEL);

  const result = await tools.get("discord_send_message").handler({
    channel_id: CHANNEL_ID,
    message: "Hello, Discord!",
  });

  assert.match(resultJson(result).error, /required permissions/);
  assert.equal(result.isError, true);
  assertNoMessagesRequest(calls);
});

test("list handler marks Discord failures as errors", async () => {
  const { tools } = registeredTools(VIEW_CHANNEL, { failChannelListing: true });

  const result = await tools.get("discord_list_channels").handler({});

  assert.match(resultJson(result).error, /Unable to list channels/);
  assert.equal(result.isError, true);
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
  assert.equal(calls.filter((call) => call.method === "get").length, 8);
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
