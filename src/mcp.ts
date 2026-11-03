import axios, { type AxiosInstance, type AxiosRequestConfig, type AxiosResponse } from "axios";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";

const DISCORD_API_URL = "https://discord.com/api/v10";
const DISCORD_SNOWFLAKE = /^\d{17,20}$/;
const ADMINISTRATOR = 0x8n;
const VIEW_CHANNEL = 0x400n;
const READ_MESSAGE_HISTORY = 0x10000n;
const SEND_MESSAGES = 0x800n;
const SEND_MESSAGES_IN_THREADS = 0x4000000000n;
const LIST_CHANNELS_PERMISSIONS = VIEW_CHANNEL;
const READ_MESSAGES_PERMISSIONS = VIEW_CHANNEL | READ_MESSAGE_HISTORY;
const SEND_MESSAGE_PERMISSIONS = VIEW_CHANNEL | SEND_MESSAGES;
const SEND_THREAD_MESSAGE_PERMISSIONS = VIEW_CHANNEL | SEND_MESSAGES_IN_THREADS;
const SUPPORTED_CHANNEL_TYPES = new Set([0, 5]);
const THREAD_CHANNEL_TYPES = new Set([10, 11, 12]);
const MAX_TIMER_DELAY = 2_147_483_647;

type DiscordChannel = {
  id: string;
  guild_id?: string;
  name?: string;
  parent_id?: string | null;
  type: number;
  permission_overwrites?: DiscordPermissionOverwrite[];
};

type DiscordPermissionOverwrite = {
  id: string;
  type: 0 | 1;
  allow: string;
  deny: string;
};

type DiscordRole = {
  id: string;
  permissions: string;
};

type DiscordMember = {
  roles: string[];
  user: { id: string };
};

type DiscordUser = { id: string };

type DiscordMessage = {
  id: string;
  content: string;
  timestamp: string;
  author: {
    id: string;
    username: string;
    global_name?: string | null;
    bot?: boolean;
  };
  attachments: Array<{
    id: string;
    filename: string;
    url: string;
  }>;
  thread?: { id: string };
};

type DiscordClient = Pick<AxiosInstance, "get" | "post">;
type Sleep = (milliseconds: number) => Promise<void>;
type ChannelPermissions = { channel: DiscordChannel; permissions: bigint };

export function channelPermissions(
  guildId: string,
  channel: DiscordChannel,
  member: DiscordMember,
  roles: Map<string, DiscordRole>,
): bigint {
  const roleIds = [guildId, ...member.roles];
  let permissions = roleIds.reduce(
    (value, roleId) => value | BigInt(roles.get(roleId)?.permissions ?? "0"),
    0n,
  );
  if ((permissions & ADMINISTRATOR) !== 0n) {
    return permissions;
  }

  const overwrites = channel.permission_overwrites ?? [];
  const apply = (allow: bigint, deny: bigint) => {
    permissions &= ~deny;
    permissions |= allow;
  };
  const everyone = overwrites.find((overwrite) => overwrite.type === 0 && overwrite.id === guildId);
  if (everyone) apply(BigInt(everyone.allow), BigInt(everyone.deny));

  const roleOverwrites = overwrites.filter(
    (overwrite) => overwrite.type === 0 && member.roles.includes(overwrite.id),
  );
  apply(
    roleOverwrites.reduce((value, overwrite) => value | BigInt(overwrite.allow), 0n),
    roleOverwrites.reduce((value, overwrite) => value | BigInt(overwrite.deny), 0n),
  );

  const memberOverwrite = overwrites.find((overwrite) => overwrite.type === 1 && overwrite.id === member.user.id);
  if (memberOverwrite) apply(BigInt(memberOverwrite.allow), BigInt(memberOverwrite.deny));

  return permissions;
}

export function hasRequiredPermissions(permissions: bigint, requiredPermissions: bigint): boolean {
  return (permissions & ADMINISTRATOR) !== 0n
    || (permissions & requiredPermissions) === requiredPermissions;
}

export function isSupportedChannel(channel: Pick<DiscordChannel, "type">): boolean {
  return SUPPORTED_CHANNEL_TYPES.has(channel.type);
}

