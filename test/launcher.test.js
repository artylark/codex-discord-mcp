const test = require("node:test");
const assert = require("node:assert/strict");
const { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");

const GUILD_ID = "100000000000000001";
const LAUNCHER = join(__dirname, "..", "scripts", "run-discord-mcp.sh");

function runLauncher({ failSecurity = false } = {}) {
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
        PATH: `${bin}:${process.env.PATH}`,
        DISCORD_GUILD_ID: GUILD_ID,
        DISCORD_MCP_KEYCHAIN_SERVICE: "expected-service",
        DISCORD_TEST_SECURITY_LOG: log,
        ...(failSecurity ? { DISCORD_TEST_SECURITY_FAIL: "1" } : {}),
      },
      encoding: "utf8",
    });
    return { result, arguments: readFileSync(log, "utf8").trim().split("\n") };
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
