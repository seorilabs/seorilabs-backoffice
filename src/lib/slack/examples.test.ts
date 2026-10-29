import test from "node:test";
import assert from "node:assert/strict";
import {slackExamples,slackDestinationExamples,slackCommandExamples} from "./examples";
import {CHANNEL_DESTINATIONS} from "@/lib/notifications/destinations";
import {COMMAND_DEFINITIONS} from "@/lib/operator/command-definitions";
import {renderSlackMessages} from "./message";
test("13개 목적지와 21개 명령 예제가 빠짐없이 유지된다",()=>{
 assert.deepEqual(slackDestinationExamples.map(e=>e.destination).sort(),[...CHANNEL_DESTINATIONS].sort());
 assert.deepEqual(slackCommandExamples.map(e=>e.id.slice(8)).sort(),COMMAND_DEFINITIONS.map(c=>c.path.join(" ")).sort());
 for(const example of slackExamples){const pages=renderSlackMessages(example.text,example.options);assert.ok(pages[0].text,example.id);for(const p of pages)assert.ok(p.blocks.length<=50);}
});
