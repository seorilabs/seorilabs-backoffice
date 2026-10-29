import type { OperatorInteraction, OperatorOption } from "./types";

export type CommandCapability = "read" | "planning" | "bug" | "issue_write" | "release" | "vault_write" | "vault_index";
type CommandOption = { type: number; name: string; description: string; required?: boolean; autocomplete?: boolean; choices?: { name: string; value: string }[] };
interface CommandDefinition {
  path: readonly string[];
  operation: string;
  description: string;
  capability: CommandCapability;
  deferred: boolean;
  options: CommandOption[];
}
const app: CommandOption = { type: 3, name: "app", description: "대상 앱 선택", required: true, autocomplete: true };
const optionalApp = { ...app, required: false };
const target: CommandOption = { type: 3, name: "target", description: "배포 대상", required: true, choices: [{ name: "앱인토스", value: "AIT" }, { name: "Google Play", value: "PLAY" }, { name: "App Store", value: "APPSTORE" }, { name: "전체 마켓", value: "ALL" }] };
function command(path: string, operation: string, description: string, capability: CommandCapability = "read", options: CommandOption[] = [], deferred = false): CommandDefinition {
  return { path: path.split(" "), operation, description, capability, options, deferred };
}

export const COMMAND_DEFINITIONS: readonly CommandDefinition[] = [
  command("help", "help", "명령·채널 안내와 사용 예시"),
  command("account connect", "connect", "Backoffice GitHub 계정 연결", "read", [{ type: 3, name: "code", description: "10분짜리 일회용 연결 코드", required: true }]),
  command("app status", "status", "앱 현황", "read", [optionalApp], true),
  command("app metrics", "metrics", "앱 지표", "read", [optionalApp], true),
  command("app report", "report", "근거와 수집 상태를 포함한 종합 보고서", "read", [{ type: 3, name: "date", description: "기준일 YYYY-MM-DD", required: false }], true),
  ...[{ name: "reviews", description: "최근 앱 리뷰 평점" }, { name: "keywords", description: "검색어 노출 관측" }, { name: "health", description: "수집 상태와 확인할 항목" }, { name: "insights", description: "최근 근거 기반 인사이트" }].map(c => command(`app ${c.name}`, c.name, c.description, "read", [optionalApp], true)),
  command("issue create", "general_generate", "일반 요청을 검토 후 이슈로 등록", "issue_write", [app]),
  command("issue plan", "plan", "기획 초안 만들기", "planning", [app]),
  command("issue bug", "bug", "버그 리포트 만들기", "bug", [app]),
  command("issue approvals", "approvals", "승인 대기 항목", "read", [], true),
  command("issue urgent", "p1", "열린 긴급 이슈", "read", [], true),
  command("release create", "release", "릴리스 태그와 출시노트 생성", "release", [app, { type: 3, name: "bump", description: "버전 증가 범위", required: true, choices: [{ name: "수정 버전", value: "patch" }, { name: "기능 버전", value: "minor" }, { name: "주 버전", value: "major" }] }]),
  command("release deploy", "deploy", "릴리스 태그를 마켓에 배포", "release", [app, { type: 3, name: "tag", description: "v1.2.3 형식", required: true }, target]),
  command("release snapshot", "snapshot", "main snapshot을 내부 테스트 채널에 빌드·배포", "release", [app, target]),
  command("note save", "save", "Obsidian 받은함에 메모 저장", "vault_write"),
  command("note index", "index", "Obsidian 볼트 즉시 재인덱싱", "vault_index"),
  command("chat ask", "ask", "백오피스 AI에게 질문"),
  command("chat reset", "reset", "내 Slack 대화 문맥 초기화"),
];

export function resolveOperatorCommand(data: OperatorInteraction["data"], autocomplete = false) {
  if (!data?.name) return null;
  let options = data.options ?? [];
  let path = data.name;
  if (options.some(o => o.type === 1 || o.type === 2)) {
    if (options.length !== 1 || options[0].type !== 1) return null;
    path += ` ${options[0].name}`;
    options = options[0].options ?? [];
  }
  const definition = COMMAND_DEFINITIONS.find(c => c.path.join(" ") === path);
  if (!definition || new Set(options.map(o => o.name)).size !== options.length) return null;
  for (const option of options) {
    const spec = definition.options.find(s => s.name === option.name);
    if (!spec || spec.type !== option.type || typeof option.value !== "string" || option.options) return null;
    if (spec.choices && !spec.choices.some(c => c.value === option.value)) return null;
    if (option.focused && (!autocomplete || !spec.autocomplete)) return null;
  }
  if (!autocomplete && definition.options.some(s => s.required && !options.some(o => o.name === s.name && o.value))) return null;
  if (autocomplete && options.filter(o => o.focused).length !== 1) return null;
  return { definition, options: options as OperatorOption[] };
}

export function commandHelpText() {
  return ["**Seorilabs 운영 안내**", "명령 시작: **운영명령** 채널. 운영 카드 버튼은 카드가 있는 채널에서 사용합니다.", ...COMMAND_DEFINITIONS.map(c => `\`/seori ${c.path.join(" ")}${c.options.map(o => ` ${o.required ? o.name : `[${o.name}]`}`).join("")}\` — ${c.description}`), "예: `/seori issue create app:happy-farm`, `/seori app status app:happy-farm`", "장애알림: 장애, 운영보고: 보고서, 수집결과: 수집과 시장 정보", "개발이슈: 이슈 · 출시관리: 출시·배포 · 결제알림: 결제 · 사용자리뷰: 스토어 리뷰", "쓰기 작업에는 업무 역할이 필요합니다. 일반 이슈는 연결된 GitHub 계정의 앱 쓰기 권한도 확인합니다.", "https://backoffice.vzyx.xyz"].join("\n");
}

/** 기존 operation도 등록 명세의 같은 경로를 사용한다. */
export function canonicalCommandPath(operation: string): string {
  const definition = COMMAND_DEFINITIONS.find(c => c.operation === operation);
  if (!definition) throw new Error("지원하지 않는 명령입니다.");
  return `/seori ${definition.path.join(" ")}`;
}
