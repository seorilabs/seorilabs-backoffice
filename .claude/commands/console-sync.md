---
description: AppsInToss 콘솔 지표를 현재 런북 계약에 따라 증분 동기화
---

`console-sync` 스킬과 이 저장소의 `scripts/console-metrics/runbook.md`,
`src/lib/analytics/ait-apps.ts`, `src/lib/analytics/console-source.ts`를 먼저 읽고 따른다.
앱 목록·예시 페이로드·인증 규칙을 이 명령에 복제하지 않는다.

기본은 대화형 조회·push다. 인증 확인은 `workspace_overview`로 현재 workspace 접근을 확인한다.
만료 시 중단하고 현재 MCP 설정에서 재인증한다. 결측 지표만 건너뛰고 확인된 값은 저장하며, 미확인 값은 null로 구분하고
기존 값은 보존한다. 명시적으로 확인하지 않은 0을 생성하지 않는다.

조회 전용 파드는 런북의 실제 OAuth 갱신·회전·재시작 및 별도 운영 배포·스케줄 승인 gate를
통과한 경우에만 실행한다. 다른 프로그램의 인증 캐시를 추출하거나 만료를 우회하지 않는다.
결과는 업서트·skip/error/warning과 리스팅별 readback을 구분해 보고한다.
