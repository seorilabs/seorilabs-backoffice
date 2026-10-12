# 파드 콘솔 수집 검수

설계 ID: `2026-10-12-console-sync-pod`. [승인·실행 티켓](../../design/2026-10-12-console-sync-pod/execution.md).

## 환경·실행 계획

등록된 콘솔 OAuth 자격증명이 없어 실제 공급자 갱신은 차단이다. 로컬 HTTP MCP 시험 서버는 공식 SDK와 합성 응답만 사용한다. MySQL 9.2 격리 DB는 `127.0.0.1:33319/backoffice_console_qa`이며 운영 키·데이터를 사용하지 않는다.

테스트 순서: 실패 조건 확인 → 매핑·ingest 수정 → OAuth·HTTP MCP 경계 → 격리 DB 수집·보존·잠금·readback → 타입·린트·전체 회귀 → 중앙 개발 근거 검증 → PR CI·교차 리뷰.

## 진행 결과

- ingest 원본에서 불완전한 행·다른 리스팅 ID가 저장되어 회귀 assertion 2개 실패(예상 결과).
- mapper 미구현 상태에서 정상 행·누락 사유 assertion 2개 실패(예상 결과).
- 수정 후 매핑·저장 보호 및 기존 검사 9개 통과.
- OAuth 격리 검사 5개, 날짜·분할 2개 통과.
- 실제 loopback HTTP MCP 검사 2개 통과: refresh·429·동시 조회 최대 2·쓰기 도구 차단·IOS 누락·재시도 소진.
- 격리 DB·전체 회귀·중앙 검증·PR CI·교차 리뷰: 진행 중.

## 남은 gate

- AC-1 실제 최초 인가·토큰 만료 후 refresh·파드 재시작: 차단, 자격증명 없음.
- AC-2 실제 revoke 및 AC-6 실제 공급자/운영 DB readback: 미실행.
- 이번 후보의 Backoffice 전체 기능 42개 E2E 증거: 미실행. 과거 후보를 재사용하거나 서비스 fixture를 전체 제품 검수로 표시하지 않는다.
- 운영 배포·Secret 적용·CronJob 활성화: 미승인, 미실행. manifest는 suspend=true이고 기존 배포 적용 목록 밖이다.
