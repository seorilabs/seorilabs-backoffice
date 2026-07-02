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
  QA_CHECKLIST: {
    kind: "QA_CHECKLIST",
    stage: "QA",
    ko: "QA 에이전트",
    commitTarget: "ISSUE_COMMENT",
  },
  STORE_COPY: {
    kind: "STORE_COPY",
    stage: "MARKET_SUBMISSION",
    ko: "스토어 에이전트",
    commitTarget: "NEW_ISSUE",
    commitLabels: ["store-copy"],
  },
  IMPROVEMENT_HYPOTHESIS: {
    kind: "IMPROVEMENT_HYPOTHESIS",
    stage: "LIVEOPS",
    ko: "개선 에이전트",
    commitTarget: "NEW_ISSUE",
    commitLabels: ["improvement"],
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
  codebaseContext?: string; // 실제 레포 README + 파일 트리 요약(있으면 정합)
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
  const systemParts = [
    "당신은 Seorilabs 의 시니어 프로덕트/게임 기획자다.",
    "한국어 마크다운으로 실행 가능한 기획 초안을 작성한다.",
    "추측으로 사실을 단정하지 말고, 미정 항목은 '확정 필요'로 표시한다.",
    "코드를 작성하지 않는다(구현은 별도 자율 에이전트 담당). 기획·요구사항·수용기준에 집중한다.",
  ];
  if (ctx.codebaseContext) {
    systemParts.push(
      "\n\n## 실제 코드베이스 컨텍스트(이 레포)\n" +
        ctx.codebaseContext +
        "\n\n위 실제 코드베이스(기존 구조·스택·기능)를 반영해, 현 구조에 자연스럽게 얹히는 현실적인 기획을 작성한다. " +
        "기존 파일/모듈을 참조해 '어디에 무엇을 추가/수정'할지 구체적으로 제안한다.",
    );
  }
  return {
    system: systemParts.join(" "),
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

// ── QA 에이전트(QA): 이슈/기능 → 테스트 체크리스트 ──
export function buildQaPrompt(ctx: DecomposeContext): {
  system: string;
  prompt: string;
} {
  return {
    system: [
      "당신은 Seorilabs 의 QA 엔지니어다.",
      "기능/이슈를 검증할 테스트 케이스를 한국어 체크리스트로 작성한다.",
      "정상 경로뿐 아니라 경계값·오류·기기/마켓별 차이·회귀 위험을 포함한다.",
    ].join(" "),
    prompt: [
      `# 대상 이슈 #${ctx.issueNumber} — ${ctx.issueTitle}`,
      `- 프로젝트: ${ctx.displayName} (${ctx.type === "GAME" ? "게임" : "앱"}, ${ctx.engine})`,
      "",
      "## 이슈 본문",
      ctx.issueBody.trim() || "(본문 없음)",
      "",
      "다음 형식으로 작성하라:",
      "1. `## 기능 테스트` — 정상 경로 검증 체크리스트(`- [ ]`).",
      "2. `## 경계/오류 케이스` — 빈값·한계·네트워크 오류·중복 등(`- [ ]`).",
      "3. `## 플랫폼/마켓 확인` — Play/App Store/AppsInToss 또는 기기별 차이(`- [ ]`).",
      "4. `## 회귀 위험` — 이 변경이 깨뜨릴 수 있는 기존 기능(`- [ ]`).",
    ].join("\n"),
  };
}

export interface StoreCopyContext {
  displayName: string;
  type: AppType;
  engine: AppEngine;
  marketTargets: string[];
  recentPrs: Array<{ number: number; title: string }>;
}

// ── 스토어 에이전트(MARKET_SUBMISSION): 마켓별 등록 문안 ──
export function buildStoreCopyPrompt(ctx: StoreCopyContext): {
  system: string;
  prompt: string;
} {
  const prLines = ctx.recentPrs.length
    ? ctx.recentPrs.map((p) => `- #${p.number} ${p.title}`).join("\n")
    : "(최근 변경 정보 없음)";
  const markets = ctx.marketTargets.length ? ctx.marketTargets.join(", ") : "Play, App Store, AppsInToss";
  return {
    system: [
      "당신은 Seorilabs 의 앱 마케터다.",
      "마켓 심사를 통과할 정확하고 매력적인 스토어 등록 문안을 한국어로 작성한다.",
      "과장·허위 금지, 정책 위반 표현(최고/1위 등 근거 없는 단정) 회피. 마켓별 글자수 제약을 의식한다.",
    ].join(" "),
    prompt: [
      `# 대상: ${ctx.displayName} (${ctx.type === "GAME" ? "게임" : "앱"}, ${ctx.engine})`,
      `- 타겟 마켓: ${markets}`,
      "",
      "## 최근 변경(머지 PR)",
      prLines,
      "",
      "다음을 작성하라(마켓 공통 + 차이 표기):",
      "1. `## 앱 이름/부제` — 30자 내 제목 + 짧은 부제.",
      "2. `## 짧은 설명` — 80자 이내(Play short description 대응).",
      "3. `## 전체 설명` — 핵심 가치·주요 기능·대상 사용자(불릿 포함).",
      "4. `## What's New` — 이번 업데이트 요약(200자 이내).",
      "5. `## 키워드/태그` — 검색 최적화 키워드 10개 내외.",
    ].join("\n"),
  };
}

export interface ImprovementContext {
  displayName: string;
  type: AppType;
  marketTargets: string[];
  openIssues: Array<{ number: number; title: string }>;
  recentPrs: Array<{ number: number; title: string }>;
  recentReleases: Array<{ version: string; market: string }>;
}

// ── 개선 에이전트(LIVEOPS): 현황 → 개선 가설 ──
export function buildImprovementPrompt(ctx: ImprovementContext): {
  system: string;
  prompt: string;
} {
  const fmt = (arr: string[]) => (arr.length ? arr.join("\n") : "(없음)");
  return {
    system: [
      "당신은 Seorilabs 의 라이브옵스/그로스 담당이다.",
      "운영 중인 앱/게임의 현황을 보고 개선 가설을 한국어로 제안한다.",
      "각 가설은 '문제 추정 → 가설 → 실험/지표 → 예상 효과' 구조로, 검증 가능하게 쓴다.",
      "데이터가 없으면 단정하지 말고 '확인 필요 지표'로 표시한다. (정량 지표 연동은 추후)",
    ].join(" "),
    prompt: [
      `# 대상: ${ctx.displayName} (${ctx.type === "GAME" ? "게임" : "앱"}) · 마켓 ${ctx.marketTargets.join(", ") || "미정"}`,
      "",
      "## 열린 이슈",
      fmt(ctx.openIssues.map((i) => `- #${i.number} ${i.title}`)),
      "",
      "## 최근 머지 PR",
      fmt(ctx.recentPrs.map((p) => `- #${p.number} ${p.title}`)),
      "",
      "## 최근 릴리스",
      fmt(ctx.recentReleases.map((r) => `- ${r.version} (${r.market})`)),
      "",
      "다음을 작성하라:",
      "1. `## 개선 가설` — 3~5개. 각 가설은 `### 가설N: 제목` 아래 문제추정·가설·실험/지표·예상효과.",
      "2. `## 우선순위 추천` — 효과/노력 기준 1~2개 우선 추천.",
      "3. `## 확인 필요 지표` — 판단에 필요한데 현재 없는 데이터(GA4 등).",
    ].join("\n"),
  };
}

// ── 출시노트(i18n) — 릴리즈 태그 diff 기반 유저 공지(ko/en). JSON 출력. ──
export interface ReleaseNotesI18nContext {
  displayName: string;
  type: AppType;
  version: string;
  previousVersion: string | null;
  prs: Array<{ number: number; title: string }>;
  commitCount: number;
}

export function buildReleaseNotesI18nPrompt(ctx: ReleaseNotesI18nContext): {
  system: string;
  prompt: string;
} {
  const prLines = ctx.prs.length
    ? ctx.prs.map((p) => `- #${p.number} ${p.title}`).join("\n")
    : "(머지 PR 식별 못함 — 커밋 기준으로만 작성)";
  return {
    system: [
      "당신은 Seorilabs 의 릴리스 매니저다.",
      "변경 내역(머지 PR/커밋)을 바탕으로 '사용자에게 공지할' 출시노트를 작성한다.",
      "이 출시노트는 Google Play·App Store 등 앱 마켓에 그대로 게시된다.",
      "내부 리팩터링·빌드·CI·테스트 등 사용자가 체감 못하는 변경은 제외하고, 새 기능·개선·버그수정만 쉬운 말로 쓴다.",
      "마케팅 과장 없이 간결한 불릿(- ). 한국어(ko_KR)와 자연스러운 영어(en_US) 두 버전을 만든다.",
      // 스토어 정형 규칙(코드에서도 강제하지만 프롬프트에서 먼저 지킨다).
      "형식 규칙(반드시 준수): 각 언어는 최대 4개 불릿, 각 불릿은 한 줄이며 100자 이내, 언어당 전체 480자 이내.",
      "각 줄은 '- ' 로 시작하는 순수 텍스트만. 마크다운 헤더(#)·링크·볼드(**)·이모지·코드블록 금지.",
      '반드시 JSON 객체 하나만 출력: {"ko_KR":"- 항목1\\n- 항목2","en_US":"- item1\\n- item2"}. 머리말/코드블록 금지.',
      "사용자 체감 변경이 전혀 없으면 안정성·내부 개선 위주로 1~2줄 간단히.",
    ].join(" "),
    prompt: [
      `앱: ${ctx.displayName} (${ctx.type === "GAME" ? "게임" : "앱"})`,
      `버전: ${ctx.version}${ctx.previousVersion ? ` (이전: ${ctx.previousVersion})` : " (첫 릴리스)"}`,
      `커밋 ${ctx.commitCount}개`,
      "",
      "## 변경 내역",
      prLines,
      "",
      "위에서 사용자 체감 항목만 골라 ko_KR/en_US 출시노트를 JSON 으로 작성하라.",
      "각 언어 최대 4개 불릿, 언어당 480자 이내, 순수 텍스트 '- ' 불릿만.",
    ].join("\n"),
  };
}
