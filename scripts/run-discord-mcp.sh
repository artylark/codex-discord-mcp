#!/bin/sh
set -eu

: "${DISCORD_MCP_KEYCHAIN_SERVICE:=codex-discord-bot-token}"
if [ "${DISCORD_GUILD_IDS+x}" != x ]; then
  : "${DISCORD_GUILD_ID:?DISCORD_GUILD_ID is required when DISCORD_GUILD_IDS is unset}"
fi

DISCORD_BOT_TOKEN="$(security find-generic-password -s "$DISCORD_MCP_KEYCHAIN_SERVICE" -w)"
export DISCORD_BOT_TOKEN

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec node "$SCRIPT_DIR/../lib/mcp.js"
