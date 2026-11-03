const test = require("node:test");
const assert = require("node:assert/strict");
const { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");

const GUILD_ID = "100000000000000001";
const LAUNCHER = join(__dirname, "..", "scripts", "run-discord-mcp.sh");
const MCP = join(__dirname, "..", "lib", "mcp.js");

function runLauncher({ failSecurity = false, guildId = GUILD_ID, guildIds, useLegacyGuild = true } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "codex-discord-mcp-launcher-"));
  const bin = join(directory, "bin");
  const log = join(directory, "security-arguments");
  mkdirSync(bin);
  writeFileSync(join(bin, "security"), [
    "#!/bin/sh",
    "printf '%s\\n' \"$@\" > \"$DISCORD_TEST_SECURITY_LOG\"",
    "if [ \"${DISCORD_TEST_SECURITY_FAIL:-}\" = 1 ]; then exit 37; fi",
    "printf token",
  ].join("\n"));
  writeFileSync(join(bin, "node"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "security"), 0o755);
  chmodSync(join(bin, "node"), 0o755);

  try {
    const result = spawnSync(LAUNCHER, {
      env: {
        ...process.env,
        DISCORD_GUILD_ID: undefined,
        DISCORD_GUILD_IDS: undefined,
        DISCORD_TEST_SECURITY_FAIL: undefined,
        PATH: `${bin}:${process.env.PATH}`,
        ...(useLegacyGuild ? { DISCORD_GUILD_ID: guildId } : {}),
        ...(guildIds === undefined ? {} : { DISCORD_GUILD_IDS: guildIds }),
        DISCORD_MCP_KEYCHAIN_SERVICE: "expected-service",
        DISCORD_TEST_SECURITY_LOG: log,
        ...(failSecurity ? { DISCORD_TEST_SECURITY_FAIL: "1" } : {}),
      },
      encoding: "utf8",
    });
    return {
      result,
      arguments: existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [],
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("launcher reads only the configured Keychain service", () => {
  const { result, arguments: securityArguments } = runLauncher();

  assert.equal(result.status, 0);
  assert.deepEqual(securityArguments, ["find-generic-password", "-s", "expected-service", "-w"]);
});

test("launcher stops when its Keychain service lookup fails", () => {
  const { result, arguments: securityArguments } = runLauncher({ failSecurity: true });

  assert.equal(result.status, 37);
  assert.deepEqual(securityArguments, ["find-generic-password", "-s", "expected-service", "-w"]);
});

test("launcher accepts a plural guild setting without a legacy guild setting", () => {
  const { result, arguments: securityArguments } = runLauncher({
    useLegacyGuild: false,
    guildIds: `${GUILD_ID},200000000000000001`,
  });

  assert.equal(result.status, 0);
  assert.deepEqual(securityArguments, ["find-generic-password", "-s", "expected-service", "-w"]);
});

test("launcher stops before Keychain lookup when no guild setting is supplied", () => {
  const { result, arguments: securityArguments } = runLauncher({ useLegacyGuild: false });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DISCORD_GUILD_ID is required/);
  assert.deepEqual(securityArguments, []);
});

test("launcher passes an empty plural setting through to application validation", () => {
  const { result, arguments: securityArguments } = runLauncher({ guildIds: "" });

  assert.equal(result.status, 0);
  assert.deepEqual(securityArguments, ["find-generic-password", "-s", "expected-service", "-w"]);
});

test("application rejects invalid plural settings before connecting to Discord", () => {
  for (const { guildIds, guildId, error } of [
    { guildIds: "", guildId: undefined, error: /DISCORD_GUILD_IDS must contain one or more/ },
    { guildIds: "invalid", guildId: GUILD_ID, error: /DISCORD_GUILD_IDS must contain only/ },
  ]) {
    const environment = { ...process.env, DISCORD_BOT_TOKEN: "test", DISCORD_GUILD_IDS: guildIds };
    if (guildId === undefined) delete environment.DISCORD_GUILD_ID;
    else environment.DISCORD_GUILD_ID = guildId;
    const result = spawnSync(process.execPath, [MCP], { env: environment, encoding: "utf8" });

    assert.equal(result.status, 1);
    assert.match(result.stderr, error);
  }
});
