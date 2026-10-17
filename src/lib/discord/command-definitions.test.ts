import assert from "node:assert/strict";
import test from "node:test";
import { COMMAND_DEFINITIONS, commandHelpText, resolveDiscordCommand } from "./command-definitions";
import { DISCORD_COMMANDS } from "./commands";

test("등록·도움말·권한·지연 응답은 같은 7개 명령 트리를 사용한다", () => {
  assert.deepEqual(DISCORD_COMMANDS.map(c => c.name), ["help", "account", "app", "issue", "release", "note", "chat"]);
  for (const definition of COMMAND_DEFINITIONS) {
    assert.ok(commandHelpText().includes(`/${definition.path.join(" ")}`));
    assert.ok(definition.capability);
  }
  const result = resolveDiscordCommand({ name: "release", options: [{ type: 1, name: "deploy", options: [{ type: 3, name: "app", value: "app" }, { type: 3, name: "tag", value: "v1.2.3" }, { type: 3, name: "target", value: "PLAY" }] }] });
  assert.equal(result?.definition.operation, "deploy");
  assert.equal(result?.definition.capability, "release");
  assert.equal(result?.options[0].value, "app");
  assert.equal(resolveDiscordCommand({ name: "unknown" }), null);
  assert.equal(resolveDiscordCommand({ name: "deploy" }), null);
  assert.equal(resolveDiscordCommand({ name: "issue" }), null);
  assert.equal(resolveDiscordCommand({ name: "issue", options: [{ type: 1, name: "create", options: [] }] }), null);
});

test("중첩 자동완성은 선택한 하위 명령의 앱 입력만 해석한다", () => {
  const result = resolveDiscordCommand({ name: "issue", options: [{ type: 1, name: "create", options: [{ type: 3, name: "app", focused: true, value: "ha" }] }] }, true);
  assert.equal(result?.definition.operation, "general_generate");
  assert.equal(result?.options.find(o => o.focused)?.value, "ha");
  assert.equal(resolveDiscordCommand({ name: "app", options: [{ type: 1, name: "unknown" }] }, true), null);
});
