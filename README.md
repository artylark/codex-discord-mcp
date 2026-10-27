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
- Outgoing messages disable all user and role notifications.

## Required Discord permissions

- `discord_list_channels` requires `VIEW_CHANNEL`.
- `discord_read_messages` requires both `VIEW_CHANNEL` and
  `READ_MESSAGE_HISTORY` on a Guild Text or Announcement channel. It also
  reads a supplied thread under one of those channels; private-thread
  membership remains enforced by Discord.
- `discord_send_message` requires both `VIEW_CHANNEL` and `SEND_MESSAGES` for
  a Guild Text or Announcement channel. For a supplied thread under one, it
  requires `VIEW_CHANNEL` and `SEND_MESSAGES_IN_THREADS` on the parent. Discord
  enforces private-thread membership and locked-thread access when sending.

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
4. Enable Discord Developer Mode and copy the server ID.
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
   DISCORD_GUILD_ID = "123456789012345678"
   ```

Restart Codex after editing its MCP configuration.

## Tools

- `discord_list_channels` — list Guild Text and Announcement channels where the bot has `VIEW_CHANNEL`
- `discord_read_messages` — read recent messages where the bot has both `VIEW_CHANNEL` and `READ_MESSAGE_HISTORY`, including a supplied thread ID under an accessible Guild Text or Announcement channel
- `discord_send_message` — send a message where the bot has both `VIEW_CHANNEL` and `SEND_MESSAGES`, or to a supplied thread under an accessible Guild Text or Announcement channel where it has `VIEW_CHANNEL` and `SEND_MESSAGES_IN_THREADS`

For a Discord thread URL, use its middle ID as `channel_id`:
`/channels/<guild-id>/<thread-id>/<message-id>`. Parent-channel messages expose
`thread_id` when Discord reports an active thread. The server exposes no tools to list,
create, join, or manage threads. Discord can automatically unarchive an unlocked
archived thread when a message is sent to it. Archived threads can be read when
Discord grants the bot access. Forum and Media channels, and threads under them,
are excluded.
