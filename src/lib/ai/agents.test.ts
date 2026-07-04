import { test } from "node:test";
import assert from "node:assert/strict";
import { AGENTS, buildBugReportPrompt } from "./agents";

test("BUG_REPORT 는 새 이슈 + bug 라벨로 커밋된다", () => {
  const meta = AGENTS.BUG_REPORT;
  assert.equal(meta.kind, "BUG_REPORT");
  assert.equal(meta.commitTarget, "NEW_ISSUE");
  assert.deepEqual(meta.commitLabels, ["bug"]);
});

test("buildBugReportPrompt 는 증상과 버그 리포트 섹션을 프롬프트에 담는다", () => {
  const { system, prompt } = buildBugReportPrompt({
    displayName: "해피팜",
    type: "GAME",
    engine: "GODOT",
    marketTargets: ["PLAY"],
    title: "튜토리얼 진입 시 크래시",
    symptom: "튜토리얼 첫 화면에서 앱이 꺼진다",
  });
  assert.match(system, /버그 트리아지/);
  assert.match(prompt, /튜토리얼 첫 화면에서 앱이 꺼진다/);
  assert.match(prompt, /## 재현 절차/);
  assert.match(prompt, /## 심각도 추정/);
});

test("코드베이스 컨텍스트가 있으면 원인 추정 지점 지시가 system 에 포함된다", () => {
  const { system } = buildBugReportPrompt({
    displayName: "해피팜",
    type: "GAME",
    engine: "GODOT",
    marketTargets: [],
    title: "t",
    symptom: "s",
    codebaseContext: "README: ...",
  });
  assert.match(system, /원인 추정 지점/);
});
