import test from "node:test";
import assert from "node:assert/strict";
import { OPERATOR_COMMANDS,slackAppManifest } from "./commands";
import { canonicalCommandPath,commandHelpText,resolveOperatorCommand } from "./command-definitions";
import { parseCommand } from "@/lib/slack/normalize";

test("21개 기능은 /seori 명령과 같은 정의를 사용한다",()=>{
 assert.equal(OPERATOR_COMMANDS.length,21);
 for(const command of OPERATOR_COMMANDS)assert.ok(commandHelpText().includes(canonicalCommandPath(command.operation)));
 const manifest=slackAppManifest("https://backoffice.example.com");
 assert.deepEqual(manifest.features.slash_commands.map(command=>command.command),["/seori"]);
 assert.equal(manifest.settings.interactivity.request_url,"https://backoffice.example.com/api/slack/interactions");
 assert.equal(manifest.settings.interactivity.message_menu_options_url,manifest.settings.interactivity.request_url);
});
test("릴리스 대상과 main snapshot 기능을 보존한다",()=>{
 const snapshot=OPERATOR_COMMANDS.find(command=>command.operation==="snapshot")!;
 const deploy=OPERATOR_COMMANDS.find(command=>command.operation==="deploy")!;
 assert.match(snapshot.description,/main snapshot/);
 assert.deepEqual(snapshot.options.find(option=>option.name==="target"),deploy.options.find(option=>option.name==="target"));
 assert.deepEqual(snapshot.options.find(option=>option.name==="target")?.choices?.map(choice=>choice.value),["AIT","PLAY","APPSTORE","ALL"]);
});
test("명령은 알려진 path, 중복 없는 인자와 고정 선택지만 허용한다",()=>{
 const parsed=parseCommand("/seori","release deploy app:happy-farm tag:v1.2.3 target:PLAY")!;
 assert.equal(parsed.definition.operation,"deploy");assert.equal(parsed.missing,false);
 assert.equal(resolveOperatorCommand({name:parsed.definition.path.join(" "),options:parsed.options})?.definition.capability,"release");
 assert.equal(parseCommand("/seori","release deploy app:x tag:v1.2.3 target:other"),null);
 assert.equal(parseCommand("/seori","app status app:x app:y"),null);
 assert.equal(parseCommand("/other","help"),null);
 assert.equal(resolveOperatorCommand({name:"status"}),null);
 assert.equal(parseCommand("/seori","issue create")?.missing,true);
});
