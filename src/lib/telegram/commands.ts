// "/" 명령어 메뉴(setMyCommands)용 정의. instrumentation(부팅 훅)·admin 라우트에서
// 등록에 쓴다. handlers.ts(prisma·vault 등 node 전용 그래프)와 분리해, Edge 로 함께
// 컴파일되는 instrumentation 번들이 무거운 서버 모듈을 끌어오지 않도록 한다.
export const BOT_COMMANDS = [
  { command: "plan", description: "기획 초안 → 이슈 생성" },
  { command: "bug", description: "버그 리포트 → 이슈 생성" },
  { command: "approvals", description: "승인 대기" },
  { command: "p1", description: "열린 P1 이슈" },
  { command: "status", description: "앱 현황" },
  { command: "metrics", description: "앱 지표(DAU·잔존·광고)" },
  { command: "release", description: "릴리즈 태그 생성 + 출시노트" },
  { command: "deploy", description: "마켓 배포(태그 선택)" },
  { command: "save", description: "메모를 볼트 받은함에 저장" },
  { command: "index", description: "볼트 즉시 재인덱싱" },
  { command: "reset", description: "대화 맥락 초기화" },
  { command: "help", description: "도움말 · 빠른 버튼" },
];
