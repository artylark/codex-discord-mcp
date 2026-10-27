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
const SEND_MESSAGES_IN_THREADS = 0x4000000000n;
const CHANNEL_ID = "100000000000000004";
const THREAD_ID = "100000000000000005";
const OTHER_CHANNEL_ID = "100000000000000006";

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
    const { calls, tools } = registeredTools(permissions);

    const result = await tools.get("discord_send_message").handler({
      channel_id: CHANNEL_ID,
      message: "Hello, Discord!",
    });

    assert.match(resultJson(result).error, /required permissions/);
    assert.equal(result.isError, true);
    assertNoMessagesRequest(calls);
  }
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
  assert.equal(calls.some((call) => call.url === `/channels/${CHANNEL_ID}`), false);
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
      message_id: "100000000000000007",
      timestamp: "2026-08-06T00:00:00.000Z",
      author: "username",
    });
    assert.deepEqual(calls.find(({ method }) => method === "post").data, {
      content: "Hello, Discord!",
      allowed_mentions: { parse: [] },
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
      message_id: "100000000000000007",
      timestamp: "2026-08-06T00:00:00.000Z",
      author: "username",
    });
    const posts = calls.filter(({ method }) => method === "post");
    assert.equal(posts.length, 1);
    assert.equal(posts[0].url, `/channels/${THREAD_ID}/messages`);
    assert.deepEqual(posts[0].data, {
      content: "Hello, thread!",
      allowed_mentions: { parse: [] },
    });
    assert.equal(calls.some(({ url }) => url === `/channels/${THREAD_ID}`), true);
  }
});

test("thread sends require VIEW_CHANNEL and SEND_MESSAGES_IN_THREADS, not SEND_MESSAGES", async () => {
  for (const permissions of [
    SEND_MESSAGES_IN_THREADS,
    VIEW_CHANNEL,
    VIEW_CHANNEL | SEND_MESSAGES,
  ]) {
    const { calls, tools } = registeredTools(permissions, {
      getHandler: async (url) => url === `/channels/${THREAD_ID}` ? { data: thread(11) } : undefined,
    });

    const result = await tools.get("discord_send_message").handler({
      channel_id: THREAD_ID,
      message: "Hello, thread!",
    });

    assert.equal(result.isError, true);
    assert.match(resultJson(result).error, /required permissions/);
    assertNoMessagesRequest(calls);
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
    const { calls, tools } = registeredTools(VIEW_CHANNEL | SEND_MESSAGES_IN_THREADS, {
      getHandler: async (url) => url === `/channels/${THREAD_ID}` ? { data: resolved } : undefined,
    });

    const result = await tools.get("discord_send_message").handler({
      channel_id: THREAD_ID,
      message: "Hello, thread!",
    });

    assert.equal(result.isError, true);
    assert.match(resultJson(result).error, /required permissions/);
    assertNoMessagesRequest(calls);
  }
});

test("thread sends reject Forum and Media parents before posting", async () => {
  for (const type of [15, 16]) {
    const { calls, tools } = registeredTools(VIEW_CHANNEL | SEND_MESSAGES_IN_THREADS, {
      channels: [{ id: CHANNEL_ID, type }],
      getHandler: async (url) => url === `/channels/${THREAD_ID}` ? { data: thread(11) } : undefined,
    });

    const result = await tools.get("discord_send_message").handler({
      channel_id: THREAD_ID,
      message: "Hello, thread!",
    });

    assert.equal(result.isError, true);
    assertNoMessagesRequest(calls);
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

test("thread send reports Discord POST failures without retrying", async () => {
  const cases = [
    [discordApiError(403, "Missing Access"), "Discord API 403: Missing Access"],
    [discordApiError(404, "Unknown Channel"), "Discord API 404: Unknown Channel"],
    [rateLimitError({ retryAfter: 0.25 }), "Discord API 429: You are being rate limited."],
  ];
  for (const [failure, expectedError] of cases) {
    const delays = [];
    const { calls, tools } = registeredTools(VIEW_CHANNEL | SEND_MESSAGES_IN_THREADS, {
      getHandler: async (url) => url === `/channels/${THREAD_ID}` ? { data: thread(11) } : undefined,
      postHandler: async () => { throw failure; },
      delay: async (milliseconds) => { delays.push(milliseconds); },
    });

    const result = await tools.get("discord_send_message").handler({
      channel_id: THREAD_ID,
      message: "Hello, thread!",
    });

    assert.equal(result.isError, true);
    assert.equal(resultJson(result).error, expectedError);
    assert.equal(calls.filter(({ method }) => method === "post").length, 1);
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
