import assert from "node:assert/strict";
import test from "node:test";

import { DISCORD_COMMANDS } from "@/lib/discord/commands";

function targetOption(command: unknown) {
  const value = command as {
    options?: ReadonlyArray<{
      name?: string;
      required?: boolean;
      choices?: ReadonlyArray<{ value?: string }>;
    }>;
  };
  return value.options?.find((item) => item.name === "target");
}

test("Discord 후보 배포 명령은 main 기반 snapshot만 등록한다", () => {
  const names: readonly string[] = DISCORD_COMMANDS.map(({ name }) => name);
  const commands = DISCORD_COMMANDS.map(({ name, description }) => ({
    name,
    description,
  }));
  const snapshot = commands.find((command) => command.name === "snapshot");
  const deploy = DISCORD_COMMANDS.find((command) => command.name === "deploy");

  assert.ok(snapshot);
  assert.ok(deploy);
  assert.match(snapshot.description, /main snapshot/);
  const snapshotTarget = targetOption(
    DISCORD_COMMANDS.find((command) => command.name === "snapshot"),
  );
  const deployTarget = targetOption(deploy);
  assert.equal(snapshotTarget?.required, true);
  assert.deepEqual(
    snapshotTarget?.choices?.map((choice) => choice.value),
    ["AIT", "PLAY", "APPSTORE", "ALL"],
  );
  assert.deepEqual(snapshotTarget, deployTarget);
  assert.equal(names.includes("develop"), false);
});