export function messageOutput(message: DiscordMessage) {
  return {
    id: message.id,
    content: message.content,
    timestamp: message.timestamp,
    author: {
      id: message.author.id,
      name: message.author.global_name ?? message.author.username,
      username: message.author.username,
      bot: message.author.bot ?? false,
    },
    attachments: message.attachments.map(({ id, filename, url }) => ({ id, filename, url })),
    thread_id: message.thread?.id ?? null,
  };
}

function requiredEnv(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

export function configuredGuildIds(env: NodeJS.ProcessEnv = process.env): string[] {
  if (Object.prototype.hasOwnProperty.call(env, "DISCORD_GUILD_IDS")) {
    const values = (env.DISCORD_GUILD_IDS ?? "").split(",").map((value) => value.trim());
    if (values.some((value) => !value)) {
      throw new Error("DISCORD_GUILD_IDS must contain one or more comma-separated Discord server IDs.");
    }
    if (values.some((value) => !DISCORD_SNOWFLAKE.test(value))) {
      throw new Error("DISCORD_GUILD_IDS must contain only Discord server IDs.");
    }
    return [...new Set(values)];
  }

  const guildId = requiredEnv("DISCORD_GUILD_ID", env);
  if (!DISCORD_SNOWFLAKE.test(guildId)) {
    throw new Error("DISCORD_GUILD_ID must be a Discord server ID.");
  }
  return [guildId];
}

export function normalizeListArguments(transport: Transport): Transport {
  const start = transport.start.bind(transport);
  transport.start = async () => {
    const onmessage = transport.onmessage;
    if (onmessage) {
      transport.onmessage = (message, extra) => {
        const request = message as {
          method?: unknown;
          params?: { name?: unknown; arguments?: unknown };
        };
        if (
          request.method === "tools/call"
          && request.params?.name === "discord_list_channels"
          && request.params.arguments === undefined
        ) {
          onmessage({
            ...message,
            params: { ...request.params, arguments: {} },
          }, extra);
          return;
        }
        onmessage(message, extra);
      };
    }
    await start();
  };
  return transport;
}

function errorText(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    const message = typeof error.response?.data?.message === "string"
      ? error.response.data.message
      : error.message;
    return status ? `Discord API ${status}: ${message}` : `Discord API error: ${message}`;
  }
  return error instanceof Error ? error.message : "Unexpected error";
}

function textResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

