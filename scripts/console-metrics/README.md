# AppsInToss 콘솔 지표 수집 (온디맨드)

AppsInToss 콘솔의 미니앱 지표(토스 표면 DAU/신규/세션/IAA·IAP 매출·유입경로·데모그래픽 등)를
백오피스 DB(`app_console_metric_daily`)로 수집한다. GA4→BigQuery 수집과 **별개 소스**다(토스 표면
전용 데이터라 GA4와 겹치지 않는다).

## 왜 무인 자동화가 아닌가 (검증된 제약)

콘솔 MCP(`mcp.toss.im/adapters/apps-in-toss-console`)는 **사용자 OAuth 로만 인증**되고, 그 인증은
**대화형 세션 안에서만 유효하며 토큰이 짧게 만료**된다. 실측으로 확인:

- **cloud routine**: 로컬 CLI MCP 를 상속하지 않음 → 불가.
- **로컬 headless `claude -p`**: 새 프로세스는 `claude mcp list` 기준 `! Needs authentication` → 불가.
- **대화형 세션**: 동작하나 토큰 만료 시 `/mcp` 재인증 필요.

서비스 계정/mTLS 리포팅 API 가 없어 backoffice pod 나 cron 이 직접 pull 할 수 없다. 따라서 v1 수집은
**대화형 Claude 세션이 MCP 로 조회 → 정규화 → ingest 로 push** 하는 온디맨드 방식이다.

```
[대화형 Claude 세션] --MCP dashboard_*--> 정규화(ConsoleMetricsPush)
   --POST(x-admin-token)--> /api/admin/analytics/console-collect
   --> ingestConsoleMetrics() --upsert--> app_console_metric_daily (앱×날짜, 멱등)
```

## 파일

| 경로 | 역할 |
|---|---|
| `src/lib/analytics/ait-apps.ts` | slug ↔ (workspaceId, miniAppId) 정본 표 + 해석기 |
| `src/lib/analytics/console-source.ts` | push 계약 타입 + 향후 pull 포트(ConsoleMetricsSource) |
| `src/lib/core/console-metrics-collect.ts` | `ingestConsoleMetrics()` — 검증 + 멱등 upsert |
| `src/app/api/admin/analytics/console-collect/route.ts` | ingest 엔드포인트(x-admin-token) |
| `scripts/console-metrics/runbook.md` | 온디맨드 수집 절차(대화형 Claude 가 따른다) |
| `scripts/console-metrics/push.sh` | payload JSON → ingest POST 헬퍼(토큰 취급 분리) |
| `scripts/seed-ait-mapping.ts` | App.aitMiniAppId/aitWorkspaceId 채우기(선택 — ingest 는 slug 로도 동작) |

## 수집 방법

대화형 Claude 세션에서 `runbook.md` 절차를 따른다(요청: "콘솔 지표 수집해줘"). 토큰이 만료됐으면
`/mcp` 로 `apps-in-toss-console` 재인증 후 진행. push 는 `push.sh` 가 `~/.config/seorilabs/backoffice.env`
의 `INTERNAL_ADMIN_TOKEN` 으로 처리한다.

## 진짜 무인화 (향후)

토스가 서버-투-서버 리포팅 자격증명을 제공하면 `ConsoleMetricsSource` 의 HTTP pull 구현을 붙여
backoffice pod 가 직접 수집하도록 무중단 교체한다 — 스키마·ingest 규약 불변. 그때까지는 온디맨드.
