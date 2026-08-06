import axios from "axios";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const DISCORD_API_URL = "https://discord.com/api/v10";
const DISCORD_SNOWFLAKE = /^\d{17,20}$/;
const ADMINISTRATOR = 0x8n;
const VIEW_CHANNEL = 0x400n;
const SUPPORTED_CHANNEL_TYPES = new Set([0, 5]);

type DiscordChannel = {
  id: string;
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
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function configuredGuildId(): string {
  const guildId = requiredEnv("DISCORD_GUILD_ID");
  if (!DISCORD_SNOWFLAKE.test(guildId)) {
    throw new Error("DISCORD_GUILD_ID must be a Discord server ID.");
  }
  return guildId;
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

async function main(): Promise<void> {
  const token = requiredEnv("DISCORD_BOT_TOKEN");
  const guildId = configuredGuildId();
  const discord = axios.create({
    baseURL: DISCORD_API_URL,
    headers: { Authorization: `Bot ${token}` },
    timeout: 15_000,
  });

  const accessibleChannels = async (): Promise<Map<string, DiscordChannel>> => {
    const [channelsResponse, rolesResponse, currentUserResponse] = await Promise.all([
      discord.get<DiscordChannel[]>(`/guilds/${guildId}/channels`),
      discord.get<DiscordRole[]>(`/guilds/${guildId}/roles`),
      discord.get<DiscordUser>("/users/@me"),
    ]);
    const memberResponse = await discord.get<DiscordMember>(
      `/guilds/${guildId}/members/${currentUserResponse.data.id}`,
    );
    const roles = new Map(rolesResponse.data.map((role) => [role.id, role]));
    return new Map(
      channelsResponse.data
        .filter(isSupportedChannel)
        .filter((channel) => (channelPermissions(guildId, channel, memberResponse.data, roles) & VIEW_CHANNEL) !== 0n)
        .map((channel) => [channel.id, channel]),
    );
  };

  const assertAccessibleChannel = async (channelId: string): Promise<DiscordChannel> => {
    const channels = await accessibleChannels();
    const channel = channels.get(channelId);
    if (!channel) {
      throw new Error("This bot does not have permission to view this supported channel.");
    }
    return channel;
  };

  const server = new McpServer({ name: "codex-discord", version: "0.1.0" });

  server.registerTool(
    "discord_list_channels",
    {
      title: "List accessible Discord channels",
      description: "Lists only Guild Text and Announcement channels this Discord bot can currently view through its roles. Forum, Media, and thread channels are excluded.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const channels = [...(await accessibleChannels()).values()].map((channel) => ({
          id: channel.id,
          name: channel.name ?? null,
          parent_id: channel.parent_id ?? null,
          type: channel.type,
        }));
        return textResult({ channels });
      } catch (error) {
        return textResult({ error: errorText(error) });
      }
    },
  );

  server.registerTool(
    "discord_read_messages",
    {
      title: "Read Discord messages",
      description: "Reads recent messages from one Guild Text or Announcement channel the bot can currently view through its roles. Forum, Media, and thread channels are excluded.",
      inputSchema: {
        channel_id: z.string().regex(DISCORD_SNOWFLAKE, "Use a Discord channel ID."),
        limit: z.number().int().min(1).max(50).default(20),
        before: z.string().regex(DISCORD_SNOWFLAKE, "Use a Discord message ID.").optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ channel_id, limit, before }) => {
      try {
        await assertAccessibleChannel(channel_id);
        const response = await discord.get<DiscordMessage[]>(`/channels/${channel_id}/messages`, {
          params: { limit, ...(before ? { before } : {}) },
        });
        const messages = response.data.map(messageOutput);
        return textResult({ channel_id, messages });
      } catch (error) {
        return textResult({ error: errorText(error) });
      }
    },
  );

  server.registerTool(
    "discord_send_message",
    {
      title: "Send a Discord message",
      description: "Sends a message as the configured Discord bot to one Guild Text or Announcement channel the bot can currently view. Forum, Media, and thread channels are excluded. Mentions are never notified.",
      inputSchema: {
        channel_id: z.string().regex(DISCORD_SNOWFLAKE, "Use a Discord channel ID."),
        message: z.string().trim().min(1).max(2_000),
      },
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ channel_id, message }) => {
      try {
        await assertAccessibleChannel(channel_id);
        const response = await discord.post<DiscordMessage>(`/channels/${channel_id}/messages`, {
          content: message,
          allowed_mentions: { parse: [] },
        });
        const sent = response.data;
        return textResult({
          channel_id,
          message_id: sent.id,
          timestamp: sent.timestamp,
          author: sent.author.global_name ?? sent.author.username,
        });
      } catch (error) {
        return textResult({ error: errorText(error) });
      }
    },
  );

  await server.connect(new StdioServerTransport());
}

if (require.main === module) {
  main().catch((error) => {
    console.error(errorText(error));
    process.exit(1);
  });
}
