# AppsInToss 콘솔 지표 수집 (로컬 스케줄러)

AppsInToss 콘솔의 미니앱 지표(토스 표면 DAU/세션/잔존/IAA·IAP 매출 등)를 매일 백오피스 DB로
수집한다. GA4→BigQuery 수집과 **별개 소스**다(토스 표면 전용 데이터라 GA4와 겹치지 않는다).

## 왜 pod pull 이 아니라 로컬 push 인가

콘솔 MCP(`mcp.toss.im/adapters/apps-in-toss-console`)는 **사용자 OAuth 세션**으로 인증된다. 서비스
계정/mTLS 리포팅 API가 없어 backoffice pod(무인)나 클라우드 routine 이 직접 pull 할 수 없다.
그래서 **인증된 로컬 Claude 세션**이 MCP 로 조회 → 정규화 → ingest 로 push 한다.

```
[launchd 10:30 KST] → run.sh → claude -p (prompt.md)
    → MCP dashboard_dau/session/revenue_iaa/revenue_iap/retention  (앱 9개 × 최근 14일)
    → 정규화(ConsoleMetricsPush)
    → POST https://backoffice.vzyx.xyz/api/admin/analytics/console-collect  (x-admin-token)
        → ingestConsoleMetrics() → upsert app_console_metric_daily (앱×날짜, 멱등)
```

향후 토스가 서버-투-서버 리포팅 자격증명을 제공하면 `ConsoleMetricsSource`(console-source.ts) 의
HTTP pull 구현을 붙여 pod-side 수집으로 무중단 교체할 수 있다(스키마·ingest 규약 불변).

## 구성 파일

| 경로 | 역할 |
|---|---|
| `src/lib/analytics/ait-apps.ts` | slug ↔ (workspaceId, miniAppId) 정본 표 + 해석기 |
| `src/lib/analytics/console-source.ts` | push 계약 타입 + 향후 pull 포트 |
| `src/lib/core/console-metrics-collect.ts` | `ingestConsoleMetrics()` — 검증 + upsert |
| `src/app/api/admin/analytics/console-collect/route.ts` | ingest 엔드포인트(x-admin-token) |
| `scripts/seed-ait-mapping.ts` | App.aitMiniAppId/aitWorkspaceId 채우기(선택) |
| `scripts/console-metrics/prompt.md` | claude -p 수집 지시서 |
| `scripts/console-metrics/run.sh` | launchd 진입점(자격증명 로드 + claude 실행) |
| `scripts/console-metrics/*.plist` | launchd 에이전트(매일 10:30 KST) |

## 셋업

1. **자격증명** — `~/.config/seorilabs/backoffice.env` 생성:
   ```
   INTERNAL_ADMIN_TOKEN=<backoffice-secrets 의 INTERNAL_ADMIN_TOKEN>
   # BACKOFFICE_URL=https://backoffice.vzyx.xyz   # 기본값, 필요시만
   ```
   토큰은 클러스터 Secret `platform/backoffice-secrets` 의 `INTERNAL_ADMIN_TOKEN` 과 동일해야 한다.
   (출력/커밋 금지.)

2. **콘솔 MCP 인증** — `claude` 인터랙티브 세션에서 `apps-in-toss-console` MCP 가 로그인돼 있어야
   한다. OAuth 토큰이 만료되면 헤드리스 실행이 실패하므로, 실패 시 `claude` 를 한 번 대화형으로 열어
   재인증한다.

3. **수동 검증(1회)**:
   ```
   bash scripts/console-metrics/run.sh
   tail -f ~/Library/Logs/seorilabs/console-metrics.log
   ```
   로그 마지막 줄 `console-metrics: targetApps=N upserts=M ...` 확인.

4. **스케줄 등록**:
   ```
   cp scripts/console-metrics/com.seorilabs.backoffice.console-metrics.plist ~/Library/LaunchAgents/
   launchctl load ~/Library/LaunchAgents/com.seorilabs.backoffice.console-metrics.plist
   launchctl start com.seorilabs.backoffice.console-metrics   # 즉시 1회
   ```

## 한계

- **Mac 의존**: 이 맥이 켜져 있어야(로그인 세션) 실행된다. 잠자면 깨어난 직후 1회 보정 실행.
- **OAuth 만료**: 콘솔 MCP 토큰 만료 시 재인증 필요(헤드리스는 재인증 못 함).
- 이 둘이 무인성의 트레이드오프다. 토스가 서비스 자격증명을 제공하면 pod-side pull 로 이전한다.
