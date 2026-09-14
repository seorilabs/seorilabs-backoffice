import { test } from "node:test";
import assert from "node:assert/strict";
import { AGENTS, buildBugReportPrompt, buildReleaseNotesI18nPrompt } from "./agents";

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

test("출시노트 프롬프트는 8개 언어 키를 모두 요구한다", () => {
  const { system, prompt } = buildReleaseNotesI18nPrompt({
    displayName: "해피팜",
    type: "GAME",
    version: "v1.2.3",
    byMarket: {
      googlePlay: {
        previousVersion: "v1.2.2",
        prs: [{ number: 12, title: "언어 지원 확대" }],
        commitCount: 3,
      },
      appStore: {
        previousVersion: "v1.2.1",
        prs: [{ number: 11, title: "힌트 화면 수정" }],
        commitCount: 4,
      },
      ait: {
        previousVersion: null,
        prs: [{ number: 10, title: "AIT 첫 출시" }],
        commitCount: 8,
      },
    },
  });

  for (const key of ["ko_KR", "en_US", "ja_JP", "zh_CN", "zh_TW", "de_DE", "fr_FR", "es_ES"]) {
    assert.match(system + prompt, new RegExp(key));
  }
  assert.match(system, /8개 언어/);
  assert.match(prompt, /googlePlay — v1\.2\.2 이후/);
  assert.match(prompt, /appStore — v1\.2\.1 이후/);
  assert.match(prompt, /ait — 첫 릴리즈/);
  assert.match(system, /다른 마켓 이름이나 다른 마켓 전용 변경을 절대 언급하지 않는다/);
  assert.match(system, /AdMob과 리워드 광고.*한 마켓 전용으로 추정하지 않는다/);
});
