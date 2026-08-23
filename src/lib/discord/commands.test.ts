import assert from "node:assert/strict";
import test from "node:test";

import { DISCORD_COMMANDS } from "@/lib/discord/commands";

test("Discord 후보 배포 명령은 main 기반 snapshot만 등록한다", () => {
  const names: readonly string[] = DISCORD_COMMANDS.map(({ name }) => name);
  const commands = DISCORD_COMMANDS.map(({ name, description }) => ({
    name,
    description,
  }));
  const snapshot = commands.find((command) => command.name === "snapshot");

  assert.ok(snapshot);
  assert.match(snapshot.description, /main snapshot/);
  assert.equal(names.includes("develop"), false);
});
