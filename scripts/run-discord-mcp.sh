#!/bin/sh
set -eu

: "${DISCORD_MCP_KEYCHAIN_SERVICE:=codex-discord-bot-token}"
: "${DISCORD_GUILD_ID:?DISCORD_GUILD_ID is required}"

DISCORD_BOT_TOKEN="$(security find-generic-password -s "$DISCORD_MCP_KEYCHAIN_SERVICE" -w)"
export DISCORD_BOT_TOKEN

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec node "$SCRIPT_DIR/../lib/mcp.js"
