# codex-discord-mcp

Local MCP server that gives Codex Discord-permission-scoped access to a bot.

Discord guild roles and channel permission overwrites are the source of truth.
The MCP server computes the bot's current permissions and exposes Guild Text
and Announcement channels the bot is allowed to use for each tool. Message
reading and sending also accept a supplied thread ID whose parent is an
accessible Guild Text or Announcement channel. Forum and Media channels are
excluded.

## Security boundaries

- Bot credentials live only in macOS Keychain, never in this repository.
- The server exposes channel listing, message reading, and message sending.
- It does not expose role, channel, message-editing, message-deletion, or
  server-management tools.
- Outgoing messages disable all user and role notifications, including reply
  notifications to the referenced message's author.

## Required Discord permissions

- `discord_list_channels` requires `VIEW_CHANNEL`.
- `discord_read_messages` requires both `VIEW_CHANNEL` and
  `READ_MESSAGE_HISTORY` on a Guild Text or Announcement channel. It also
  reads a supplied thread under one of those channels; private-thread
  membership remains enforced by Discord.
- `discord_send_message` requires both `VIEW_CHANNEL` and `SEND_MESSAGES` for
  a Guild Text or Announcement channel. For a supplied thread under one, it
  requires `VIEW_CHANNEL` and `SEND_MESSAGES_IN_THREADS` on the parent. Discord
  enforces private-thread membership and locked-thread access when sending. A
  reply also requires `READ_MESSAGE_HISTORY` on the same channel or thread.

The `ADMINISTRATOR` permission satisfies these checks, but it is not
recommended for this bot.

## Setup

1. Create a Discord bot and grant it the same access-only roles as its owner.
   Do not grant administrator, moderation, or server-management permissions.
2. Store the bot token in macOS Keychain under the service name
   `codex-discord-bot-token`:

   ```sh
   security add-generic-password -a "$USER" -s codex-discord-bot-token -U -w
   ```

3. In the Discord Developer Portal, enable the Message Content privileged intent
   for the bot. Verified apps require Discord's approval for this intent. Without
   it, `discord_read_messages` receives empty message content and attachments.
4. Enable Discord Developer Mode and copy each server ID to allow.
5. Install dependencies and build:

   ```sh
   npm install
   npm run build
   ```

6. Add the server to `~/.codex/config.toml`:

   ```toml
   [mcp_servers.discord]
   command = "/absolute/path/to/codex-discord-mcp/scripts/run-discord-mcp.sh"
   args = []

   [mcp_servers.discord.env]
   DISCORD_GUILD_IDS = "123456789012345678,234567890123456789"
   ```

   `DISCORD_GUILD_IDS` is the preferred comma-separated allowlist. Surrounding
   whitespace on each ID is trimmed and duplicate IDs are removed. Empty values,
   empty comma-separated elements, and malformed IDs stop startup; a present
   plural setting never falls back to `DISCORD_GUILD_ID`. The latter remains
   supported for an existing single-server configuration. Guild membership is
   checked only when a tool is used, so Discord API errors for an unavailable
   configured server are returned at that time. Requests filtered to another
   configured server do not depend on it.

Restart Codex after editing its MCP configuration.

## Tools

- `discord_list_channels` — list Guild Text and Announcement channels where the bot has `VIEW_CHANNEL`. Its optional `guild_id` limits the result to one configured server; every returned channel includes `guild_id`.
- `discord_read_messages` — read recent messages where the bot has both `VIEW_CHANNEL` and `READ_MESSAGE_HISTORY`, including a supplied thread ID under an accessible Guild Text or Announcement channel. Successful responses include `guild_id`.
- `discord_send_message` — send a message where the bot has both `VIEW_CHANNEL` and `SEND_MESSAGES`, or to a supplied thread under an accessible Guild Text or Announcement channel where it has `VIEW_CHANNEL` and `SEND_MESSAGES_IN_THREADS`. Set the optional `reply_to_message_id` to reply to a message in that same channel or thread. When it is omitted, the tool sends an ordinary post. A missing referenced message returns an error and never falls back to a normal post. Successful responses include `guild_id`.

For a Discord thread URL, use its middle ID as `channel_id`:
`/channels/<guild-id>/<thread-id>/<message-id>`. Parent-channel messages expose
`thread_id` when Discord reports an active thread. The server exposes no tools to list,
create, join, or manage threads. Discord can automatically unarchive an unlocked
archived thread when a message is sent to it. Archived threads can be read when
Discord grants the bot access. Forum and Media channels, and threads under them,
are excluded.

## Adding another server

Ask the server owner to install the bot with a server-install URL such as:

```
https://discord.com/oauth2/authorize?client_id=<APPLICATION_ID>&scope=bot&permissions=274877975552
```

The installer needs `MANAGE_GUILD`. The requested permissions are
`VIEW_CHANNEL`, `READ_MESSAGE_HISTORY`, `SEND_MESSAGES`, and
`SEND_MESSAGES_IN_THREADS`; access is still restricted by the bot's role and
channel overwrites. If the bot is private, only its application owner can add
it to another server. After installation, obtain the new server ID, add it to
`DISCORD_GUILD_IDS`, restart Codex, and verify the allowed channels before any
test post. This MCP uses Discord's REST API and does not require a command
scope for its tools.