function errorResult(error: unknown) {
  return {
    ...textResult({ error: errorText(error) }),
    isError: true,
  };
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function retryDelayMilliseconds(error: unknown): number | undefined {
  const response = (error as {
    response?: { status?: unknown; data?: { retry_after?: unknown }; headers?: unknown };
  }).response;
  if (response?.status !== 429) return undefined;

  const toMilliseconds = (value: unknown): number | undefined => {
    if (typeof value === "string" && value.trim() === "") return undefined;
    const seconds = typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
    const milliseconds = Math.ceil(seconds * 1_000);
    return Number.isFinite(milliseconds) && milliseconds >= 0 && milliseconds <= MAX_TIMER_DELAY
      ? milliseconds
      : undefined;
  };

  const bodyDelay = toMilliseconds(response.data?.retry_after);
  if (bodyDelay !== undefined) return bodyDelay;

  const headers = response.headers;
  const headerDelay = headers && typeof headers === "object" && "get" in headers
    && typeof headers.get === "function"
    ? headers.get("retry-after")
    : (headers as Record<string, unknown> | undefined)?.["retry-after"]
      ?? (headers as Record<string, unknown> | undefined)?.["Retry-After"];
  return toMilliseconds(headerDelay);
}

async function discordGet<T>(
  discord: DiscordClient,
  url: string,
  config: AxiosRequestConfig | undefined,
  delay: Sleep,
): Promise<AxiosResponse<T>> {
  try {
    return await discord.get<T>(url, config);
  } catch (error) {
    const milliseconds = retryDelayMilliseconds(error);
    if (milliseconds === undefined) throw error;
    await delay(milliseconds);
    return discord.get<T>(url, config);
  }
}

export function registerDiscordTools(
  server: Pick<McpServer, "registerTool">,
  discord: DiscordClient,
  guildIds: readonly string[],
  { delay = sleep }: { delay?: Sleep } = {},
): void {
  const configuredGuildIdList = guildIds;
  const configuredGuildIds = new Set(configuredGuildIdList);
  const permissionDenied = () => new Error(
    "This bot does not have the required permissions for this supported channel or thread.",
  );

  const channelPermissionsSnapshot = async (guildId: string): Promise<Map<string, ChannelPermissions>> => {
    const [channelsResponse, rolesResponse, currentUserResponse] = await Promise.all([
      discordGet<DiscordChannel[]>(discord, `/guilds/${guildId}/channels`, undefined, delay),
      discordGet<DiscordRole[]>(discord, `/guilds/${guildId}/roles`, undefined, delay),
      discordGet<DiscordUser>(discord, "/users/@me", undefined, delay),
    ]);
    const memberResponse = await discordGet<DiscordMember>(
      discord,
      `/guilds/${guildId}/members/${currentUserResponse.data.id}`,
      undefined,
      delay,
    );
    const roles = new Map(rolesResponse.data.map((role) => [role.id, role]));
    return new Map(channelsResponse.data
      .filter(isSupportedChannel)
      .map((channel) => [channel.id, {
        channel,
        permissions: channelPermissions(guildId, channel, memberResponse.data, roles),
      }]));
  };

  const accessibleChannels = async (
    guildId: string,
    requiredPermissions: bigint,
  ): Promise<Map<string, DiscordChannel>> => {
    const channels = await channelPermissionsSnapshot(guildId);
    return new Map([...channels.values()]
      .filter(({ permissions }) => hasRequiredPermissions(permissions, requiredPermissions))
      .map(({ channel }) => [channel.id, channel]));
  };

  const resolvedChannel = async (channelId: string): Promise<{ channel: DiscordChannel; guildId: string }> => {
    const response = await discordGet<DiscordChannel>(
      discord,
      `/channels/${channelId}`,
      undefined,
      delay,
    );
    const channel = response.data;
    if (
      channel.id !== channelId
      || !channel.guild_id
      || !configuredGuildIds.has(channel.guild_id)
      || (!isSupportedChannel(channel) && !THREAD_CHANNEL_TYPES.has(channel.type))
    ) {
      throw permissionDenied();
    }
    return { channel, guildId: channel.guild_id };
  };

  const assertReadableChannel = async (channelId: string): Promise<{ channel: DiscordChannel; guildId: string }> => {
    const resolved = await resolvedChannel(channelId);
    const channels = await accessibleChannels(resolved.guildId, READ_MESSAGES_PERMISSIONS);
    if (isSupportedChannel(resolved.channel) && channels.has(channelId)) return resolved;
    if (
      !THREAD_CHANNEL_TYPES.has(resolved.channel.type)
      || !resolved.channel.parent_id
      || !channels.has(resolved.channel.parent_id)
    ) {
      throw permissionDenied();
    }
    return resolved;
  };

  const assertSendableChannel = async (
    channelId: string,
    isReply: boolean,
  ): Promise<{ channel: DiscordChannel; guildId: string }> => {
    const directPermissions = SEND_MESSAGE_PERMISSIONS | (isReply ? READ_MESSAGE_HISTORY : 0n);
    const threadPermissions = SEND_THREAD_MESSAGE_PERMISSIONS | (isReply ? READ_MESSAGE_HISTORY : 0n);
    const resolved = await resolvedChannel(channelId);
    const channels = await channelPermissionsSnapshot(resolved.guildId);
    const directChannel = channels.get(channelId);
    if (isSupportedChannel(resolved.channel) && directChannel) {
      if (!hasRequiredPermissions(directChannel.permissions, directPermissions)) {
        throw permissionDenied();
      }
      return resolved;
    }

    const parent = resolved.channel.parent_id ? channels.get(resolved.channel.parent_id) : undefined;
    if (
      !THREAD_CHANNEL_TYPES.has(resolved.channel.type)
      || !parent
      || !hasRequiredPermissions(parent.permissions, threadPermissions)
    ) {
      throw permissionDenied();
    }
    return resolved;
  };

  server.registerTool(
    "discord_list_channels",
    {
      title: "List accessible Discord channels",
      description: "Lists Guild Text and Announcement channels where this Discord bot has VIEW_CHANNEL across configured servers, or one configured server when guild_id is supplied. Forum, Media, and thread channels are excluded.",
      inputSchema: {
        guild_id: z.string().regex(DISCORD_SNOWFLAKE, "Use a Discord server ID.").optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ guild_id }) => {
      try {
        const targetGuildIds = guild_id === undefined ? configuredGuildIdList : [guild_id];
        if (targetGuildIds.some((guildId) => !configuredGuildIds.has(guildId))) throw permissionDenied();
        const channelGroups = await Promise.all(targetGuildIds.map(async (guildId) =>
          [...(await accessibleChannels(guildId, LIST_CHANNELS_PERMISSIONS)).values()].map((channel) => ({
            id: channel.id,
            guild_id: guildId,
            name: channel.name ?? null,
            parent_id: channel.parent_id ?? null,
            type: channel.type,
          }))));
        const channels = channelGroups.flat();
        return textResult({ channels });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "discord_read_messages",
    {
      title: "Read Discord messages",
      description: "Reads recent messages from one Guild Text or Announcement channel, or a supplied thread under one, where the bot has VIEW_CHANNEL and READ_MESSAGE_HISTORY. Forum and Media channels remain excluded.",
      inputSchema: {
        channel_id: z.string().regex(DISCORD_SNOWFLAKE, "Use a Discord channel ID."),
        limit: z.number().int().min(1).max(50).default(20),
        before: z.string().regex(DISCORD_SNOWFLAKE, "Use a Discord message ID.").optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ channel_id, limit, before }) => {
      try {
        const { guildId } = await assertReadableChannel(channel_id);
        const response = await discordGet<DiscordMessage[]>(
          discord,
          `/channels/${channel_id}/messages`,
          { params: { limit, ...(before ? { before } : {}) } },
          delay,
        );
        const messages = response.data.map(messageOutput);
        return textResult({ channel_id, guild_id: guildId, messages });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "discord_send_message",
    {
      title: "Send a Discord message",
      description: "Sends a message as the configured Discord bot to one Guild Text or Announcement channel where it has VIEW_CHANNEL and SEND_MESSAGES, or to a supplied thread under one where it has VIEW_CHANNEL and SEND_MESSAGES_IN_THREADS. Optionally replies to a message in that same channel or thread; replies also require READ_MESSAGE_HISTORY and fail if the referenced message does not exist. Discord enforces private-thread membership and locked-thread access; sending can unarchive an unlocked archived thread. Forum and Media channels remain excluded. Mentions are never notified, including the replied-to author.",
      inputSchema: {
        channel_id: z.string().regex(DISCORD_SNOWFLAKE, "Use a Discord channel ID."),
        message: z.string().trim().min(1).max(2_000),
        reply_to_message_id: z.string().regex(DISCORD_SNOWFLAKE, "Use a Discord message ID.").optional()
          .describe("Message ID in channel_id to reply to."),
      },
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ channel_id, message, reply_to_message_id }) => {
      try {
        const { guildId } = await assertSendableChannel(channel_id, reply_to_message_id !== undefined);
        const response = await discord.post<DiscordMessage>(`/channels/${channel_id}/messages`, {
          content: message,
          allowed_mentions: { parse: [], replied_user: false },
          ...(reply_to_message_id !== undefined ? {
            message_reference: {
              message_id: reply_to_message_id,
              channel_id,
              fail_if_not_exists: true,
            },
          } : {}),
        });
        const sent = response.data;
        return textResult({
          channel_id,
          guild_id: guildId,
          message_id: sent.id,
          timestamp: sent.timestamp,
          author: sent.author.global_name ?? sent.author.username,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}

async function main(): Promise<void> {
  const token = requiredEnv("DISCORD_BOT_TOKEN");
  const guildIds = configuredGuildIds();
  const discord = axios.create({
    baseURL: DISCORD_API_URL,
    headers: { Authorization: `Bot ${token}` },
    timeout: 15_000,
  });
  const server = new McpServer({ name: "codex-discord", version: "0.1.0" });

  registerDiscordTools(server, discord, guildIds);
  await server.connect(normalizeListArguments(new StdioServerTransport()));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(errorText(error));
    process.exit(1);
  });
}
