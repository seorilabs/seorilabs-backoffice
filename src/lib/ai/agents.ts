import type { AppType, AppEngine, Lifecycle, AiDraftKind } from "@prisma/client";

// 단계별 Stage Agent — 각 에이전트는 컨텍스트로부터 MiniMax 프롬프트(system+user)를 만든다.
// 산출물은 한국어 마크다운. LLM 은 GitHub 에 직접 쓰지 않는다(초안만 생성).
// 커밋 동작은 commitDraft(actions/ai.ts) 가 kind 별로 결정한다.

export interface AgentMeta {
  kind: AiDraftKind;
  stage: Lifecycle;
  ko: string; // UI 표기
  // 커밋 대상: NEW_ISSUE = 새 이슈, ISSUE_COMMENT = 대상 이슈에 코멘트.
  commitTarget: "NEW_ISSUE" | "ISSUE_COMMENT";
  commitLabels?: string[];
}

export const AGENTS: Record<AiDraftKind, AgentMeta> = {
  PLANNING_SPEC: {
    kind: "PLANNING_SPEC",
    stage: "PLANNING",
    ko: "기획 에이전트",
    commitTarget: "NEW_ISSUE",
  },
  TASK_BREAKDOWN: {
    kind: "TASK_BREAKDOWN",
    stage: "DEVELOPMENT",
    ko: "분해 에이전트",
    commitTarget: "ISSUE_COMMENT",
  },
  RELEASE_NOTES: {
    kind: "RELEASE_NOTES",
    stage: "RELEASE",
    ko: "릴리스노트 에이전트",
    commitTarget: "NEW_ISSUE",
    commitLabels: ["release-notes"],
  },
};

function appDescriptor(type: AppType, engine: AppEngine, markets: string[]): string {
  const kind = type === "GAME" ? "게임" : "앱";
  const eng = engine === "GODOT" ? "Godot 엔진" : "React Native(Granite/AppsInToss)";
  const mk = markets.length ? markets.join(", ") : "미정";
  return `${kind} · ${eng} · 타겟 마켓: ${mk}`;
}

export interface PlanningContext {
  displayName: string;
  type: AppType;
  engine: AppEngine;
  marketTargets: string[];
  title: string;
  idea: string;
}

export function buildPlanningPrompt(ctx: PlanningContext): {
  system: string;
  prompt: string;
} {
  const isGame = ctx.type === "GAME";
  const docName = isGame ? "GDD(게임 기획서)" : "제품 기획서";
  const sections = isGame
    ? "개요/핵심 재미, 게임 루프, 핵심 시스템·메커닉, 진행/난이도, 콘텐츠·레벨, UX·온보딩, 수익화, 수용 기준, 마켓별 고려사항, 리스크"
    : "개요/문제정의, 목표·성공지표, 핵심 기능, 화면·플로우, 데이터·연동, UX, 수용 기준, 마켓별 고려사항, 리스크";
  return {
    system: [
      "당신은 Seorilabs 의 시니어 프로덕트/게임 기획자다.",
      "한국어 마크다운으로 실행 가능한 기획 초안을 작성한다.",
      "추측으로 사실을 단정하지 말고, 미정 항목은 '확정 필요'로 표시한다.",
      "코드를 작성하지 않는다(구현은 별도 자율 에이전트 담당). 기획·요구사항·수용기준에 집중한다.",
    ].join(" "),
    prompt: [
      `# 대상: ${ctx.displayName}`,
      `- 종류: ${appDescriptor(ctx.type, ctx.engine, ctx.marketTargets)}`,
      `- 제목: ${ctx.title}`,
      "",
      "## 기획 아이디어(입력)",
      ctx.idea.trim() || "(상세 미입력 — 제목 기준으로 합리적 초안 제시)",
      "",
      `위 아이디어를 ${docName} 초안으로 구체화하라. 다음 섹션을 포함한다:`,
      sections,
      "",
      "마지막에 '## 수용 기준'은 반드시 체크리스트(`- [ ]`)로 작성한다.",
    ].join("\n"),
  };
}

export interface DecomposeContext {
  displayName: string;
  type: AppType;
  engine: AppEngine;
  issueNumber: number;
  issueTitle: string;
  issueBody: string;
}

export function buildDecomposePrompt(ctx: DecomposeContext): {
  system: string;
  prompt: string;
} {
  return {
    system: [
      "당신은 Seorilabs 의 테크리드다.",
      "기획/기능 이슈를 구현 가능한 작업 단위로 분해한다.",
      "한국어 마크다운으로 답하고, 작업은 체크박스 목록으로 만든다.",
      "각 작업은 1일 이내로 끝낼 수 있는 크기로 쪼갠다.",
    ].join(" "),
    prompt: [
      `# 대상 이슈 #${ctx.issueNumber} — ${ctx.issueTitle}`,
      `- 프로젝트: ${ctx.displayName} (${ctx.type === "GAME" ? "게임" : "앱"}, ${ctx.engine})`,
      "",
      "## 이슈 본문",
      ctx.issueBody.trim() || "(본문 없음)",
      "",
      "위 이슈를 다음 형식으로 분해하라:",
      "1. `## 작업 분해` — 구현 작업 체크리스트(`- [ ]`), 의존순서 고려.",
      "2. `## 수용 기준` — 완료 판정 가능한 체크리스트(`- [ ]`).",
      "3. `## 리스크/검증 포인트` — 짧게.",
      "",
      "코드는 쓰지 말고 작업 정의에 집중한다.",
    ].join("\n"),
  };
}

export interface ReleaseNotesContext {
  displayName: string;
  type: AppType;
  marketTargets: string[];
  version: string;
  mergedPrs: Array<{ number: number; title: string }>;
}

export function buildReleaseNotesPrompt(ctx: ReleaseNotesContext): {
  system: string;
  prompt: string;
} {
  const prLines = ctx.mergedPrs.length
    ? ctx.mergedPrs.map((p) => `- #${p.number} ${p.title}`).join("\n")
    : "(머지된 PR 없음 — 입력된 정보 기준으로만 작성)";
  return {
    system: [
      "당신은 Seorilabs 의 릴리스 매니저다.",
      "머지된 PR 목록을 바탕으로 사용자 친화적 릴리스 노트와 내부 changelog 를 한국어로 작성한다.",
      "마케팅 과장 없이, 사용자가 체감하는 변화 위주로 간결하게.",
    ].join(" "),
    prompt: [
      `# 릴리스: ${ctx.displayName} ${ctx.version}`,
      `- 타겟 마켓: ${ctx.marketTargets.join(", ") || "미정"}`,
      "",
      "## 머지된 PR",
      prLines,
      "",
      "다음을 작성하라:",
      "1. `## 사용자용 릴리스 노트` — 사용자 입장의 변경점(불릿, 3~7개).",
      "2. `## 스토어 What's New` — 마켓 제출용 짧은 카피(2~4줄, 200자 이내).",
      "3. `## 내부 Changelog` — PR 기준 기술 변경 요약.",
    ].join("\n"),
  };
}
