# codex-discord-mcp

Local MCP server that gives Codex role-scoped access to a Discord bot.

Discord roles are the source of truth. The MCP server computes the bot's
current permissions and exposes only text channels the bot can view.

## Security boundaries

- Bot credentials live only in macOS Keychain, never in this repository.
- The server exposes channel listing, message reading, and message sending.
- It does not expose role, channel, message-editing, message-deletion, or
  server-management tools.
- Outgoing messages disable all user and role notifications.

## Setup

1. Create a Discord bot and grant it the same access-only roles as its owner.
   Do not grant administrator, moderation, or server-management permissions.
2. Store the bot token in macOS Keychain under the service name
   `codex-discord-bot-token`:

   ```sh
   security add-generic-password -a "$USER" -s codex-discord-bot-token -U -w
   ```

3. Enable Discord Developer Mode and copy the server ID.
4. Install dependencies and build:

   ```sh
   npm install
   npm run build
   ```

5. Add the server to `~/.codex/config.toml`:

   ```toml
   [mcp_servers.discord]
   command = "/absolute/path/to/codex-discord-mcp/scripts/run-discord-mcp.sh"
   args = []

   [mcp_servers.discord.env]
   DISCORD_GUILD_ID = "123456789012345678"
   ```

Restart Codex after editing its MCP configuration.

## Tools

- `discord_list_channels` — list channels available through the bot's roles
- `discord_read_messages` — read recent messages from an accessible channel
- `discord_send_message` — send a message as the bot to an accessible channel
