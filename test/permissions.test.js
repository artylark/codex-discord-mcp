const test = require("node:test");
const assert = require("node:assert/strict");

const { channelPermissions } = require("../lib/mcp.js");

const GUILD_ID = "100000000000000001";
const ROLE_ID = "100000000000000002";
const MEMBER_ID = "100000000000000003";
const VIEW_CHANNEL = 0x400n;

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
