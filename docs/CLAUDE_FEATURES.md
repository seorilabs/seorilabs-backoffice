# Backoffice Claude 사용 기능

2026-10-17 MiniMax에서 Claude로 전환한 코드 기준이다. 기본 모델은 `claude-sonnet-5-5`, 키는 정확한 `CLAUDE_API_KEY_IH`다. 아래는 코드상 영향 범위이며 각 기능의 전체 사용자 흐름을 운영에서 시험했다는 뜻은 아니다.

| 기능 | 사용 위치·진입점 | Claude가 하는 일 | 코드 정본 |
| --- | --- | --- | --- |
| 운영 비서 대화 | Discord `/ask` | 대화 이력과 운영 현황을 바탕으로 답변. 필요한 조회 도구를 선택하고 결과를 정리 | `src/lib/discord/chat.ts`, `src/lib/ai/chat-agent.ts` |
| 지식 볼트 질의응답 | 대화의 지식 검색·탐색·본문 읽기, 관리자 `/api/admin/vault/ask` | Obsidian 문서를 읽어 답변. 검색 질의 임베딩은 Gemini | `src/lib/ai/tools.ts`, `src/lib/vault/retrieve.ts` |
| 기획서 초안 | 웹 `/work/plan`, Discord `/plan` | 아이디어·저장소 문맥으로 기획 초안 작성 | `src/lib/actions/ai.ts`, `src/lib/core/ai-drafts.ts` |
| 버그 보고서 초안 | Discord `/bug` | 증상을 구조화한 보고서 작성 | `src/lib/core/ai-drafts.ts` |
| 작업 분해 초안 | 앱 개발 화면·단계 초안 버튼 | 기존 이슈를 작업 단위로 분해 | `src/lib/core/ai-drafts.ts` |
| 검수 체크리스트 초안 | 앱 개발 화면·단계 초안 버튼 | 기존 이슈의 확인 항목 작성 | `src/lib/core/ai-drafts.ts` |
| 출시노트 초안 | 앱 개발 화면·출시 단계 초안 버튼 | 최근 병합 PR 기반 초안 작성 | `src/lib/core/ai-drafts.ts` |
| 스토어 등록 문안 초안 | 앱 개발 화면·마켓 제출 단계 초안 버튼 | 앱 설명과 등록 문안 작성 | `src/lib/core/ai-drafts.ts` |
| 운영 개선 가설 초안 | 앱 개발 화면·운영 단계·주간 운영 알림 버튼 | 열린 이슈·최근 PR·출시 기록으로 개선 가설 작성 | `src/lib/core/ai-drafts.ts`, `src/lib/notifications/proactive.ts` |
| 마켓별 다국어 출시노트 | 출시 태그 처리·출시 화면·관리자 생성 API | 이전 출시 이후 변경을 Play/App Store/AppsInToss별 8개 언어로 작성 | `src/lib/core/release-notes.ts`, `src/lib/core/release-ops.ts` |
| 근거 기반 운영 분석 | 운영 분석 작업기, 피드백·인사이트 화면, Discord `/insights`에서 결과 조회 | 운영·리뷰·지표·검색어 신호에 대해 근거·해석·제안 생성 | `src/lib/insights/generate.ts`, `src/lib/insights/service.ts` |
| 지표 보고서 해설 | 일일 조직 보고서·지표 하이라이트·수치 정정 재발행 | 수집된 수치를 설명하는 문장 생성. 실제 수치 집계는 기존 코드 | `src/lib/core/metric-narrative.ts`, `src/lib/core/org-report.ts`, `src/lib/core/metric-highlights.ts` |
| 일일 운영 다이제스트 해설 | 일일 다이제스트의 AI 해설 적용 조건 충족 시 | 확정 집계에 짧은 운영 해설 추가. 내부 설정 이름 일부는 기존 Gemini 명칭 유지 | `src/lib/notifications/proactive.ts` |
| 사용량·비용·모델 표시 | AI 사용량 원장, 월간 AI 비용·재무 보고, 설정 화면, 초안·분석·보고서 메타데이터 | 실제 Anthropic 모델·입출력 토큰과 비용 기록 | `src/lib/ai/claude.ts`, `src/lib/ai/usage.ts`, `src/lib/ai/pricing.ts` |

대화에서 사용할 수 있는 조회 도구는 앱 목록·상세, 이슈 검색, 승인 대기, P1, 지식 검색·탐색·읽기, 앱 지표, 콘솔 지표, 출시 목록, 장애 목록, workflow 실패, 리뷰 요약, 비용 요약이다. 도구의 조회 구현과 권한은 유지되며 Claude가 호출 선택과 설명을 담당한다.

## 실행 경계

- Claude는 초안과 설명을 생성한다. GitHub 등록은 기존 확인·등록 절차, 출시 실행은 기존 승인·권한 절차가 수행한다.
- `/save`의 볼트 문서 저장, `/index`의 문서 인덱싱, Gemini 임베딩, 지표·리뷰·검색어 수집, 수치 계산, 재무 보고서의 매출·클라우드 비용 집계, 알림 전송기는 이번 모델 교체의 직접 대상이 아니다. 재무 보고서에 합산되는 AI 사용료는 Claude 사용량·단가의 영향을 받는다.
- 기존 저장 초안·과거 분석·보고서·MiniMax 사용량 이력은 다시 생성하지 않는다. 다음 생성부터 적용한다.
- 다른 Claude 키나 다른 공급자로 자동 전환하지 않는다. 분석 형식 검증 실패 시 근거 기반 기본 요약을 사용하며 공급자·모델을 성공으로 기록하지 않는다.
- 문서 초안 7종은 웹·Discord 모두 8192토큰을 상한으로 사용한다. 기존 2048토큰으로 기획서가 잘려 실패한 현상을 수정했으며, 대화·분석의 짧은 출력 한도와 일일 호출 상한은 유지한다. 상한만큼 항상 생성하거나 과금하는 것은 아니다.
- 지표 요약의 형식 검증 후 기본 요약 전환이 실제 API 시험에서 관측되어 [#471](https://github.com/seorilabs/seorilabs-backoffice/issues/471)에 남아 있다. 기본 요약 반환과 Claude 생성 성공을 구분한다.

## 운영 적용과 확인

배포 workflow는 웹·명령 작업기 등 공통 서비스와 image 기반 수집 CronJob을 동일 digest로 갱신한다. 별도 관리되는 `backoffice-operations-insights`는 기존 replicas·일일 상한·기타 운영 설정을 보존하고 동일 digest와 Claude 연결 설정을 적용한다. 수집 전용 CronJob의 image 갱신을 Claude 사용 기능 추가로 해석하지 않는다.

새 Pod의 실행 digest·source SHA·정확한 IH 키 일치·설정과 실제 API 호출 후 Anthropic 사용량 기록을 확인한다. Discord 메시지 전송·GitHub 이슈 생성·마켓 제출은 연결 시험에 포함하지 않는다. 운영 분석의 자연 발생 작업과 정기 보고서 전송 완료는 연결·배포 검증과 구분한다.
